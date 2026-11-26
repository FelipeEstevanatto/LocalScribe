/**
 * Playback for the audio studio.
 *
 * TrackPlayer plays the current track through an <audio> element routed into
 * Web Audio, so tempo (playbackRate with preserved pitch), pitch (a small
 * delay-line AudioWorklet), and tone changes can be previewed live before
 * FFmpeg renders them. StemMixer plays separated stems in sync with per-stem
 * volume, mute, and solo.
 */

let sharedContext: AudioContext | null = null;

export function audioContext(): AudioContext {
  sharedContext ??= new AudioContext({ latencyHint: 'interactive' });
  return sharedContext;
}

const PITCH_WORKLET = `
class PitchShift extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }
  constructor() {
    super();
    this.size = 8192;
    this.window = 2400;
    this.buffers = [];
    this.write = 0;
    this.phase = 0;
  }
  read(buffer, delay) {
    let position = this.write - delay;
    while (position < 0) position += this.size;
    const index = Math.floor(position);
    const fraction = position - index;
    const next = (index + 1) % this.size;
    return buffer[index] * (1 - fraction) + buffer[next] * fraction;
  }
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    const ratio = parameters.ratio[0];
    if (!input || !input.length) return true;
    while (this.buffers.length < input.length) this.buffers.push(new Float32Array(this.size));
    const frames = input[0].length;
    const bypass = Math.abs(ratio - 1) < 0.0005;
    for (let i = 0; i < frames; i += 1) {
      const p1 = this.phase;
      const p2 = (this.phase + 0.5) % 1;
      const g1 = 1 - Math.abs(1 - 2 * p1);
      const g2 = 1 - Math.abs(1 - 2 * p2);
      for (let channel = 0; channel < input.length; channel += 1) {
        const buffer = this.buffers[channel];
        buffer[this.write] = input[channel][i];
        const out = output[channel] || output[0];
        out[i] = bypass ? input[channel][i] : g1 * this.read(buffer, p1 * this.window + 1) + g2 * this.read(buffer, p2 * this.window + 1);
      }
      if (!bypass) {
        this.phase += (1 - ratio) / this.window;
        this.phase -= Math.floor(this.phase);
      }
      this.write = (this.write + 1) % this.size;
    }
    for (let channel = input.length; channel < output.length; channel += 1) output[channel].set(output[0]);
    return true;
  }
}
registerProcessor('studio-pitch-shift', PitchShift);
`;

let workletReady: Promise<boolean> | null = null;

