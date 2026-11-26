/**
 * Fast tiny-voca phonemizer.
 *
 * The original path runs dizione inside Pyodide + NumPy, which is accurate but
 * costs roughly 27 MB of runtime and a Python startup on every page load. This
 * path uses dizione's own 125k-word IPA lexicon first and eSpeak-ng only for
 * words the lexicon does not contain. It produces the same token ids and stress
 * layout expected by the tiny-voca ONNX graph.
 */

export interface Phonemes {
  ids: number[];
  stress: number[];
  text: string;
}

export interface FastPhonemizerConfig {
  vocab: Record<string, number>;
}

const SPECIAL_TOKENS = new Set(['<pad>', '<bos>', '<eos>', '<sp>', '<unk>']);
const PUNCTUATION = new Set([
  ',',
  '.',
  '?',
  '!',
  ';',
  ':',
  '"',
  "'",
  '(',
  ')',
  '—',
  '…',
]);
const VOWELS = new Set([
  'ə',
  'ɐ',
  'ɚ',
  'ᵻ',
  'ɪ',
  'i',
  'iː',
  'ɛ',
  'æ',
  'ʌ',
  'ɑː',
  'ɔ',
  'ɔː',
  'ʊ',
  'uː',
  'ɜː',
  'eɪ',
  'aɪ',
  'ɔɪ',
  'oʊ',
  'aʊ',
  'iə',
  'oː',
  'ɑːɹ',
  'ɔːɹ',
  'oːɹ',
  'ɪɹ',
  'ɛɹ',
  'ʊɹ',
  'aɪɚ',
  'aɪə',
  'əl',
  'n̩',
]);
const FUNCTION_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'can',
  'could',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'hers',
  'him',
  'his',
  'i',
  'if',
  'in',
  'is',
  'it',
  'its',
  'may',
  'me',
  'might',
  'must',
  'my',
  'no',
  'not',
  'of',
  'on',
  'or',
  'our',
  'she',
  'should',
  'so',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'to',
  'us',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
]);
const WORD_TOKEN =
  /\$?\d[\d.,:/+-]*%?|[A-Za-z]+(?:[-'’][A-Za-z]+)*|[^\s]/gu;
const NORMALIZE_PUNCT: Record<string, string> = {
  '“': '"',
  '”': '"',
  '‘': "'",
  '’': "'",
  '–': '—',
};

interface Inventory {
  phones: string[];
  phoneSet: Set<string>;
  sorted: string[];
}

let inventoryCache: { vocab: Record<string, number>; value: Inventory } | null = null;
let lexiconPromise: Promise<Map<string, string>> | null = null;
let espeakPromise: Promise<{
  phonemize: (text: string, language?: string) => Promise<string[]>;
}> | null = null;

function inventory(vocab: Record<string, number>): Inventory {
  if (inventoryCache?.vocab === vocab) return inventoryCache.value;

  const phones = Object.keys(vocab).filter(
    (symbol) => !SPECIAL_TOKENS.has(symbol) && !PUNCTUATION.has(symbol),
  );
  const value: Inventory = {
    phones,
    phoneSet: new Set(phones),
    sorted: [...phones].sort((a, b) => b.length - a.length),
  };
  inventoryCache = { vocab, value };
  return value;
}

async function loadLexicon(): Promise<Map<string, string>> {
  if (!lexiconPromise) {
    lexiconPromise = fetch(
      new URL('tiny-voca/phonemizer/lexicon.tsv', document.baseURI),
    )
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Could not load the English lexicon (HTTP ${response.status}).`);
        }
        return response.text();
      })
      .then((text) => {
        const map = new Map<string, string>();
        for (const line of text.split('\n')) {
          const tab = line.indexOf('\t');
          if (tab > 0) map.set(line.slice(0, tab), line.slice(tab + 1));
        }
        return map;
      })
      .catch((error) => {
        lexiconPromise = null;
        throw error;
      });
  }
  return lexiconPromise;
}

async function getEspeak(): Promise<{
  phonemize: (text: string, language?: string) => Promise<string[]>;
}> {
  if (!espeakPromise) {
    espeakPromise = import('phonemizer')
      .then(
        (module) =>
          module as unknown as {
            phonemize: (text: string, language?: string) => Promise<string[]>;
          },
      )
      .catch((error) => {
        espeakPromise = null;
        throw error;
      });
  }
  return espeakPromise;
}

function tokenizeIpa(
  ipa: string,
  inventoryValue: Inventory,
  promote = true,
): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  let stress = 0;

  for (let index = 0; index < ipa.length; ) {
    const char = ipa[index];
    if (char === 'ˈ') {
      stress = 1;
      index += 1;
      continue;
    }
    if (char === 'ˌ') {
      stress = 2;
      index += 1;
      continue;
    }
    if (/\s/u.test(char) || char === '/' || char === '|' || char === '_') {
      index += 1;
      continue;
    }

    let match: string | null = null;
    for (const phone of inventoryValue.sorted) {
      if (ipa.startsWith(phone, index)) {
        match = phone;
        break;
      }
    }

    if (!match) {
      index += 1;
      stress = 0;
      continue;
    }

    out.push([match, VOWELS.has(match) ? stress : 0]);
    stress = 0;
    index += match.length;
  }

  if (promote && out.length > 0 && !out.some(([, level]) => level > 0)) {
    const firstVowel = out.findIndex(([phone]) => VOWELS.has(phone));
    if (firstVowel >= 0) out[firstVowel][1] = 1;
  }

  return out;
}

async function wordIpa(
  word: string,
  lexicon: Map<string, string>,
): Promise<string | null> {
  const key = word.toLowerCase().replace(/’/gu, "'");
  const known = lexicon.get(key);
  if (known) return known;

  const espeak = await getEspeak();
  const lines = await espeak.phonemize(word, 'en-us');
  const ipa = lines.join(' ').trim();
  return ipa || null;
}

export async function prepareFastPhonemizer(): Promise<void> {
  await loadLexicon();
}

export async function phonemizeFast(
  text: string,
  config: FastPhonemizerConfig,
): Promise<Phonemes | null> {
  const lexicon = await loadLexicon();
  const words = inventory(config.vocab);
  const symbols: string[] = ['<bos>'];
  const stress: number[] = [0];
  let lastWasPhone = false;

  const pushPunctuation = (symbol: string): void => {
    if (symbols[symbols.length - 1] !== symbol) {
      symbols.push(symbol);
      stress.push(0);
    }
    lastWasPhone = false;
  };

  for (const raw of text.match(WORD_TOKEN) ?? []) {
    const normalized = NORMALIZE_PUNCT[raw] ?? raw;
    if (normalized === '-' || normalized === '–') continue;
    if (PUNCTUATION.has(normalized)) {
      pushPunctuation(normalized);
      continue;
    }

    const ipa = await wordIpa(raw, lexicon);
    if (!ipa) continue;

    const functionWord = FUNCTION_WORDS.has(
      raw.toLowerCase().replace(/’/gu, "'"),
    );

    for (const chunk of ipa.split(/\s+/u).filter(Boolean)) {
      const phones = tokenizeIpa(chunk, words, !functionWord);
      if (phones.length === 0) continue;

      if (lastWasPhone) {
        symbols.push('<sp>');
        stress.push(0);
      }

      for (const [phone, level] of phones) {
        symbols.push(phone);
        stress.push(functionWord ? 0 : level);
      }
      lastWasPhone = true;
    }
  }

  if (!symbols.some((symbol) => words.phoneSet.has(symbol))) return null;

  symbols.push('<eos>');
  stress.push(0);

  return {
    ids: symbols.map((symbol) => config.vocab[symbol] ?? config.vocab['<unk>']),
    stress,
    text: symbols.join(' '),
  };
}
