import { expect, test } from 'bun:test';
import { getModel, resolveModelFiles } from '../src/catalog';
import { alignSpeakers, speakerTurns, wordsFromSegments } from '../src/diarization';
import { buildExport } from '../src/exports';
import { VocabularyTokenizer } from '../src/model';
import { convexHull, ctcDecode, minAreaRect, rectCorners, unclip } from '../src/ocr';
import { supertonicChunks, supertonicText } from '../src/tts-plugins';

/* Speaker diarization ------------------------------------------------------ */

/** 10 ms frames of 8 speaker probabilities; `who` gives the active speaker. */
function probabilities(seconds: number, who: (time: number) => number | null): { probs: Float32Array; frames: number } {
  const frames = Math.round(seconds * 100);
  const probs = new Float32Array(frames * 8);
  for (let f = 0; f < frames; f += 1) {
    const speaker = who(f / 100);
    if (speaker !== null) probs[f * 8 + speaker] = 0.9;
  }
  return { probs, frames };
}

test('speaker turns follow the probabilities and number speakers by first appearance', () => {
  // Channel 3 speaks first, then channel 1, then channel 3 again.
  const { probs, frames } = probabilities(6, (t) => (t < 2 ? 3 : t < 4 ? 1 : 3));
  const turns = speakerTurns(probs, frames);
  expect(turns.map((turn) => turn.speaker)).toEqual([0, 1, 0]);
  expect(turns[0].start).toBeCloseTo(0, 2);
  expect(turns[1].start).toBeCloseTo(2, 2);
  expect(turns[2].end).toBeCloseTo(6, 2);
});

test('short blips are dropped and short gaps are bridged', () => {
  const { probs, frames } = probabilities(4, (t) => {
    if (t >= 1 && t < 1.1) return 2; // 100 ms blip: too short to be a turn
    if (t >= 2 && t < 2.1) return null; // 100 ms pause inside speaker 0's turn
    return 0;
  });
  const turns = speakerTurns(probs, frames);
  expect(new Set(turns.map((turn) => turn.speaker))).toEqual(new Set([0]));
  // The pause at 2 s is bridged; the blip only splits speaker 0 around 1 s.
  expect(turns.some((turn) => turn.start < 2 && turn.end > 2.1)).toBe(true);
});

test('words are grouped into lines by the speaker talking during them', () => {
  const turns = [
    { speaker: 0, start: 0, end: 2 },
    { speaker: 1, start: 2, end: 4 },
  ];
  const words = [
    { text: 'Hello', start: 0.1, end: 0.5 },
    { text: 'there.', start: 0.6, end: 1.2 },
    { text: 'Hi,', start: 2.2, end: 2.5 },
    { text: 'friend.', start: 2.6, end: 3.1 },
  ];
  expect(alignSpeakers(words, turns)).toEqual([
    { speaker: 0, start: 0.1, end: 1.2, text: 'Hello there.' },
    { speaker: 1, start: 2.2, end: 3.1, text: 'Hi, friend.' },
  ]);
});

test('segments without word timings spread their words over the speech', () => {
  const turns = [{ speaker: 0, start: 1, end: 3 }];
  const words = wordsFromSegments([{ start: 0, end: 4, text: 'one two three four' }], turns);
  expect(words.map((word) => word.text)).toEqual(['one', 'two', 'three', 'four']);
  // Estimated words stay inside the speech, not the silence around it.
  expect(words[0].start).toBeCloseTo(1, 5);
  expect(words[3].end).toBeCloseTo(3, 5);
  // Real word timings are used as they are.
  const timed = wordsFromSegments([{ start: 0, end: 1, text: 'hi', words: [{ text: ' hi', start: 0.2, end: null }] }], turns);
  expect(timed).toEqual([{ text: 'hi', start: 0.2, end: 0.4 }]);
});