function loadPitchWorklet(ctx: AudioContext): Promise<boolean> {
  workletReady ??= (async () => {
    const url = URL.createObjectURL(new Blob([PITCH_WORKLET], { type: 'text/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
      return true;
    } catch {
      return false;
    } finally {
      URL.revokeObjectURL(url);
    }
  })();
  return workletReady;
}

export interface ToneSettings {
  gain: number;
  bass: number;
  treble: number;
}

export interface FilterSettings {
  rumble: boolean;
  voice: boolean;
  reverb: boolean;
  mono: boolean;
}

/** A synthetic room: decaying stereo noise, close to the FFmpeg echo preset. */
function impulse(ctx: BaseAudioContext, seconds = 1.8): AudioBuffer {
  const length = Math.round(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
  }
  return buffer;
}

export class TrackPlayer {
  readonly audio = new Audio();
  private url: string | null = null;
  private graph: {
    source: MediaElementAudioSourceNode;
    pitch: AudioWorkletNode | null;
    bass: BiquadFilterNode;
    treble: BiquadFilterNode;
    highpass: BiquadFilterNode;
    lowpass: BiquadFilterNode;
    mono: GainNode;
    dry: GainNode;
    wet: GainNode;
    gain: GainNode;
  } | null = null;
  private filters: FilterSettings = { rumble: false, voice: false, reverb: false, mono: false };
  private frame = 0;
  private pitchRatio = 1;
  private tone: ToneSettings = { gain: 0, bass: 0, treble: 0 };
  /** Loop or stop inside this range when set. */
  range: { start: number; end: number; loop: boolean } | null = null;
  onTime: ((time: number) => void) | null = null;
  onState: ((playing: boolean) => void) | null = null;
  pitchAvailable = true;

  constructor() {
    this.audio.preload = 'auto';
    this.audio.preservesPitch = true;
    this.audio.addEventListener('play', () => { this.tick(); this.onState?.(true); });
    this.audio.addEventListener('pause', () => { cancelAnimationFrame(this.frame); this.frame = 0; this.onState?.(false); this.onTime?.(this.audio.currentTime); });
    this.audio.addEventListener('ended', () => this.onState?.(false));
    this.audio.addEventListener('seeked', () => this.onTime?.(this.audio.currentTime));
  }

  get playing(): boolean {
    return !this.audio.paused;
  }

  get currentTime(): number {
    return this.audio.currentTime;
  }

  setSource(blob: Blob | null): void {
    this.pause();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = blob ? URL.createObjectURL(blob) : null;
    if (this.url) this.audio.src = this.url;
    else this.audio.removeAttribute('src');
    this.range = null;
  }

  private async ensureGraph(): Promise<void> {
    if (this.graph) return;
    const ctx = audioContext();
    const pitchOk = await loadPitchWorklet(ctx);
    this.pitchAvailable = pitchOk;
    const source = ctx.createMediaElementSource(this.audio);
    const pitch = pitchOk ? new AudioWorkletNode(ctx, 'studio-pitch-shift', { outputChannelCount: [2] }) : null;
    const bass = ctx.createBiquadFilter();
    bass.type = 'lowshelf';
    bass.frequency.value = 100;
    const treble = ctx.createBiquadFilter();
    treble.type = 'highshelf';
    treble.frequency.value = 3000;
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    // Downmixing to one channel happens when channelCount is forced to 1.
    const mono = ctx.createGain();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    const convolver = ctx.createConvolver();
    convolver.buffer = impulse(ctx);
    const gain = ctx.createGain();
    if (pitch) source.connect(pitch).connect(bass);
    else source.connect(bass);
    bass.connect(treble).connect(highpass).connect(lowpass).connect(mono);
    mono.connect(dry).connect(gain);
    mono.connect(convolver).connect(wet).connect(gain);
    gain.connect(ctx.destination);
    this.graph = { source, pitch, bass, treble, highpass, lowpass, mono, dry, wet, gain };
    this.applyFilters();
    this.applyPitch();
    this.applyTone();
  }

  async play(): Promise<void> {
    await this.ensureGraph();
    await audioContext().resume();
    if (this.range) {
      const { start, end } = this.range;
      if (this.audio.currentTime < start || this.audio.currentTime >= end - 0.02) this.audio.currentTime = start;
    } else if (this.audio.ended) {
      this.audio.currentTime = 0;
    }
    await this.audio.play();
  }

  pause(): void {
    this.audio.pause();
  }

  async toggle(): Promise<void> {
    if (this.playing) this.pause();
    else await this.play();
  }

  seek(time: number): void {
    const duration = Number.isFinite(this.audio.duration) ? this.audio.duration : time;
    this.audio.currentTime = Math.max(0, Math.min(duration, time));
    this.onTime?.(this.audio.currentTime);
  }

  setTempo(rate: number): void {
    this.audio.playbackRate = rate;
  }

  setPitch(semitones: number): void {
    this.pitchRatio = 2 ** (semitones / 12);
    this.applyPitch();
  }

  setTone(tone: ToneSettings): void {
    this.tone = tone;
    this.applyTone();
  }

  setFilters(filters: FilterSettings): void {
    this.filters = filters;
    this.applyFilters();
  }

  private applyFilters(): void {
    if (!this.graph) return;
    const { rumble, voice, reverb, mono } = this.filters;
    const { highpass, lowpass } = this.graph;
    highpass.frequency.value = voice ? 120 : rumble ? 80 : 10;
    lowpass.frequency.value = voice ? 3500 : 22000;
    this.graph.mono.channelCount = mono ? 1 : 2;
    this.graph.mono.channelCountMode = mono ? 'explicit' : 'max';
    this.graph.wet.gain.value = reverb ? 0.35 : 0;
    this.graph.dry.gain.value = 1;
  }

  private applyPitch(): void {
    const param = this.graph?.pitch?.parameters.get('ratio');
    if (param) param.value = this.pitchRatio;
  }

  private applyTone(): void {
    if (!this.graph) return;
    this.graph.bass.gain.value = this.tone.bass;
    this.graph.treble.gain.value = this.tone.treble;
    this.graph.gain.gain.value = 10 ** (this.tone.gain / 20);
  }

  private tick = (): void => {
    const time = this.audio.currentTime;
    if (this.range && time >= this.range.end) {
      if (this.range.loop) this.audio.currentTime = this.range.start;
      else {
        this.audio.pause();
        this.audio.currentTime = this.range.end;
      }
    }
    this.onTime?.(this.audio.currentTime);
    if (!this.audio.paused) this.frame = requestAnimationFrame(this.tick);
  };
}

export interface MixerStem {
  name: string;
  blob: Blob;
  buffer: AudioBuffer;
  volume: number;
  muted: boolean;
  solo: boolean;
}

export class StemMixer {
  stems: MixerStem[] = [];
  private nodes: { source: AudioBufferSourceNode; gain: GainNode }[] = [];
  private startedAt = 0;
  private offset = 0;
  private frame = 0;
  playing = false;
  onTime: ((time: number) => void) | null = null;
  onState: ((playing: boolean) => void) | null = null;

  get duration(): number {
    return Math.max(0, ...this.stems.map(({ buffer }) => buffer.duration));
  }

  get currentTime(): number {
    if (!this.playing) return this.offset;
    return Math.min(this.duration, this.offset + audioContext().currentTime - this.startedAt);
  }

  async load(stems: { name: string; blob: Blob }[]): Promise<void> {
    this.stop();
    const ctx = audioContext();
    const loaded: MixerStem[] = [];
    // Decode one stem at a time so only one compressed buffer is alive beside
    // the decoded buffers that the mixer needs for playback.
    for (const { name, blob } of stems) {
      loaded.push({
        name,
        blob,
        buffer: await ctx.decodeAudioData(await blob.arrayBuffer()),
        volume: 1,
        muted: false,
        solo: false,
      });
    }
    this.stems = loaded;
    this.offset = 0;
  }

  clear(): void {
    this.stop();
    this.stems = [];
    this.offset = 0;
  }

  /** Linear gain each stem contributes, after mute and solo. */
  effectiveGains(): number[] {
    const soloing = this.stems.some(({ solo }) => solo);
    return this.stems.map(({ volume, muted, solo }) => (soloing ? (solo ? volume : 0) : muted ? 0 : volume));
  }

  refreshGains(): void {
    const gains = this.effectiveGains();
    const ctx = audioContext();
    this.nodes.forEach(({ gain }, i) => gain.gain.setTargetAtTime(gains[i], ctx.currentTime, 0.015));
  }

  async play(): Promise<void> {
    if (this.playing || !this.stems.length) return;
    const ctx = audioContext();
    await ctx.resume();
    if (this.offset >= this.duration - 0.01) this.offset = 0;
    const gains = this.effectiveGains();
    const when = ctx.currentTime + 0.03;
    this.nodes = this.stems.map(({ buffer }, i) => {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = gains[i];
      source.connect(gain).connect(ctx.destination);
      source.start(when, this.offset);
      return { source, gain };
    });
    this.nodes[0].source.onended = () => {
      if (this.playing && this.currentTime >= this.duration - 0.05) {
        this.pause();
        this.offset = 0;
        this.onTime?.(0);
      }
    };
    this.startedAt = when;
    this.playing = true;
    this.onState?.(true);
    this.tick();
  }

  pause(): void {
    if (!this.playing) return;
    this.offset = this.currentTime;
    this.stop();
  }

  private stop(): void {
    for (const { source } of this.nodes) {
      source.onended = null;
      try { source.stop(); } catch { /* not started */ }
      source.disconnect();
    }
    this.nodes = [];
    cancelAnimationFrame(this.frame);
    if (this.playing) {
      this.playing = false;
      this.onState?.(false);
    }
  }

  async toggle(): Promise<void> {
    if (this.playing) this.pause();
    else await this.play();
  }

  seek(time: number): void {
    const resume = this.playing;
    this.stop();
    this.offset = Math.max(0, Math.min(this.duration, time));
    this.onTime?.(this.offset);
    if (resume) void this.play();
  }

  private tick = (): void => {
    this.onTime?.(this.currentTime);
    if (this.playing) this.frame = requestAnimationFrame(this.tick);
  };
}

/** Peak envelope of an AudioBuffer for drawing (max of all channels). */
export function bufferPeaks(buffer: AudioBuffer, buckets = 4096): Float32Array {
  const count = Math.min(buckets, buffer.length);
  const peaks = new Float32Array(count);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    const size = data.length / count;
    for (let bucket = 0; bucket < count; bucket += 1) {
      const end = Math.min(data.length, Math.floor((bucket + 1) * size));
      let peak = peaks[bucket];
      for (let i = Math.floor(bucket * size); i < end; i += 4) {
        const value = Math.abs(data[i]);
        if (value > peak) peak = value;
      }
      peaks[bucket] = peak;
    }
  }
  return peaks;
}
