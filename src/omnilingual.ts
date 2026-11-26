/**
 * Omnilingual ASR CTC tokenizer and greedy decoder.
 *
 * The OpenVoiceOS ONNX export takes raw 16 kHz samples and returns
 * [1, frames, 10288] logits. Token 0 is the CTC blank; the vocabulary is a
 * character-level table in tokens.txt (`symbol id` per line).
 */

export interface OmnilingualTokens {
  byId: Map<number, string>;
  vocabulary: number;
  blankId: number;
}

export function parseOmnilingualTokens(text: string): OmnilingualTokens {
  const byId = new Map<number, string>();

  for (const line of text.split('\n')) {
    if (!line) continue;
    const space = line.lastIndexOf(' ');
    if (space < 0) continue;
    const symbol = line.slice(0, space);
    const id = Number(line.slice(space + 1));
    if (!Number.isInteger(id) || id < 0) continue;
    byId.set(id, symbol);
  }

  return {
    byId,
    vocabulary: byId.size,
    blankId: 0,
  };
}

export function decodeOmnilingualLogits(
  logits: Float32Array,
  frames: number,
  vocabulary: number,
  tokens: OmnilingualTokens,
): { text: string; tokenCount: number } {
  let text = '';
  let count = 0;
  let previous = -1;

  for (let frame = 0; frame < frames; frame += 1) {
    const offset = frame * vocabulary;
    let best = 0;
    let bestScore = -Infinity;

    for (let id = 0; id < vocabulary; id += 1) {
      const score = logits[offset + id];
      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    }

    if (best !== tokens.blankId && best !== previous) {
      text += tokens.byId.get(best) ?? '';
      count += 1;
    }
    previous = best;
  }

  return {
    text: text.replace(/\s+/g, ' ').trim(),
    tokenCount: count,
  };
}
