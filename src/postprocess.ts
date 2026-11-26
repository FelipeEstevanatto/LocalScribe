/**
 * Conservative dictation clean-up applied to the final transcript only.
 *
 * The ASR models already emit punctuation and casing, but browser dictation
 * users often say "comma", "full stop" or "twenty five percent" out loud. This
 * layer is opt-in because it can change otherwise-correct text.
 */

export interface PolishOptions {
  punctuation: boolean;
  numbers: boolean;
}

const SPOKEN_PUNCTUATION: Array<[RegExp, string]> = [
  [/\s*\b(?:full stop|period)\b\s*/gi, '. '],
  [/\s*\bquestion mark\b\s*/gi, '? '],
  [/\s*\bexclamation (?:mark|point)\b\s*/gi, '! '],
  [/\s*\bcomma\b\s*/gi, ', '],
  [/\s*\bsemicolon\b\s*/gi, '; '],
  [/\s*\bcolon\b\s*/gi, ': '],
  [/\s*\bnew paragraph\b\s*/gi, '\n\n'],
  [/\s*\bnew ?line\b\s*/gi, '\n'],
  [/\s*\bopen (?:parenthesis|bracket)\b\s*/gi, ' ('],
  [/\s*\bclose (?:parenthesis|bracket)\b\s*/gi, ') '],
];

const UNITS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const WORD_START = [...Object.keys(UNITS), ...Object.keys(TENS)].join('|');
const WORD_CONTINUE = [...Object.keys(UNITS), ...Object.keys(TENS), 'hundred', 'thousand', 'and', 'point'].join(
  '|',
);

const NUMBER_RUN = new RegExp(
  `\\b((?:${WORD_START})(?:[\\s-]+(?:${WORD_CONTINUE}))*)\\b(\\s+(?:percent|per cent))?`,
  'gi',
);

/** Words that make a bare "one" safe to turn into "1" ("one percent"). */
const UNITS_AFTER_NUMBER =
  /\s*(?:percent|per cent|cups?|dollars?|euros?|pounds?|meters?|metres?|kilometers?|kilometres?|kilograms?|kilos?|grams?|milligrams?|seconds?|minutes?|hours?|days?|weeks?|months?|years?|degrees?|milliliters?|millilitres?|inches?|feet|miles?)\b/i;

function parseNumberRun(raw: string): { value: string; consumed: string } | null {
  const words = raw.toLowerCase().split(/[\s-]+/).filter(Boolean);
  if (!words.length) return null;

  const pointIndex = words.indexOf('point');
  const integerWords = pointIndex >= 0 ? words.slice(0, pointIndex) : words;
  const decimalWords = pointIndex >= 0 ? words.slice(pointIndex + 1) : [];

  let total = 0;
  let current = 0;
  let sawNumber = false;
  let lastKind: 'unit' | 'tens' | 'scale' | null = null;

  for (const word of integerWords) {
    if (word in UNITS) {
      // Two standalone numbers in a row ("ten thirty") are ambiguous: it may
      // be a time. Leave the phrase alone rather than turning it into 40.
      if (lastKind === 'unit') return null;
      current += UNITS[word];
      sawNumber = true;
      lastKind = 'unit';
    } else if (word in TENS) {
      if (lastKind === 'unit' || lastKind === 'tens') return null;
      current += TENS[word];
      sawNumber = true;
      lastKind = 'tens';
    } else if (word === 'hundred') {
      current = (current || 1) * 100;
      sawNumber = true;
      lastKind = 'scale';
    } else if (word === 'thousand') {
      total += (current || 1) * 1000;
      current = 0;
      sawNumber = true;
      lastKind = 'scale';
    } else if (word === 'and') {
      continue;
    } else {
      return null;
    }
  }

  total += current;

  if (pointIndex >= 0) {
    if (!decimalWords.length) return null;
    const digits = decimalWords.map((word) => {
      if (!(word in UNITS) || UNITS[word] > 9) return null;
      return String(UNITS[word]);
    });
    if (digits.some((digit) => digit === null)) return null;
    return { value: `${total}.${digits.join('')}`, consumed: raw };
  }

  if (!sawNumber) return null;
  return { value: String(total), consumed: raw };
}

function replaceNumbers(text: string): string {
  return text.replace(
    NUMBER_RUN,
    (match, run: string, percentPart: string | undefined, offset: number, whole: string) => {
      const parsed = parseNumberRun(run);
      if (!parsed) return match;

      const after = whole.slice(offset + match.length);
      const hasPercent = Boolean(percentPart);
      const bareOne = run.trim().toLowerCase() === 'one';
      const nextIsUnit = hasPercent || UNITS_AFTER_NUMBER.test(after);

      // "One of them" must stay a pronoun. A single "one" only becomes a digit
      // when a unit follows it.
      if (bareOne && !nextIsUnit) return match;

      if (hasPercent) {
        return `${parsed.value}%`;
      }

      return parsed.value;
    },
  );
}

function tidySpacing(text: string): string {
  return text
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[\s,.;:]+/, '')
    .trim();
}

function capitalize(text: string): string {
  return text
    .replace(/(^|[.!?]\s+|\n)([a-z])/g, (_match, prefix: string, letter: string) => {
      return `${prefix}${letter.toUpperCase()}`;
    })
    .replace(/\bi\b/g, 'I');
}

export function polishTranscript(text: string, options: PolishOptions): string {
  if (!text.trim()) return text;

  let output = text;

  if (options.punctuation) {
    for (const [pattern, replacement] of SPOKEN_PUNCTUATION) {
      output = output.replace(pattern, replacement);
    }
    output = output.replace(/\.\s*\./g, '.').replace(/\?\s*\?/g, '?');
  }

  if (options.numbers) {
    output = replaceNumbers(output);
    // "twenty five percent" already became "25%"; tidy the remaining forms.
    output = output.replace(/(\d)\s+percent\b/gi, '$1%');
  }

  output = capitalize(tidySpacing(output));
  return output;
}
