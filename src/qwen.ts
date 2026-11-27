/**
 * Qwen3-ASR tokenizer and prompt helpers.
 *
 * The sherpa-onnx Qwen3 exports ship a Qwen2 byte-level BPE tokenizer as
 * `vocab.json` + `merges.txt` + `tokenizer_config.json` (not tokenizer.json).
 * The decoder's assistant output starts with a language tag such as
 * `language English.`; the prompt builder below keeps the audio placeholders
 * and leaves language detection to the model.
 */

const QWEN_PATTERN =
  /'s|'t|'re|'ve|'m|'ll|'d|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/giu;

function buildByteMaps(): {
  byteToUnicode: Map<number, string>;
  unicodeToByte: Map<string, number>;
} {
  const bytes: number[] = [];
  for (let value = 33; value <= 126; value += 1) bytes.push(value);
  for (let value = 161; value <= 172; value += 1) bytes.push(value);
  for (let value = 174; value <= 255; value += 1) bytes.push(value);

  const codePoints = [...bytes];
  let extra = 0;

  for (let value = 0; value <= 255; value += 1) {
    if (bytes.includes(value)) continue;
    bytes.push(value);
    codePoints.push(256 + extra);
    extra += 1;
  }

  const byteToUnicode = new Map<number, string>();
  const unicodeToByte = new Map<string, number>();

  for (let index = 0; index < bytes.length; index += 1) {
    const symbol = String.fromCodePoint(codePoints[index]);
    byteToUnicode.set(bytes[index], symbol);
    unicodeToByte.set(symbol, bytes[index]);
  }

  return { byteToUnicode, unicodeToByte };
}

const { byteToUnicode, unicodeToByte } = buildByteMaps();

interface AddedToken {
  content: string;
  id: number;
  special: boolean;
}

export class QwenTokenizer {
  readonly tokens: string[];
  readonly audioPadId: number;
  readonly audioStartId: number;
  readonly audioEndId: number;
  readonly eosId: number;
  readonly asrTextId: number;

  private readonly vocab = new Map<string, number>();
  private readonly merges = new Map<string, number>();
  private readonly added: AddedToken[] = [];
  private readonly addedIds = new Set<number>();
  private readonly decoder = new TextDecoder();

  constructor(vocabText: string, mergesText: string, configText: string) {
    let vocabulary: Record<string, number>;

    try {
      vocabulary = JSON.parse(vocabText) as Record<string, number>;
    } catch (error) {
      throw new Error(`Invalid Qwen vocab.json: ${String(error)}`);
    }

    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(configText) as Record<string, unknown>;
    } catch {
      // The tokenizer still works without the optional config.
    }

    const addedDecoder =
      (config.added_tokens_decoder as
        | Record<string, { content?: string; special?: boolean }>
        | undefined) ?? {};

    for (const [token, id] of Object.entries(vocabulary)) {
      if (!Number.isInteger(id) || id < 0) continue;
      this.vocab.set(token, id);
    }

    const maxAdded = Object.keys(addedDecoder).reduce(
      (max, key) => Math.max(max, Number(key) || 0),
      0,
    );

    for (const [key, entry] of Object.entries(addedDecoder)) {
      const id = Number(key);
      if (!Number.isInteger(id) || id < 0 || !entry?.content) continue;
      this.vocab.set(entry.content, id);
      this.added.push({
        content: entry.content,
        id,
        special: entry.special === true,
      });
    }

    // Longest first so `<|im_start|>` wins over a shorter prefix.
    this.added.sort((left, right) => right.content.length - left.content.length);

    // Do not use Math.max(...vocab.values()): a 151k-entry vocabulary can
    // exceed the browser's argument limit and throw a RangeError.
    let maxId = maxAdded;
    for (const id of this.vocab.values()) {
      if (id > maxId) maxId = id;
    }
    this.tokens = new Array<string>(maxId + 1).fill('');

    for (const [token, id] of this.vocab) {
      if (id >= 0 && id < this.tokens.length) this.tokens[id] = token;
    }

    for (const token of this.added) {
      if (token.id >= 0 && token.id < this.tokens.length) {
        this.tokens[token.id] = token.content;
        this.addedIds.add(token.id);
      }
    }

    let mergeRank = 0;
    for (const rawLine of mergesText.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const parts = line.split(/\s+/);
      if (parts.length !== 2) continue;
      this.merges.set(`${parts[0]}\u0000${parts[1]}`, mergeRank);
      mergeRank += 1;
    }

