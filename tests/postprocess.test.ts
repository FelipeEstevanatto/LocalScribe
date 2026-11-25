import { describe, expect, test } from 'bun:test';
import { polishTranscript } from '../src/postprocess';

const polish = (text: string) => polishTranscript(text, { punctuation: true, numbers: true });

describe('dictation clean-up', () => {
  test('dictated punctuation still works', () => {
    expect(polish('hello comma how are you question mark')).toBe('Hello, how are you?');
    expect(polish('send it today full stop thanks')).toBe('Send it today. Thanks');
  });

  test('punctuation words used as nouns are left alone', () => {
    expect(polish('The trial period ended')).toBe('The trial period ended');
    expect(polish('Use a comma here.')).toBe('Use a comma here.');
    expect(polish('Period.')).toBe('Period.');
    expect(polish('It took a period of time')).toBe('It took a period of time');
  });

  test('small lone numbers stay words, larger ones become digits', () => {
    expect(polish('two children and one dog')).toBe('Two children and one dog');
    expect(polish('five minutes')).toBe('5 minutes');
    expect(polish('twenty five percent')).toBe('25%');
    expect(polish('ten thirty')).toBe('Ten thirty');
    expect(polish('one of them')).toBe('One of them');
  });
});
