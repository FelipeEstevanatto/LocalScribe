import { type AudioFfmpeg, type MediaProbe, type RunOptions, audioInputName } from './audio-ffmpeg';
import { seconds, type Size } from './quick-video';

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'tiff' | 'gif';
export const IMAGE_FORMATS: ImageFormat[] = ['png', 'jpeg', 'webp', 'gif', 'tiff'];
export const MAX_PIXELS = 32_000_000;

export function canvasFor({ width, height }: Size): HTMLCanvasElement {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
    width > 8192 || height > 8192 || width * height > MAX_PIXELS) {
    throw new Error('Choose dimensions up to 8192 px per side and 32 megapixels total.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export async function decodeImage(file: Blob, ffmpeg: AudioFfmpeg, signal?: AbortSignal): Promise<ImageBitmap> {
  try {
    const bitmap = await createImageBitmap(file);
    if (signal?.aborted) { bitmap.close(); signal.throwIfAborted(); }
    return bitmap;
  } catch {
    signal?.throwIfAborted();
    const png = await ffmpeg.run(file, ['-i', 'input.media', '-frames:v', '1', '-c:v', 'png', 'source.png'], 'source.png', 'image/png', signal);
    const bitmap = await createImageBitmap(png);
    if (signal?.aborted) { bitmap.close(); signal.throwIfAborted(); }
    return bitmap;
  }
}

export function toBlob(canvas: HTMLCanvasElement, mime = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob || blob.type !== mime) reject(new Error('This browser has no ' + mime + ' encoder.'));
      else resolve(blob);
    }, mime, quality);
  });
}

export async function encodeImage(canvas: HTMLCanvasElement, format: ImageFormat, quality: number, ffmpeg: AudioFfmpeg, signal?: AbortSignal): Promise<Blob> {
  if (format === 'gif' || format === 'tiff') {
    const png = await toBlob(canvas);
    const output = 'result.' + format;
    const filters = format === 'gif' ? ['-vf', 'format=rgb8', '-loop', '-1'] : [];
    return ffmpeg.run(png, ['-i', 'input.media', ...filters, '-frames:v', '1', output], output, 'image/' + format, signal);
  }
  return toBlob(canvas, 'image/' + format, quality / 100);
}

export interface Watermark {
  text: string; logo?: CanvasImageSource; position: string; size: number;
  opacity: number; margin: number; tile: boolean;
}

export function drawWatermark(context: CanvasRenderingContext2D, width: number, height: number, mark: Watermark): void {
  context.save();
  context.globalAlpha = mark.opacity;
  const scale = Math.min(width, height);
  const size = scale * mark.size;
  const margin = Math.min(scale * mark.margin, scale * 0.4);
  context.font = `600 ${Math.max(8, size)}px system-ui, sans-serif`;
  context.textBaseline = 'middle';
  context.fillStyle = 'white';
  context.shadowColor = '#0009';
  context.shadowBlur = Math.max(1, size / 12);
  const textWidth = Math.min(width - 2 * margin, context.measureText(mark.text).width);
  const logo = mark.logo;
  const logoRatio = logo instanceof ImageBitmap ? logo.width / logo.height : 1;
  const h = logo ? Math.min(size * 1.5, (width - margin * 2) / logoRatio, height - margin * 2) : size * 1.25;
  const w = logo ? h * logoRatio : textWidth;
  const stamp = (x: number, y: number) => {
    if (logo) context.drawImage(logo, x, y, w, h);
    else context.fillText(mark.text, x, y + h / 2, w);
  };
  if (mark.tile) {
    const cellWidth = width / 3, cellHeight = height / 3;
    const ratio = Math.min(1, (cellWidth * 0.9) / Math.max(1, w), (cellHeight * 0.9) / Math.max(1, h));
    for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
      context.save();
      context.translate(cellWidth * (col + 0.5) - (w * ratio) / 2, cellHeight * (row + 0.5) - (h * ratio) / 2);
      context.scale(ratio, ratio);
      stamp(0, 0);
      context.restore();
    }
  } else {
    const [vertical, horizontal] = mark.position.split('-');
    const x = horizontal === 'left' ? margin : horizontal === 'right' ? width - w - margin : (width - w) / 2;
    const y = vertical === 'top' ? margin : vertical === 'bottom' ? height - h - margin : (height - h) / 2;
    stamp(x, y);
  }
  context.restore();
}

export function drawGrid(context: CanvasRenderingContext2D, width: number, height: number, rows: number, columns: number,
  color: string, line: number, opacity: number, labels: boolean): void {
  const cellW = width / columns, cellH = height / rows;
  context.save();
  context.strokeStyle = context.fillStyle = color;
  context.globalAlpha = opacity;
  context.lineWidth = line;
  context.beginPath();
  for (let i = 1; i < rows; i++) {
    context.moveTo(0, i * cellH); context.lineTo(width, i * cellH);
  }
  for (let i = 1; i < columns; i++) {
    context.moveTo(i * cellW, 0); context.lineTo(i * cellW, height);
  }
  context.stroke();
  if (labels) {
    context.textBaseline = 'top';
    context.font = `600 ${Math.max(4, Math.min(cellW, cellH) * 0.18)}px system-ui`;
    for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) {
      let letters = '';
      for (let value = c + 1; value > 0; value = Math.floor((value - 1) / 26)) {
        letters = String.fromCharCode(65 + ((value - 1) % 26)) + letters;
      }
      context.fillText(letters + (r + 1), c * cellW + cellW * 0.08, r * cellH + cellH * 0.08, cellW * 0.86);
    }
  }
  context.restore();
}

