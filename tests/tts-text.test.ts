import { describe, expect, test } from 'bun:test';
import { isEnglishOnlyEngine, prepareSpeechText } from '../src/tts-text';

describe('speech text preparation', () => {
  test('removes SSML and HTML tags instead of reading them aloud', () => {
    const out = prepareSpeechText('<speak>Hello <break time="1s"/> world</speak>');
    expect(out.text).toBe('Hello world');
    expect(out.strippedMarkup).toBe(true);
  });

  test('keeps comparisons that are not tags', () => {
    expect(prepareSpeechText('3 < 5 and 7 > 2').text).toBe('3 < 5 and 7 > 2');
  });

  test('measures how much of the text is outside the Latin script', () => {
    expect(prepareSpeechText('日本語のテキストです').nonLatinShare).toBe(1);
    expect(prepareSpeechText('Hello there').nonLatinShare).toBe(0);
  });

  test('flags the English-only engines', () => {
    expect(isEnglishOnlyEngine('tiny-voca')).toBe(true);
    expect(isEnglishOnlyEngine('supertonic')).toBe(false);
  });
});
