/**
 * Screen and camera recorder.
 *
 * MediaRecorder records the display/camera video and a locally mixed audio
 * track (system audio + microphone). Nothing is uploaded; the result can be
 * downloaded, opened in the video editor, or transcribed.
 */

interface RecordOptions {
  download: (blob: Blob, name: string) => void;
  openInEditor: (file: File) => void;
  transcribe: (file: File) => void;
}

/** Chrome's self-capture hint; ignored by browsers that do not know it. */
interface MirrorSafeDisplayOptions extends DisplayMediaStreamOptions {
  selfBrowserSurface?: 'include' | 'exclude';
}

const MP4_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1',
  'video/mp4',
];

const HEVC_CANDIDATES = [
  'video/mp4;codecs=hvc1.1.6.L93.B0,mp4a.40.2',
  'video/mp4;codecs=hev1.1.6.L93.B0,mp4a.40.2',
  'video/mp4;codecs=hvc1.1.6.L93.B0',
  'video/mp4;codecs=hev1.1.6.L93.B0',
  'video/mp4;codecs=hvc1',
  'video/mp4;codecs=hev1',
];

const WEBM_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

export interface RecorderFormat {
  id: 'mp4-h264' | 'mp4-hevc' | 'webm';
  label: string;
  mime: string;
  extension: 'mp4' | 'webm';
}

const FPS_PRESETS = [60, 50, 30, 25, 24, 15];

/** Recording frame rate, constrained to the presets offered by the UI. */
export function recorderFps(value: string): number {
  const parsed = Number(value);
  return FPS_PRESETS.includes(parsed) ? parsed : 30;
}

function browserSupportsRecorderMime(mime: string): boolean {
  return typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime);
}

/**
 * Formats the current browser can record natively. Only containers with a
 * working MediaRecorder MIME type are returned, so the UI never offers an
 * option that would silently fall back to a different file type.
 */
export function availableRecorderFormats(
  isSupported: (mime: string) => boolean = browserSupportsRecorderMime,
): RecorderFormat[] {
  const formats: RecorderFormat[] = [];
  const mp4 = MP4_CANDIDATES.find((mime) => isSupported(mime));
  if (mp4) {
    formats.push({ id: 'mp4-h264', label: 'MP4 · H.264', mime: mp4, extension: 'mp4' });
  }
  const hevc = HEVC_CANDIDATES.find((mime) => isSupported(mime));
  if (hevc) {
    formats.push({ id: 'mp4-hevc', label: 'MP4 · H.265', mime: hevc, extension: 'mp4' });
  }
  const webm = WEBM_CANDIDATES.find((mime) => isSupported(mime));
  if (webm) {
    formats.push({
      id: 'webm',
      label: webm.includes('vp9') ? 'WebM · VP9' : 'WebM · VP8',
      mime: webm,
      extension: 'webm',
    });
  }
  return formats;
}

export interface RecorderResolution {
  width: number;
  height: number;
}

const RESOLUTION_PRESETS: Record<string, RecorderResolution> = {
  '2160': { width: 3840, height: 2160 },
  '1440': { width: 2560, height: 1440 },
  '1080': { width: 1920, height: 1080 },
  '720': { width: 1280, height: 720 },
  '480': { width: 854, height: 480 },
};

const AUTO_VIDEO_BITRATES: Record<string, number> = {
  '2160': 18_000_000,
  '1440': 10_000_000,
  '1080': 6_000_000,
  '720': 4_000_000,
  '480': 2_500_000,
  '0': 8_000_000,
};

/** Requested capture size, or null for the source's native size. */
export function recorderResolution(quality: string): RecorderResolution | null {
  return RESOLUTION_PRESETS[quality] ?? null;
}

/**
 * Resolution-based default for the video bitrate hint passed to MediaRecorder.
 * Higher frame rates need more bits; low frame rates save space.
 */
export function autoVideoBitrate(quality: string, fps = 30): number {
  const base = AUTO_VIDEO_BITRATES[quality] ?? 8_000_000;
  const factor = fps >= 50 ? 1.6 : fps >= 30 ? 1 : fps >= 25 ? 0.9 : fps >= 24 ? 0.85 : 0.6;
  return Math.round((base * factor) / 100_000) * 100_000;
}

export function formatBitrate(bitsPerSecond: number): string {
  const mbps = bitsPerSecond / 1_000_000;
  return `${Number.isInteger(mbps) ? mbps : mbps.toFixed(1)} Mbps`;
}

export function pickRecorderMime(): string {
  return availableRecorderFormats()[0]?.mime ?? '';
}

export function recordingExtension(mime: string): string {
  return mime.startsWith('video/mp4') ? 'mp4' : 'webm';
}

