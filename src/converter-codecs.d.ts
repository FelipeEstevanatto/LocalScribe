declare module 'amr-js/library/amrnb.js' {
  const codec: {
    encode(samples: Float32Array, sampleRate: number, mode: number): Uint8Array | null;
  };
  export default codec;
}
