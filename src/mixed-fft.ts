/**
 * Mixed-radix Cooley–Tukey FFT for composite sizes.
 *
 * The Whisper/Qwen frontend needs an exact 400-point transform (400 = 2^4 ×
 * 5²). A power-of-two FFT zero-padded to 512 changes the bin spacing, so this
 * plan factors any composite size into its smallest prime factor recursively.
 * Tables and scratch buffers are reused between calls.
 */

export interface MixedFft {
  readonly size: number;
  /** Forward transform with natural-order input and output. */
  forward(inputRe: Float64Array, inputIm: Float64Array, outputRe: Float64Array, outputIm: Float64Array): void;
}

function smallestPrimeFactorTable(size: number): Uint8Array {
  const table = new Uint8Array(size + 1);
  for (let value = 2; value <= size; value += 1) {
    if (table[value]) continue;
    for (let multiple = value; multiple <= size; multiple += value) {
      if (!table[multiple]) table[multiple] = value;
    }
  }
  return table;
}

export function createMixedFft(size: number): MixedFft {
  if (size < 1) throw new Error('FFT size must be positive.');
  const cos = new Float64Array(size);
  const sin = new Float64Array(size);
  for (let index = 0; index < size; index += 1) {
    const angle = (2 * Math.PI * index) / size;
    cos[index] = Math.cos(angle);
    sin[index] = Math.sin(angle);
  }
  const spf = smallestPrimeFactorTable(size);
  // The recursion reserves n scratch slots per composite call. For 400 this
  // peaks around 6 × size; keep headroom for other composite sizes.
  const scratchRe = new Float64Array(size * Math.max(4, Math.ceil(Math.log2(size) + 2)));
  const scratchIm = new Float64Array(scratchRe.length);
  let scratchOffset = 0;

  function transform(
    inputRe: Float64Array,
    inputIm: Float64Array,
    inputOffset: number,
    inputStride: number,
    outputRe: Float64Array,
    outputIm: Float64Array,
    outputOffset: number,
    count: number,
  ): void {
    if (count === 1) {
      outputRe[outputOffset] = inputRe[inputOffset];
      outputIm[outputOffset] = inputIm[inputOffset];
      return;
    }

    const radix = spf[count] || count;
    if (radix === count) {
      // Prime base case: a direct DFT of 5, 7, ... points.
      const step = size / count;
      for (let k = 0; k < count; k += 1) {
        let real = 0;
        let imaginary = 0;
        for (let sample = 0; sample < count; sample += 1) {
          const tableIndex = (sample * k * step) % size;
          const wr = cos[tableIndex];
          const wi = -sin[tableIndex];
          const sr = inputRe[inputOffset + sample * inputStride];
          const si = inputIm[inputOffset + sample * inputStride];
          real += sr * wr - si * wi;
          imaginary += sr * wi + si * wr;
        }
        outputRe[outputOffset + k] = real;
        outputIm[outputOffset + k] = imaginary;
      }
      return;
    }

    const part = count / radix;
    const base = scratchOffset;
    scratchOffset += count;
    for (let branch = 0; branch < radix; branch += 1) {
      transform(
        inputRe,
        inputIm,
        inputOffset + branch * inputStride,
        inputStride * radix,
        scratchRe,
        scratchIm,
        base + branch * part,
        part,
      );
    }

    const step = size / count;
    for (let k = 0; k < count; k += 1) {
      const partIndex = k % part;
      let real = 0;
      let imaginary = 0;
      for (let branch = 0; branch < radix; branch += 1) {
        const tableIndex = (branch * k * step) % size;
        const wr = cos[tableIndex];
        const wi = -sin[tableIndex];
        const sr = scratchRe[base + branch * part + partIndex];
        const si = scratchIm[base + branch * part + partIndex];
        real += sr * wr - si * wi;
        imaginary += sr * wi + si * wr;
      }
      outputRe[outputOffset + k] = real;
      outputIm[outputOffset + k] = imaginary;
    }
  }

  return {
    size,
    forward(inputRe, inputIm, outputRe, outputIm) {
      if (inputRe.length < size || inputIm.length < size || outputRe.length < size || outputIm.length < size) {
        throw new Error('FFT buffers are smaller than the transform.');
      }
      scratchOffset = 0;
      transform(inputRe, inputIm, 0, 1, outputRe, outputIm, 0, size);
    },
  };
}
