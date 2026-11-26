import { expect, test } from 'bun:test';
import { createMixedFft } from '../src/mixed-fft';

function naiveDft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  for (let k = 0; k < n; k += 1) {
    for (let t = 0; t < n; t += 1) {
      const angle = (-2 * Math.PI * k * t) / n;
      const wr = Math.cos(angle);
      const wi = Math.sin(angle);
      outRe[k] += re[t] * wr - im[t] * wi;
      outIm[k] += re[t] * wi + im[t] * wr;
    }
  }
  return { re: outRe, im: outIm };
}

for (const size of [5, 6, 10, 25, 200, 400]) {
  test(`mixed-radix FFT matches a direct DFT at ${size} points`, () => {
    const inputRe = new Float64Array(size);
    const inputIm = new Float64Array(size);
    for (let index = 0; index < size; index += 1) {
      inputRe[index] = Math.sin(index * 0.37) + Math.cos(index * 0.11) * 0.4;
      inputIm[index] = Math.cos(index * 0.23) * 0.2;
    }
    const expected = naiveDft(inputRe, inputIm);
    const plan = createMixedFft(size);
    const outRe = new Float64Array(size);
    const outIm = new Float64Array(size);
    plan.forward(inputRe, inputIm, outRe, outIm);

    let maxError = 0;
    for (let index = 0; index < size; index += 1) {
      maxError = Math.max(
        maxError,
        Math.abs(outRe[index] - expected.re[index]),
        Math.abs(outIm[index] - expected.im[index]),
      );
    }
    expect(maxError).toBeLessThan(1e-9);
  });
}