export function recordingName(date = new Date(), mime = 'video/webm'): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `recording-${stamp}.${recordingExtension(mime)}`;
}

export function clockDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function sizeLabel(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.round(bytes / 1000)} KB`;
}

export function setupRecordStudio(root: HTMLElement, options: RecordOptions) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const element = root.querySelector<T>('#' + id);
    if (!element) throw new Error('Missing recorder control: ' + id);
    return element;
  };

  const source = $<HTMLSelectElement>('rec-source');
  const quality = $<HTMLSelectElement>('rec-quality');
  const fps = $<HTMLSelectElement>('rec-fps');
  const formatField = $('rec-format-field');
  const formatSelect = $<HTMLSelectElement>('rec-format');
  const bitrate = $<HTMLSelectElement>('rec-bitrate');
  const camOptions = $('rec-cam-options');
  const camPosition = $<HTMLSelectElement>('rec-cam-position');
  const camSize = $<HTMLSelectElement>('rec-cam-size');
  const camMirror = $<HTMLInputElement>('rec-cam-mirror');
  const mic = $<HTMLInputElement>('rec-mic');
  const system = $<HTMLInputElement>('rec-system');
  const systemRow = $('rec-system-row');
  const countdown = $<HTMLInputElement>('rec-countdown');
  const start = $<HTMLButtonElement>('rec-start');
  const startLabel = $('rec-start-label');
  const pause = $<HTMLButtonElement>('rec-pause');
  const stop = $<HTMLButtonElement>('rec-stop');
  const status = $('rec-status');
  const hint = $('rec-hint');
  const preview = $<HTMLVideoElement>('rec-preview');
  const previewCard = $('rec-preview-card');
  const previewGuard = $('rec-preview-guard');
  const previewGuardDetail = $('rec-preview-guard-detail');
  const previewToggle = $<HTMLButtonElement>('rec-preview-toggle');
  const previewToggleLabel = $('rec-preview-toggle-label');
  const placeholder = $('rec-placeholder');
  const live = $('rec-live');
  const liveLabel = $('rec-live-label');
  const startingPanel = $('rec-starting');
  const startingLabel = $('rec-starting-label');
  const startingDetail = $('rec-starting-detail');
  const startCountdown = $('rec-start-countdown');
  const startCountdownNumber = $('rec-start-countdown-number');
  const timer = $('rec-timer');
  const resultBox = $('rec-result-box');
  const result = $<HTMLVideoElement>('rec-result');
  const resultBadge = $('rec-result-badge');
  const resultMeta = $('rec-result-meta');
  const download = $<HTMLButtonElement>('rec-download');
  const openEditor = $<HTMLButtonElement>('rec-open-editor');
  const transcribe = $<HTMLButtonElement>('rec-transcribe');

  const formats = availableRecorderFormats();
  const recordingSupported = formats.length > 0;
  formatSelect.replaceChildren(...formats.map((format) => {
    const option = document.createElement('option');
    option.value = format.mime;
    option.textContent = format.label;
    if (format.id === 'mp4-hevc') {
      option.title = 'H.265 / HEVC. Offered when this browser and device have a working encoder.';
    }
    return option;
  }));
  if (formats.length) formatSelect.value = formats[0].mime;
  // A one-option format picker changes nothing, so only show it when the
  // browser actually offers more than one usable container.
  formatField.classList.toggle('hidden', formats.length < 2);
  if (!recordingSupported) {
    setStatus('This browser cannot record video with MediaRecorder.', 'error');
  }

  let recorder: MediaRecorder | null = null;
  let outputStream: MediaStream | null = null;
  let sources: MediaStream[] = [];
  let audioContext: AudioContext | null = null;
  let audioDestination: MediaStreamAudioDestinationNode | null = null;
  let audioNodes: MediaStreamAudioSourceNode[] = [];
  let chunks: Blob[] = [];
  let resultBlob: Blob | null = null;
  let resultFile: File | null = null;
  let resultUrl = '';
  let activeFormat: RecorderFormat | null = null;
  let activeFps = 30;
  let screenCaptureActive = false;
  let screenPreviewVisible = false;
  let startedAt = 0;
  let pausedAt = 0;
  let pausedTotal = 0;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let busy = false;
  let beginToken = 0;
  let compositor: { stream: MediaStream; cancel: () => void } | null = null;
  let warmupPromise: Promise<void> | null = null;
  let warmupKey = '';
  let warmupTimer = 0;
  let micPermission: PermissionState | 'unknown' = 'unknown';
  let cameraPermission: PermissionState | 'unknown' = 'unknown';

  function setStatus(message: string, tone: 'normal' | 'error' | 'good' = 'normal'): void {
    status.textContent = message;
    status.dataset.tone = tone;
  }

  function syncBitrateLabel(): void {
    const auto = bitrate.querySelector<HTMLOptionElement>('option[value="auto"]');
    if (auto) auto.textContent = `Auto (${formatBitrate(autoVideoBitrate(quality.value, recorderFps(fps.value)))})`;
  }

  function selectedVideoBitrate(): number {
    const manual = Number(bitrate.value);
    return Number.isFinite(manual) && manual > 0 ? manual : autoVideoBitrate(quality.value, recorderFps(fps.value));
  }

  function watchPermission(name: 'microphone' | 'camera', apply: (state: PermissionState) => void): void {
    try {
      void navigator.permissions?.query({ name: name as PermissionName }).then((status) => {
        apply(status.state);
        status.onchange = () => apply(status.state);
      }).catch(() => undefined);
    } catch {
      // The Permissions API is optional; fall back to requesting media normally.
    }
  }

  watchPermission('microphone', (state) => { micPermission = state; });
  watchPermission('camera', (state) => { cameraPermission = state; });

  /**
   * MediaRecorder's first hardware-encoder start can be slow on some GPUs.
   * Warm the selected codec with a tiny throwaway canvas before the user
   * shares, so the freeze does not land after the screen picker closes.
   */
  async function warmUpEncoder(): Promise<void> {
    if (recorder) return;
    const format = formats.find((entry) => entry.mime === formatSelect.value) ?? formats[0];
    if (!format || typeof MediaRecorder === 'undefined') return;
    const key = `${format.mime}|${recorderFps(fps.value)}|${quality.value}|${bitrate.value}`;
    if (warmupKey === key && warmupPromise) return warmupPromise;
    warmupKey = key;
    // Warm the exact encoder envelope rather than a tiny generic canvas: a
    // hardware encoder configured for 1080p is not necessarily warm just
    // because a 320x180 session was.
    const target = recorderResolution(quality.value);
    const warmWidth = target?.width ?? 1920;
    const warmHeight = target?.height ?? 1080;
    const previous = warmupPromise;
    warmupPromise = (async () => {
      if (previous) await previous;
      let stream: MediaStream | null = null;
      let warm: MediaRecorder | null = null;
      let oscillator: OscillatorNode | null = null;
      let silentGain: GainNode | null = null;
      let silentDestination: MediaStreamAudioDestinationNode | null = null;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = warmWidth;
        canvas.height = warmHeight;
        const canvasContext = canvas.getContext('2d');
        if (!canvasContext) return;
        canvasContext.fillStyle = '#05070d';
        canvasContext.fillRect(0, 0, canvas.width, canvas.height);
        stream = canvas.captureStream(recorderFps(fps.value));
        // Warm the audio encoder too. A silent track makes MediaRecorder
        // initialize its AAC/Opus path, avoiding a second cold start later.
        const context = ensureAudioContext();
        if (context) {
          if (context.state === 'suspended') void context.resume().catch(() => undefined);
          silentDestination = context.createMediaStreamDestination();
          silentGain = context.createGain();
          silentGain.gain.value = 0;
          oscillator = context.createOscillator();
          oscillator.connect(silentGain);
          silentGain.connect(silentDestination);
          oscillator.start();
          const audioTrack = silentDestination.stream.getAudioTracks()[0];
          if (audioTrack) stream.addTrack(audioTrack);
        }
        warm = new MediaRecorder(stream, {
          mimeType: format.mime,
          videoBitsPerSecond: selectedVideoBitrate(),
          audioBitsPerSecond: 128_000,
        });
        warm.start(1000);
        await new Promise((resolve) => setTimeout(resolve, 140));
        if (warm.state !== 'inactive') {
          const stopped = new Promise<void>((resolve) => {
            warm?.addEventListener('stop', () => resolve(), { once: true });
            setTimeout(resolve, 250);
          });
          warm.stop();
          await stopped;
        }
      } catch {
        // Warm-up is an optimization only; the real recording still works.
      } finally {
        try {
          oscillator?.stop();
        } catch {
          // The oscillator was already stopped.
        }
        oscillator?.disconnect();
        silentGain?.disconnect();
        silentDestination?.stream.getTracks().forEach((track) => track.stop());
        stream?.getTracks().forEach((track) => track.stop());
      }
    })();
    return warmupPromise;
  }

  function scheduleWarmup(delay = 220): void {
    if (warmupTimer) window.clearTimeout(warmupTimer);
    warmupTimer = window.setTimeout(() => {
      warmupTimer = 0;
      void warmUpEncoder();
    }, delay);
  }

  function setStarting(label: string, detail: string): void {
    startingLabel.textContent = label;
    startingDetail.textContent = detail;
    startingPanel.classList.remove('hidden');
    placeholder.classList.add('hidden');
    previewGuard.classList.add('hidden');
    previewToggle.classList.add('hidden');
    preview.classList.add('hidden');
  }

  function clearStarting(): void {
    startingPanel.classList.add('hidden');
  }

  function showLivePreview(): void {
    if (!outputStream) return;
    preview.srcObject = outputStream;
    preview.classList.remove('hidden');
    preview.play().catch(() => undefined);
  }

  function hideLivePreview(): void {
    preview.pause();
    preview.srcObject = null;
    preview.classList.add('hidden');
  }

  function syncPreviewToggle(): void {
    previewToggle.classList.toggle('active', screenPreviewVisible);
    previewToggle.setAttribute('aria-pressed', String(screenPreviewVisible));
    previewToggleLabel.textContent = screenPreviewVisible ? 'Hide preview' : 'Show preview';
    previewToggle.title = screenPreviewVisible
      ? 'Hide the live preview'
      : 'Show the live preview. This may create a mirror in the recording.';
  }

  function setScreenPreviewVisible(visible: boolean): void {
    if (!screenCaptureActive) return;
    screenPreviewVisible = visible;
    if (visible) {
      previewGuard.classList.add('hidden');
      showLivePreview();
    } else {
      hideLivePreview();
      previewGuard.classList.remove('hidden');
    }
    syncPreviewToggle();
  }

  function updateButtons(): void {
    const state = recorder?.state;
    const active = state === 'recording' || state === 'paused';
    const locked = busy || active;
    const camera = source.value === 'camera';
    const webcamOverlay = source.value === 'screen-webcam';

    start.disabled = locked || !recordingSupported;
    start.classList.toggle('hidden', active);
    startLabel.textContent = busy && !active ? 'Starting…' : 'Start recording';
    pause.disabled = !active || busy;
    stop.disabled = !active || busy;
    pause.classList.toggle('hidden', !active);
    stop.classList.toggle('hidden', !active);
    pause.textContent = state === 'paused' ? 'Resume' : 'Pause';

    for (const control of [source, quality, fps, formatSelect, bitrate, camPosition, camSize, camMirror, mic, countdown]) {
      control.disabled = locked;
    }
    system.disabled = locked || camera;
    systemRow.classList.toggle('hidden', camera);
    camOptions.classList.toggle('hidden', !webcamOverlay);

    hint.textContent = camera
      ? 'Camera capture runs on this device. Resolution, frame rate, and bitrate are targets; the camera may choose a lower size or rate.'
      : 'Screen capture and system audio depend on the browser and platform. Resolution, frame rate, and bitrate are targets; the browser may lower them, and some browsers only capture the screen.';
    const sourceSize = quality.querySelector<HTMLOptionElement>('option[value="0"]');
    if (sourceSize) sourceSize.textContent = camera ? 'Camera default' : 'Source size';

    live.classList.toggle('hidden', !active);
    live.classList.toggle('is-paused', state === 'paused');
    liveLabel.textContent = state === 'paused' ? 'PAUSED' : 'REC';
    previewCard.classList.toggle('is-live', active);
    previewCard.classList.toggle('is-paused', state === 'paused');
  }

  function setTimer(): void {
    if (!startedAt) {
      timer.textContent = '00:00';
      return;
    }
    const elapsed = (recorder?.state === 'paused' ? pausedAt : Date.now()) - startedAt - pausedTotal;
    timer.textContent = clockDuration(elapsed / 1000);
  }

  function clearTicker(): void {
    if (ticker) clearInterval(ticker);
    ticker = null;
  }

  function stopSources(): void {
    clearStarting();
    startCountdown.classList.add('hidden');
    screenCaptureActive = false;
    screenPreviewVisible = false;
    previewToggle.classList.add('hidden');
    syncPreviewToggle();
    compositor?.cancel();
    compositor = null;
    for (const stream of sources) for (const track of stream.getTracks()) track.stop();
    sources = [];
    for (const track of outputStream?.getTracks() ?? []) track.stop();
    outputStream = null;
    preview.srcObject = null;
    preview.classList.add('hidden');
    previewGuard.classList.add('hidden');
    placeholder.classList.remove('hidden');
    for (const node of audioNodes) {
      try {
        node.disconnect();
      } catch {
        // The node was already detached.
      }
    }
    audioNodes = [];
    audioDestination?.stream.getTracks().forEach((track) => track.stop());
    audioDestination = null;
    if (audioContext?.state === 'running') void audioContext.suspend().catch(() => undefined);
  }

  function clearResult(): void {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = '';
    resultFile = null;
    resultBlob = null;
    result.removeAttribute('src');
    resultBadge.textContent = '';
    result.load();
    resultBox.classList.add('hidden');
  }

  function ensureAudioContext(): AudioContext | null {
    if (!audioContext || audioContext.state === 'closed') {
      try {
        audioContext = new AudioContext();
      } catch {
        audioContext = null;
      }
    }
    return audioContext;
  }

  /** Resume the shared audio graph before the picker, not on the share path. */
  function primeAudioContext(): void {
    const context = ensureAudioContext();
    if (context?.state === 'suspended') void context.resume().catch(() => undefined);
  }

  async function mixAudio(streams: MediaStream[]): Promise<MediaStreamTrack[]> {
    const tracks = streams.flatMap((stream) => stream.getAudioTracks());
    if (!tracks.length) return [];
    if (tracks.length === 1) return tracks;
    const context = ensureAudioContext();
    if (!context) return tracks.slice(0, 1);
    if (context.state !== 'running') {
      await Promise.race([
        context.resume().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
    }
    audioDestination = context.createMediaStreamDestination();
    for (const stream of streams) {
      if (!stream.getAudioTracks().length) continue;
      const node = context.createMediaStreamSource(stream);
      node.connect(audioDestination);
      audioNodes.push(node);
    }
    return audioDestination.stream.getAudioTracks();
  }

  function even(value: number): number {
    return Math.max(2, Math.round(value / 2) * 2);
  }

  function webcamRect(width: number, height: number): { x: number; y: number; width: number; height: number } {
    const short = Math.min(width, height);
    const scale = camSize.value === 'small' ? 0.18 : camSize.value === 'large' ? 0.32 : 0.24;
    const w = Math.round(short * scale);
    const h = Math.round(w * 9 / 16);
    const margin = Math.round(short * 0.025);
    const [vertical, horizontal] = camPosition.value.split('-');
    const x = horizontal === 'left' ? margin : horizontal === 'right' ? width - w - margin : Math.round((width - w) / 2);
    const y = vertical === 'top' ? margin : vertical === 'bottom' ? height - h - margin : Math.round((height - h) / 2);
    return { x, y, width: w, height: h };
  }

  async function startCompositor(screen: MediaStream, webcam: MediaStream, targetFps: number): Promise<MediaStream> {
    const settings = screen.getVideoTracks()[0]?.getSettings();
    let width = settings?.width ?? 1280;
    let height = settings?.height ?? 720;
    const target = recorderResolution(quality.value);
    if (target) {
      const scale = Math.min(1, Math.max(target.width, target.height) / Math.max(width, height));
      width *= scale;
      height *= scale;
    }
    const canvas = document.createElement('canvas');
    canvas.width = even(width);
    canvas.height = even(height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create the recording canvas.');

    const screenVideo = document.createElement('video');
    screenVideo.muted = true;
    screenVideo.playsInline = true;
    screenVideo.srcObject = screen;
    const camVideo = document.createElement('video');
    camVideo.muted = true;
    camVideo.playsInline = true;
    camVideo.srcObject = webcam;
    // Do not block the recorder on camera/screen warm-up. The draw loop fills
    // the canvas as soon as each video has frames.
    screenVideo.play().catch(() => undefined);
    camVideo.play().catch(() => undefined);

    let frame = 0;
    let lastDraw = -Infinity;
    const frameInterval = 1000 / Math.max(1, targetFps);
    const draw = (now: number): void => {
      if (!frame) return;
      if (now - lastDraw < frameInterval - 2) {
        frame = requestAnimationFrame(draw);
        return;
      }
      lastDraw = now;
      context.fillStyle = '#05070d';
      context.fillRect(0, 0, canvas.width, canvas.height);
      if (screenVideo.readyState >= 2 && screenVideo.videoWidth) {
        const scale = Math.min(canvas.width / screenVideo.videoWidth, canvas.height / screenVideo.videoHeight);
        const w = screenVideo.videoWidth * scale;
        const h = screenVideo.videoHeight * scale;
        context.drawImage(screenVideo, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      }
      if (camVideo.readyState >= 2 && camVideo.videoWidth) {
        const box = webcamRect(canvas.width, canvas.height);
        context.save();
        context.beginPath();
        const radius = Math.min(18, box.width * 0.08);
        if (typeof context.roundRect === 'function') context.roundRect(box.x, box.y, box.width, box.height, radius);
        else context.rect(box.x, box.y, box.width, box.height);
        context.clip();
        context.translate(box.x, box.y);
        if (camMirror.checked) {
          context.translate(box.width, 0);
          context.scale(-1, 1);
        }
        context.drawImage(camVideo, 0, 0, box.width, box.height);
        context.restore();
        context.strokeStyle = 'rgba(255,255,255,.75)';
        context.lineWidth = Math.max(2, canvas.width / 640);
        context.strokeRect(box.x, box.y, box.width, box.height);
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    let stream: MediaStream;
    try {
      stream = canvas.captureStream(targetFps);
    } catch (error) {
      cancelAnimationFrame(frame);
      frame = 0;
      screenVideo.srcObject = null;
      camVideo.srcObject = null;
      throw error;
    }
    compositor = {
      stream,
      cancel: () => {
        cancelAnimationFrame(frame);
        frame = 0;
        screenVideo.pause();
        screenVideo.srcObject = null;
        camVideo.pause();
        camVideo.srcObject = null;
      },
    };
    return stream;
  }

  async function begin(): Promise<void> {
    if (busy) return;
    const token = ++beginToken;
    let aborted = false;
    busy = true;
    updateButtons();
    clearResult();
    primeAudioContext();
    try {
      const format = formats.find((entry) => entry.mime === formatSelect.value) ?? formats[0];
      if (!format) throw new Error('This browser cannot record video with MediaRecorder.');
      const mime = format.mime;
      const targetFps = recorderFps(fps.value);
      const mode = source.value as 'screen' | 'screen-webcam' | 'camera';
      const targetResolution = recorderResolution(quality.value);
      // For a screen share, cap the capture size so selecting 4K cannot
      // upscale a smaller display. Cameras use `ideal` and pick a supported
      // mode at or below the requested size.
      const displayConstraints: MediaTrackConstraints = targetResolution
        ? {
          width: { max: targetResolution.width },
          height: { max: targetResolution.height },
          // `max` avoids capturing at the display's full rate and decimating
          // later, which is both CPU-heavy and slow to start.
          frameRate: { ideal: targetFps, max: targetFps },
        }
        : { frameRate: { ideal: targetFps, max: targetFps } };
      const cameraConstraints: MediaTrackConstraints = targetResolution
        ? {
          width: { ideal: targetResolution.width },
          height: { ideal: targetResolution.height },
          frameRate: { ideal: targetFps, max: targetFps },
        }
        : { frameRate: { ideal: targetFps, max: targetFps } };

      setStarting(
        mode === 'camera' ? 'Starting the camera' : 'Starting screen capture',
        mode === 'camera'
          ? 'The browser may pause this tab while it starts the camera.'
          : 'Choose a screen, window, or tab in the browser prompt. The browser may pause this tab for a moment after you click Share.',
      );
      let display: MediaStream;
      let pendingMic: Promise<MediaStream> | null = null;
      let pendingWebcam: Promise<MediaStream> | null = null;
      if (mode !== 'camera') {
        if (!navigator.mediaDevices?.getDisplayMedia) {
          throw new Error('Screen capture is not available in this browser. Try Chrome or Edge on desktop.');
        }
        setStatus('Choose a screen, window, or tab to share…');
        const displayOptions: MirrorSafeDisplayOptions = {
          video: displayConstraints,
          audio: system.checked,
          // Keep the recorder's own tab out of the tab picker, like a meeting
          // app does, so the preview cannot mirror itself indefinitely.
          selfBrowserSurface: 'exclude',
        };
        const displayPromise = navigator.mediaDevices.getDisplayMedia(displayOptions);
        // Make sure the exact current encoder envelope is warming while the
        // user chooses a source, even if they changed a setting and clicked
        // Start before the debounced background warm-up ran.
        if (warmupKey !== `${mime}|${targetFps}|${quality.value}|${bitrate.value}`) void warmUpEncoder();
        // When permission is already granted, start the auxiliary devices
        // while the picker is open so their setup overlaps the user's choice.
        const trackPending = (promise: Promise<MediaStream>): Promise<MediaStream> => promise.then((stream) => {
          if (aborted || beginToken !== token) {
            for (const track of stream.getTracks()) track.stop();
          } else {
            sources.push(stream);
          }
          return stream;
        });
        if (mic.checked && micPermission === 'granted') {
          pendingMic = trackPending(navigator.mediaDevices.getUserMedia({ audio: true }));
          pendingMic.catch(() => undefined);
        }
        if (mode === 'screen-webcam' && cameraPermission === 'granted') {
          pendingWebcam = trackPending(navigator.mediaDevices.getUserMedia({
            video: { ...cameraConstraints, facingMode: 'user' },
            audio: false,
          }));
          pendingWebcam.catch(() => undefined);
        }
        display = await displayPromise;
        if (token !== beginToken) {
          for (const track of display.getTracks()) track.stop();
          return;
        }
        setStarting('Preparing the capture', 'The browser is starting the shared source.');
        setStatus('Preparing the screen capture…');
      } else {
        setStatus('Starting the camera…');
        display = await navigator.mediaDevices.getUserMedia({
          video: { ...cameraConstraints, facingMode: 'user' },
          audio: mic.checked,
        });
      }
      sources.push(display);
      const screenSettings = display.getVideoTracks()[0]?.getSettings();
      const screenDetail = [
        screenSettings?.width && screenSettings?.height
          ? `${screenSettings.width} × ${screenSettings.height}`
          : '',
        screenSettings?.frameRate ? `${Math.round(screenSettings.frameRate)} fps` : '',
      ].filter(Boolean).join(' · ');
      let webcam: MediaStream | null = null;
      if (mode === 'screen-webcam') {
        setStarting('Starting the webcam', 'The browser may pause this tab while it starts the camera.');
        try {
          webcam = pendingWebcam
            ? await pendingWebcam
            : await navigator.mediaDevices.getUserMedia({
              video: { ...cameraConstraints, facingMode: 'user' },
              audio: false,
            });
          if (!pendingWebcam) sources.push(webcam);
        } catch {
          setStatus('Webcam permission was denied; recording the screen without the overlay.', 'error');
        }
      }
      if (mode !== 'camera' && mic.checked) {
        setStarting('Connecting the microphone', 'The browser may ask for permission or start the audio device.');
        setStatus('Connecting the microphone…');
        try {
          if (pendingMic) {
            await pendingMic;
          } else {
            sources.push(await navigator.mediaDevices.getUserMedia({ audio: true }));
          }
        } catch {
          setStatus('Microphone permission was denied; recording without it.', 'error');
        }
      }
      const audioTracks = await mixAudio(sources);
      let videoTracks = display.getVideoTracks();
      if (!videoTracks.length) throw new Error('The selected source did not provide a video track.');
      if (mode === 'screen-webcam' && webcam?.getVideoTracks().length) {
        videoTracks = (await startCompositor(display, webcam, targetFps)).getVideoTracks();
      }
      outputStream = new MediaStream([...videoTracks, ...audioTracks]);

      if (countdown.checked) {
        clearStarting();
        placeholder.classList.add('hidden');
        startCountdown.classList.remove('hidden');
        for (let seconds = 3; seconds > 0; seconds -= 1) {
          if (token !== beginToken) {
            stopSources();
            return;
          }
          startCountdownNumber.textContent = String(seconds);
          setStatus(`Recording in ${seconds}…`);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        startCountdown.classList.add('hidden');
      }
      if (token !== beginToken) {
        stopSources();
        return;
      }

      setStarting('Starting the video encoder', 'The browser may pause this tab while it prepares the encoder.');
      if (warmupTimer) {
        window.clearTimeout(warmupTimer);
        warmupTimer = 0;
      }
      if (warmupPromise) await warmupPromise;
      setStatus('Starting the video encoder…');
      // Let the status paint before MediaRecorder may block on a hardware
      // encoder start, so the wait is visible instead of a frozen old label.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      chunks = [];
      try {
        recorder = new MediaRecorder(outputStream, {
          mimeType: mime,
          videoBitsPerSecond: selectedVideoBitrate(),
          audioBitsPerSecond: 128_000,
        });
      } catch (error) {
        if (format.id === 'mp4-hevc') {
          throw new Error('This browser reported H.265 support but could not start it. Choose MP4 · H.264 or WebM instead.');
        }
        throw error;
      }
      activeFormat = format;
      activeFps = targetFps;
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size) chunks.push(event.data);
      });
      recorder.addEventListener('stop', () => void finish(mime));
      display.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (recorder && recorder.state !== 'inactive') stopRecording();
      });
      recorder.start(1000);
      startedAt = Date.now();
      pausedAt = 0;
      pausedTotal = 0;
      // Attach the full-resolution preview after the encoder has started so
      // the browser is not allocating GPU resources on the critical path.
      // Screen shares use a static guard instead of the live preview: showing
      // the captured screen inside itself creates an infinite mirror.
      clearStarting();
      placeholder.classList.add('hidden');
      if (mode === 'camera') {
        screenCaptureActive = false;
        screenPreviewVisible = false;
        previewToggle.classList.add('hidden');
        syncPreviewToggle();
        previewGuard.classList.add('hidden');
        showLivePreview();
      } else {
        screenCaptureActive = true;
        previewGuardDetail.textContent = screenDetail;
        previewToggle.classList.remove('hidden');
        setScreenPreviewVisible(false);
      }
      clearTicker();
      ticker = setInterval(() => {
        setTimer();
        updateButtons();
      }, 250);
      setTimer();
      setStatus('Recording locally. Use Stop when you are done.', 'good');
    } catch (error) {
      aborted = true;
      setStatus(error instanceof Error ? error.message : String(error), 'error');
      stopSources();
      recorder = null;
      startedAt = 0;
      updateButtons();
    } finally {
      busy = false;
      updateButtons();
    }
  }

  function stopRecording(): void {
    if (!recorder || recorder.state === 'inactive') return;
    try {
      recorder.stop();
    } catch {
      void finish(recorder.mimeType || 'video/webm');
    }
    clearTicker();
  }

  async function finish(mime: string): Promise<void> {
    let blob = new Blob(chunks, { type: mime });
    const duration = startedAt ? Math.max(0, (Date.now() - startedAt - pausedTotal) / 1000) : 0;
    chunks = [];
    stopSources();
    recorder = null;
    startedAt = 0;
    clearTicker();
    setTimer();
    updateButtons();
    if (!blob.size) {
      setStatus('No recording data was produced.', 'error');
      return;
    }
    if (mime.startsWith('video/webm') && duration > 0) {
      setStatus('Finalizing recording…');
      try {
        const { default: fixWebmDuration } = await import('fix-webm-duration');
        blob = await fixWebmDuration(blob, duration * 1000, { logger: false });
      } catch {
        // The raw WebM still plays; keep it if the duration patch fails.
      }
    }
    const type = blob.type || mime;
    resultBlob = blob;
    resultFile = new File([blob], recordingName(new Date(), type), { type });
    resultUrl = URL.createObjectURL(blob);
    result.src = resultUrl;
    resultBox.classList.remove('hidden');
    resultBadge.textContent = activeFormat?.label ?? recordingExtension(mime).toUpperCase();
    resultMeta.textContent = [
      resultFile.name,
      duration > 0.5 ? clockDuration(duration) : '',
      activeFps ? `${activeFps} fps` : '',
      sizeLabel(blob.size),
    ].filter(Boolean).join(' · ');
    setStatus('Recording saved in this tab. Download it, edit it, or transcribe it.', 'good');
  }

  source.addEventListener('change', updateButtons);
  start.addEventListener('click', () => void begin());
  pause.addEventListener('click', () => {
    if (!recorder) return;
    if (recorder.state === 'recording') {
      recorder.pause();
      pausedAt = Date.now();
      setStatus('Recording paused.', 'normal');
    } else if (recorder.state === 'paused') {
      pausedTotal += Date.now() - pausedAt;
      recorder.resume();
      setStatus('Recording resumed.', 'good');
    }
    updateButtons();
  });
  stop.addEventListener('click', stopRecording);
  previewToggle.addEventListener('click', () => {
    if (!screenCaptureActive) return;
    setScreenPreviewVisible(!screenPreviewVisible);
    setStatus(screenPreviewVisible
      ? 'Live preview shown. It may appear as a mirror in the recording.'
      : 'Live preview hidden to avoid a mirror.');
  });
  download.addEventListener('click', () => {
    if (resultBlob && resultFile) options.download(resultBlob, resultFile.name);
  });
  openEditor.addEventListener('click', () => {
    if (resultFile) options.openInEditor(resultFile);
  });
  transcribe.addEventListener('click', () => {
    if (resultFile) options.transcribe(resultFile);
  });

  quality.addEventListener('change', () => {
    syncBitrateLabel();
    scheduleWarmup(120);
  });
  fps.addEventListener('change', () => {
    syncBitrateLabel();
    scheduleWarmup(120);
  });
  bitrate.addEventListener('change', () => scheduleWarmup(120));
  formatSelect.addEventListener('change', () => scheduleWarmup(120));
  syncBitrateLabel();
  ensureAudioContext();
  scheduleWarmup(450);
  updateButtons();
  setTimer();

  return {
    activity(): { tone: 'busy' | 'ready' | 'warn'; label: string } | null {
      const state = recorder?.state;
      if (busy || state === 'recording' || state === 'paused') {
        return {
          tone: 'busy',
          label: state === 'paused' ? 'Screen recording paused' : 'Screen recording in progress',
        };
      }
      if (resultFile) return { tone: 'ready', label: 'Recording ready' };
      return null;
    },
    show(): void {
      updateButtons();
      primeAudioContext();
      scheduleWarmup(140);
    },
    pause(): void {
      beginToken += 1;
      if (recorder && recorder.state !== 'inactive') stopRecording();
      else {
        stopSources();
        clearTicker();
        startedAt = 0;
      }
    },
  };
}
