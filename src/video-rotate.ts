/**
 * Rotate an MP4/MOV by rewriting the video track's display matrix. Packets are
 * copied, nothing is decoded: the FFmpeg WASM path rewrote the whole file and
 * probed it again for the same metadata change (3.9 s for a 5 min 1080p file).
 */
import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, MovOutputFormat, Mp4OutputFormat, Output } from 'mediabunny';

export async function rotateByMetadata(
  file: Blob,
  angle: 90 | 180 | 270,
  format: 'mp4' | 'mov',
  signal?: AbortSignal,
  onProgress?: (ratio: number) => void,
): Promise<Blob | null> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) return null;
    const target = new BufferTarget();
    const output = new Output({
      format: format === 'mov' ? new MovOutputFormat({ fastStart: 'in-memory' }) : new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target,
    });
    const codec = await video.getCodec();
    if (!codec || !output.format.getSupportedVideoCodecs().includes(codec)) return null;
    const conversion = await Conversion.init({
      input,
      output,
      // Clockwise, added to the source rotation; written as metadata only.
      video: { rotate: angle, allowTransformationMetadata: true },
    });
    if (!conversion.isValid || conversion.discardedTracks.some((entry) => entry.track === video)) return null;
    conversion.onProgress = (progress) => onProgress?.(progress);
    const stop = (): void => void conversion.cancel();
    signal?.addEventListener('abort', stop, { once: true });
    try {
      signal?.throwIfAborted();
      await conversion.execute();
      signal?.throwIfAborted();
    } finally {
      signal?.removeEventListener('abort', stop);
    }
    return target.buffer ? new Blob([target.buffer], { type: format === 'mov' ? 'video/quicktime' : 'video/mp4' }) : null;
  } finally {
    input.dispose();
  }
}
