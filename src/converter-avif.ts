import createEncoder from '@jsquash/avif/codec/enc/avif_enc.js';
import encoderWasm from '@jsquash/avif/codec/enc/avif_enc.wasm?url';
import createDecoder from '@jsquash/avif/codec/dec/avif_dec.js';
import decoderWasm from '@jsquash/avif/codec/dec/avif_dec.wasm?url';
import { defaultOptions } from '@jsquash/avif/meta.js';

let encoder: ReturnType<typeof createEncoder> | undefined;
let decoder: ReturnType<typeof createDecoder> | undefined;

export async function encodeAvif(image: ImageData, quality: number): Promise<Blob> {
  encoder ??= createEncoder({ locateFile: () => encoderWasm }).catch((error: unknown) => {
    encoder = undefined;
    throw error;
  });
  const codec = await encoder;
  const output = codec.encode(image.data, image.width, image.height, { ...defaultOptions, quality });
  if (!output?.byteLength) throw new Error('Could not encode this AVIF image.');
  return new Blob([new Uint8Array(output)], { type: 'image/avif' });
}

export async function decodeAvif(file: Blob): Promise<ImageBitmap> {
  decoder ??= createDecoder({ locateFile: () => decoderWasm }).catch((error: unknown) => {
    decoder = undefined;
    throw error;
  });
  const codec = await decoder;
  const image = codec.decode(await file.arrayBuffer(), 8);
  if (!image) throw new Error('Could not decode this AVIF image.');
  return createImageBitmap(image);
}