test('speaker names appear in every export format', () => {
  const input = {
    text: 'Ana: Hello there.\n\nBo: Hi.',
    segments: [
      { start: 0, end: 1.2, text: 'Hello there.', speaker: 'Ana' },
      { start: 2, end: 2.5, text: 'Hi.', speaker: 'Bo' },
    ],
    duration: 3,
    fileName: 'talk.wav',
    modelName: 'Test',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
  expect(buildExport('txt', input).body).toBe('Ana: Hello there.\n\nBo: Hi.\n');
  expect(buildExport('srt', input).body).toContain('00:00:02,000 --> 00:00:02,500\nBo: Hi.');
  expect(buildExport('vtt', input).body).toContain('<v Ana>Hello there.');
  expect(buildExport('csv', input).body.split('\r\n')[0]).toBe('start_seconds,end_seconds,speaker,text');
  expect(JSON.parse(buildExport('json', input).body).segments[1].speaker).toBe('Bo');
  expect(buildExport('md', input).body).toContain('**Ana** · 00:00:00');
});

/* TDT word timings --------------------------------------------------------- */

test('TDT word timings start at the frame of each word’s first token', () => {
  const vocab = ['▁hel 0', 'lo 1', '▁world 2', '<blk> 3'].join('\n');
  const tokenizer = new VocabularyTokenizer(vocab, { blankId: 3 });
  const words = tokenizer.wordTimings([0, 1, 2], [2, 3, 10], 0.08, 15);
  expect(words.map((word) => word.text)).toEqual(['hello', 'world']);
  expect(words[0].start).toBeCloseTo(0.16, 5);
  expect(words[0].end).toBeCloseTo(0.8, 5);
  expect(words[1].start).toBeCloseTo(0.8, 5);
  expect(words[1].end).toBeCloseTo(1.2, 5);
});

/* OCR ---------------------------------------------------------------------- */

test('the minimum-area rectangle of a rotated box recovers its size and angle', () => {
  const rect = { cx: 50, cy: 40, width: 60, height: 10, angle: Math.PI / 6 };
  const hull = convexHull([...rectCorners(rect), [50, 40]]);
  expect(hull).toHaveLength(4);
  const found = minAreaRect(hull);
  expect(found.cx).toBeCloseTo(50, 5);
  expect(found.cy).toBeCloseTo(40, 5);
  expect(found.width).toBeCloseTo(60, 5);
  expect(found.height).toBeCloseTo(10, 5);
  expect(found.angle).toBeCloseTo(Math.PI / 6, 5);
});

test('unclip grows every side by area × ratio / perimeter', () => {
  const grown = unclip({ cx: 0, cy: 0, width: 40, height: 10, angle: 0 }, 1.5);
  // 400 × 1.5 / 100 = 6 on every side.
  expect(grown.width).toBeCloseTo(52, 5);
  expect(grown.height).toBeCloseTo(22, 5);
});

test('CTC decoding collapses repeats and drops blanks', () => {
  const dictionary = ['a', 'b'];
  const classes = 4; // blank, a, b, space
  const path = [1, 1, 0, 1, 2, 2, 3, 2];
  const probs = new Float32Array(path.length * classes);
  path.forEach((c, t) => { probs[t * classes + c] = 0.9; });
  const { text, score } = ctcDecode(probs, path.length, classes, dictionary);
  expect(text).toBe('aab b');
  expect(score).toBeCloseTo(0.9, 5);
});

/* Supertonic text handling ------------------------------------------------- */

test('Supertonic text is normalised, closed with a period, and language-tagged', () => {
  expect(supertonicText('Hello — world', 'en')).toBe('<en>Hello - world.</en>');
  expect(supertonicText('Email me @ home “now”!', 'en')).toBe('<en>Email me at home "now"!</en>');
  expect(supertonicText('Olá , tudo bem ?', 'pt')).toBe('<pt>Olá, tudo bem?</pt>');
});

test('Supertonic chunks pack sentences and keep abbreviations together', () => {
  const sentence = 'This sentence has exactly fifty characters in it. ';
  const chunks = supertonicChunks(sentence.repeat(8).trim(), 'en');
  expect(chunks).toHaveLength(2);
  expect(chunks.every((chunk) => chunk.length <= 300)).toBe(true);
  expect(supertonicChunks('Dr. Smith arrived. He sat down.', 'en')).toEqual(['Dr. Smith arrived. He sat down.']);
  expect(supertonicChunks('First paragraph.\n\nSecond paragraph.', 'en')).toEqual(['First paragraph.', 'Second paragraph.']);
  // Korean and Japanese use 120-character chunks.
  expect(supertonicChunks('가나다라. '.repeat(40).trim(), 'ko').every((chunk) => chunk.length <= 120)).toBe(true);
});

/* Whistle ------------------------------------------------------------------ */

test('Whistle downloads the pinned model and the Cactus runtime', () => {
  const files = resolveModelFiles('whistle', 'cq4', false);
  expect(files.map((file) => file.role)).toEqual(['cactusModel', 'cactusScript', 'cactusWasm']);
  expect(files[0].url).toBe('https://huggingface.co/Cactus-Compute/whistle/resolve/88cb00eeb8928ddbcd410b491584f938ba030b07/whistle.cact');
  expect(files.every((file) => file.url.includes('/resolve/') && !file.url.includes('/main/'))).toBe(true);
  expect(getModel('whistle').languageOptions).toEqual(['English', 'German', 'French', 'Spanish', 'Italian', 'Dutch', 'Polish']);
});
