export const SAMPLE_TRANSCRIPT =
  'And so, my fellow Americans, ask not what your country can do for you. Ask what you can do for your country.';

/** Word error rate ignores casing and punctuation. It can exceed 100%. */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const words = (text: string) =>
    text.normalize('NFKC').replaceAll('’', "'").toLowerCase().match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? [];
  const expected = words(reference);
  const actual = words(hypothesis);
  if (!expected.length) throw new Error('Word error rate requires a reference transcript.');

  let previous = Array.from({ length: actual.length + 1 }, (_, index) => index);
  for (const [index, word] of expected.entries()) {
    const row = [index + 1];
    for (const [position, candidate] of actual.entries()) {
      row.push(Math.min(previous[position + 1] + 1, row[position] + 1, previous[position] + Number(word !== candidate)));
    }
    previous = row;
  }
  return previous[actual.length] / expected.length;
}