export interface Layer {
  file: File;
  source: ImageBitmap | HTMLVideoElement;
  url?: string;
  probe?: MediaProbe;
  x: number; y: number; width: number; height: number;
  left: number; right: number; top: number; bottom: number;
  radius: number;
  end: 'freeze' | 'loop';
}

export function drawLayer(context: CanvasRenderingContext2D, layer: Layer, size: Size): void {
  const { source } = layer;
  const sw = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
  const sh = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
  if (!sw || !sh) return;
  const x = layer.x * size.width, y = layer.y * size.height;
  const width = layer.width * size.width, height = layer.height * size.height;
  const l = sw * layer.left, t = sh * layer.top;
  context.save();
  context.beginPath();
  context.roundRect(x, y, width, height, Math.min(width, height) * layer.radius);
  context.clip();
  context.drawImage(source, l, t, sw * (1 - layer.left - layer.right), sh * (1 - layer.top - layer.bottom), x, y, width, height);
  context.restore();
}

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
const pixel = (value: number) => Math.round(value);

export async function renderVideoCollage(ffmpeg: AudioFfmpeg, layers: Layer[], size: Size, color: string, transparent: boolean,
  audio: Layer | undefined, signal: AbortSignal, onProgress: RunOptions['onProgress']): Promise<Blob> {
  if (!layers.length) throw new Error('Add a video first.');
  const duration = Math.max(...layers.map(layer => layer.probe!.duration));
  const fps = Math.min(30, Math.max(15, Math.round(Math.max(...layers.map(layer => layer.probe!.fps || 24)))));
  const args: string[] = [];
  const inputs: Blob[] = [];
  const graph: string[] = [`color=c=${transparent ? 'black@0' : color.replace('#', '0x')}:s=${size.width}x${size.height}:r=${fps}:d=${seconds(duration)},format=yuva420p[base]`];
  let previous = 'base';
  let audioInput: number | undefined;
  for (const [index, layer] of layers.entries()) {
    const input = inputs.length;
    const loop = layer.end === 'loop' && layer.probe!.duration < duration;
    args.push(...(loop ? ['-stream_loop', '-1'] : []), '-i', audioInputName(input));
    inputs.push(layer.file);
    if (audio === layer && layer.probe?.hasAudio) audioInput = input;
    const width = even(layer.width * size.width), height = even(layer.height * size.height);
    const filters = [`crop=iw*${seconds(1 - layer.left - layer.right)}:ih*${seconds(1 - layer.top - layer.bottom)}:iw*${seconds(layer.left)}:ih*${seconds(layer.top)}`,
      `scale=${width}:${height}`, 'setsar=1', 'setpts=PTS-STARTPTS', `fps=${fps}`];
    if (layer.radius) {
      const mask = canvasFor({ width, height });
      const context = mask.getContext('2d')!;
      context.fillStyle = 'black'; context.fillRect(0, 0, width, height);
      context.fillStyle = 'white'; context.beginPath();
      context.roundRect(0, 0, width, height, Math.min(width, height) * layer.radius); context.fill();
      args.push('-i', audioInputName(inputs.length));
      inputs.push(await toBlob(mask));
      graph.push(`[${inputs.length - 1}:v]format=gray[mask${index}]`);
      graph.push(`[${input}:v]${filters.join(',')}[tile${index}];[tile${index}][mask${index}]alphamerge[layer${index}]`);
    } else graph.push(`[${input}:v]${filters.join(',')}[layer${index}]`);
    const name = 'stage' + index;
    graph.push(`[${previous}][layer${index}]overlay=x=${pixel(layer.x * size.width)}:y=${pixel(layer.y * size.height)}:format=auto:repeatlast=1[${name}]`);
    previous = name;
  }
  const output = transparent ? 'collage.webm' : 'collage.mp4';
  args.push('-filter_complex', graph.join(';'), '-map', `[${previous}]`, '-t', seconds(duration));
  if (audioInput === undefined) args.push('-an');
  else args.push('-map', `${audioInput}:a:0`);
  args.push(...(transparent ? ['-c:v', 'libvpx', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-crf', '12', '-b:v', '3M', '-deadline', 'good', '-cpu-used', '5', '-c:a', 'libvorbis']
    : ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-c:a', 'aac', '-movflags', '+faststart']), output);
  return ffmpeg.run(inputs, args, output, transparent ? 'video/webm' : 'video/mp4', { signal, duration, onProgress });
}
