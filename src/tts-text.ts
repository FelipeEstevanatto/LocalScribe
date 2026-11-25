/**
 * Text preparation shared by the text-to-speech engines.
 *
 * None of the engines understand SSML or HTML, so markup is removed instead of
 * being read aloud. English-only engines also get a check for text that is
 * mostly in another script, so the user is warned instead of hearing English
 * phonemes guessed for Chinese, Japanese, Arabic and similar text.
 */

export interface PreparedSpeechText {
  text: string;
  /** True when markup tags were removed. */
  strippedMarkup: boolean;
  /** Share of letters outside the Latin script, from 0 to 1. */
  nonLatinShare: number;
}

export function prepareSpeechText(input: string): PreparedSpeechText {
  const withoutTags = input.replace(/<\/?[a-z][\w:-]*(?:\s[^<>]*)?\/?>/gi, ' ');
  const strippedMarkup = withoutTags !== input;
  const text = withoutTags.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
  const letters = text.match(/\p{L}/gu) ?? [];
  const nonLatin = letters.filter((letter) => !/\p{Script=Latin}/u.test(letter)).length;
  return { text, strippedMarkup, nonLatinShare: letters.length ? nonLatin / letters.length : 0 };
}

/** Engines that only speak English. */
export function isEnglishOnlyEngine(id: string): boolean {
  return id === 'tiny-voca' || id === 'kokoro' || id === 'woof' || id === 'phonon';
}
