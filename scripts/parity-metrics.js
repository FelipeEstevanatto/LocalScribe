// Image similarity scores shared by the parity harnesses.
//
// PSNR is over the RGB channels. SSIM is computed on luma (BT.601) in 8x8
// windows and averaged over the windows, with the usual constants
// (K1 0.01, K2 0.03, L 255). passesO8 is the export gate proposed for moving
// export pixel effects to the GPU compositor: SSIM >= 0.995 and PSNR >= 45 dB.

const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

function lumaPlane(data, pixels) {
  const out = new Float64Array(pixels);
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const i = pixel * 4;
    out[pixel] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return out;
}

export function imageScores(a, b, width, height = a.length / 4 / width) {
  const pixels = width * height;
  let squared = 0;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      const d = a[pixel * 4 + channel] - b[pixel * 4 + channel];
      squared += d * d;
    }
  }
  const mse = squared / (pixels * 3);
  const psnr = mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);

  const la = lumaPlane(a, pixels);
  const lb = lumaPlane(b, pixels);
  let ssimSum = 0;
  let minSsim = 1;
  let windows = 0;
  for (let y0 = 0; y0 + 8 <= height; y0 += 8) {
    for (let x0 = 0; x0 + 8 <= width; x0 += 8) {
      let ma = 0;
      let mb = 0;
      for (let y = y0; y < y0 + 8; y += 1) {
        for (let x = x0; x < x0 + 8; x += 1) {
          ma += la[y * width + x];
          mb += lb[y * width + x];
        }
      }
      ma /= 64;
      mb /= 64;
      let va = 0;
      let vb = 0;
      let cov = 0;
      for (let y = y0; y < y0 + 8; y += 1) {
        for (let x = x0; x < x0 + 8; x += 1) {
          const da = la[y * width + x] - ma;
          const db = lb[y * width + x] - mb;
          va += da * da;
          vb += db * db;
          cov += da * db;
        }
      }
      va /= 63;
      vb /= 63;
      cov /= 63;
      const value = ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      ssimSum += value;
      if (value < minSsim) minSsim = value;
      windows += 1;
    }
  }
  const ssim = ssimSum / Math.max(1, windows);
  return {
    ssim: +ssim.toFixed(5),
    ssimMinWindow: +minSsim.toFixed(4),
    psnr: Number.isFinite(psnr) ? +psnr.toFixed(2) : 'inf',
    passesO8: ssim >= 0.995 && psnr >= 45,
  };
}