    this.audioPadId = this.requireToken(
      String(config.audio_token ?? '<|audio_pad|>'),
      'audio placeholder',
    );
    this.audioStartId = this.requireToken(
      String(config.audio_bos_token ?? '<|audio_start|>'),
      'audio start',
    );
    this.audioEndId = this.requireToken(
      String(config.audio_eos_token ?? '<|audio_end|>'),
      'audio end',
    );
    this.eosId = this.requireToken(
      String(config.eos_token ?? '<|im_end|>'),
      'end-of-sequence',
    );
    this.asrTextId = this.requireToken('<asr_text>', 'ASR text marker');
  }

  encode(text: string): number[] {
    const ids: number[] = [];
    let position = 0;

    while (position < text.length) {
      let matched = false;

      for (const token of this.added) {
        if (text.startsWith(token.content, position)) {
          ids.push(token.id);
          position += token.content.length;
          matched = true;
          break;
        }
      }

      if (matched) continue;

      let nextSpecial = text.length;
      for (const token of this.added) {
        const found = text.indexOf(token.content, position);
        if (found !== -1 && found < nextSpecial) nextSpecial = found;
      }

      if (nextSpecial > position) {
        const chunk = text.slice(position, nextSpecial);
        const pieces = chunk.match(QWEN_PATTERN) ?? [];

        for (const piece of pieces) {
          let encoded = '';
          const bytes = new TextEncoder().encode(piece);
          for (const byte of bytes) encoded += byteToUnicode.get(byte) ?? '';

          for (const symbol of this.bpe(encoded)) {
            const id = this.vocab.get(symbol);
            if (id !== undefined) {
              ids.push(id);
            } else {
              for (const character of symbol) {
                const fallback = this.vocab.get(character);
                if (fallback !== undefined) ids.push(fallback);
              }
            }
          }
        }
      }

      position = nextSpecial;
    }

    return ids;
  }

  decode(ids: readonly number[]): string {
    const text: string[] = [];
    let buffer = '';

    const flush = () => {
      if (!buffer) return;
      text.push(this.decodeBytes(buffer));
      buffer = '';
    };

    for (const id of ids) {
      const token = this.tokens[id];
      if (!token) continue;

      if (this.addedIds.has(id)) {
        flush();
        if (token === '<|im_start|>' || token === '<|im_end|>') continue;
        if (token === '<|endoftext|>' || token === '<|audio_end|>') continue;
        if (token === '<|audio_start|>' || token === '<|audio_pad|>') continue;
        text.push(token);
      } else {
        buffer += token;
      }
    }

    flush();
    return text.join('');
  }

  private bpe(encoded: string): string[] {
    let symbols = Array.from(encoded);

    while (symbols.length > 1) {
      let bestRank = Number.POSITIVE_INFINITY;
      let bestIndex = -1;

      for (let index = 0; index < symbols.length - 1; index += 1) {
        const rank = this.merges.get(
          `${symbols[index]}\u0000${symbols[index + 1]}`,
        );
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          bestIndex = index;
        }
      }

      if (bestIndex < 0) break;

      symbols = [
        ...symbols.slice(0, bestIndex),
        symbols[bestIndex] + symbols[bestIndex + 1],
        ...symbols.slice(bestIndex + 2),
      ];
    }

    return symbols;
  }

  private decodeBytes(text: string): string {
    const bytes: number[] = [];

    for (const character of text) {
      const byte = unicodeToByte.get(character);
      if (byte !== undefined) {
        bytes.push(byte);
      } else {
        for (const value of new TextEncoder().encode(character)) {
          bytes.push(value);
        }
      }
    }

    return this.decoder.decode(Uint8Array.from(bytes));
  }

  private requireToken(token: string, role: string): number {
    const id = this.vocab.get(token);
    if (id === undefined) {
      throw new Error(`The Qwen tokenizer is missing its ${role} token.`);
    }
    return id;
  }
}

export function qwenPrompt(tokenizer: QwenTokenizer, language: string): {
  before: number[];
  after: number[];
} {
  const before = tokenizer.encode('<|im_start|>system\n<|im_end|>\n<|im_start|>user\n<|audio_start|>');
  const after = tokenizer.encode('<|audio_end|><|im_end|>\n<|im_start|>assistant\n');
  if (language) after.push(...tokenizer.encode(`language ${language}`), tokenizer.asrTextId);
  return { before, after };
}

/**
 * Rumble's auto-detect output starts with `language English.`; Qwen3-ASR
 * sometimes emits `<asr_text>` as a literal token. Strip only that leading
 * scaffold so ordinary transcripts are untouched.
 */
export function cleanQwenTranscript(text: string): string {
  let result = text.trim();
  const marker = result.indexOf('<asr_text>');
  let strippedLanguageScaffold = false;

  if (marker >= 0) {
    const prefix = result.slice(0, marker);
    const suffix = result.slice(marker + '<asr_text>'.length);
    strippedLanguageScaffold = /^\s*language\b/i.test(prefix);
    result = strippedLanguageScaffold ? suffix : result;
    result = result.replaceAll('<asr_text>', '');
  }

  // Rumble emits the language tag as plain text (`language English.`) rather
  // than an `<asr_text>` separator. Do not apply this a second time when the
  // separator already identified the scaffold, or a transcript that genuinely
  // starts with the word "language" could lose its first words.
  if (!strippedLanguageScaffold) {
    result = result.replace(/^\s*language\s+[^\s.!?]+[.!:]?\s*/i, '');
  }

  return result.trim();
}

/** kaldi-native-fbank's chunked conv-stack length for Qwen3-ASR. */
export function qwenAudioTokenLength(featureFrames: number): number {
  if (featureFrames <= 0) return 0;

  const chunkSize = 100;
  const convOut = (length: number): number => {
    let value = Math.floor((length + 1) / 2);
    value = Math.floor((value + 1) / 2);
    return Math.floor((value + 1) / 2);
  };

  const afterCnn = (length: number): number => {
    if (length <= 0) return 0;
    let value = Math.floor((length - 1) / 2) + 1;
    value = Math.floor((value - 1) / 2) + 1;
    return Math.floor((value - 1) / 2) + 1;
  };

  const full = Math.floor(featureFrames / chunkSize);
  const remainder = featureFrames % chunkSize;
  return full * convOut(chunkSize) + (remainder > 0 ? afterCnn(remainder) : 0);
}
