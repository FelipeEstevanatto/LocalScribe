import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output, QUALITY_MEDIUM } from 'mediabunny';

self.onmessage = async ({ data }: MessageEvent<{ file: File; width: number; height: number }>) => {
  const { file, width, height } = data;
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getAudioTracks();
    // Keep audio available if the user later enables the video's original track.
    if (!video || audio.length > 1 || (audio.length === 1 && await audio[0].getCodec() !== 'aac')) {
      self.postMessage(null);
      return;
    }
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const conversion = await Conversion.init({
      input, output, tracks: 'primary',
      video: { codec: 'avc', width, height, fit: 'contain', bitrate: QUALITY_MEDIUM, keyFrameInterval: 0.5 },
    });
    if (!conversion.isValid || conversion.discardedTracks.some((track) => track.track === video || track.track === audio[0])) {
      self.postMessage(null);
      return;
    }
    await conversion.execute();
    self.postMessage(new Blob([target.buffer!], { type: 'video/mp4' }));
  } catch (error) {
    console.warn('Automatic preview proxy could not be built.', error);
    self.postMessage(null);
  } finally {
    input.dispose();
  }
};
