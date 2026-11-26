export interface FftPlan {
  size: number;
  reversed: Uint16Array;
  cos: Float64Array;
  sin: Float64Array;
}

export function buildFftPlan(size: number): FftPlan {
  const bits = Math.round(Math.log2(size));
  const reversed = new Uint16Array(size);

  for (let i = 0; i < size; i += 1) {
    let value = i;
    let result = 0;
    for (let bit = 0; bit < bits; bit += 1) {
      result = (result << 1) | (value & 1);
      value >>= 1;
    }
    reversed[i] = result;
  }

  const cos = new Float64Array(size >> 1);
  const sin = new Float64Array(size >> 1);

  for (let i = 0; i < size >> 1; i += 1) {
    const angle = (-2 * Math.PI * i) / size;
    cos[i] = Math.cos(angle);
    sin[i] = Math.sin(angle);
  }

  return { size, reversed, cos, sin };
}

/** In-place iterative radix-2 Cooley-Tukey FFT. */
export function fft(re: Float64Array, im: Float64Array, plan: FftPlan): void {
  const { size, reversed, cos, sin } = plan;

  for (let i = 0; i < size; i += 1) {
    const j = reversed[i];
    if (j > i) {
      const tr = re[i];
      const ti = im[i];
      re[i] = re[j];
      im[i] = im[j];
      re[j] = tr;
      im[j] = ti;
    }
  }

  for (let length = 2; length <= size; length <<= 1) {
    const half = length >> 1;
    const tableStep = size / length;

    for (let start = 0; start < size; start += length) {
      for (let j = 0; j < half; j += 1) {
        const k = j * tableStep;
        const wr = cos[k];
        const wi = sin[k];
        const even = start + j;
        const odd = even + half;

        const tr = re[odd] * wr - im[odd] * wi;
        const ti = re[odd] * wi + im[odd] * wr;

        re[odd] = re[even] - tr;
        im[odd] = im[even] - ti;
        re[even] += tr;
        im[even] += ti;
      }
    }
  }
}


