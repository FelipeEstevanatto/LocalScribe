/**
 * WebGPU preview compositor.
 *
 * Mirrors the WebGL2 shader pipeline in video-gl-preview.ts: transformed source
 * and CSS colour filters, a separable Gaussian blur, then chroma key, tone
 * table, 3D LUT, mask, motion reveal, opacity, and blend over black.
 *
 * The backend is deliberately optional. Any adapter, device, shader, or limit
 * failure disables it so the caller can use WebGL2 or the CSS preview.
 */

import { lutFingerprint, previewDrawRect } from './video-preview-plan';
import type {
  GlPreviewFrame,
  GlPreviewResult,
  PreviewFallbackReason,
} from './video-gl-preview';
import { toneTable, type BlendMode, type ClipEffects } from './video-effects';

export interface WebGpuPreviewOptions {
  onFallback?: (reason: PreviewFallbackReason) => void;
  onReady?: () => void;
  onFrameCaptured?: (signature: string, bitmap: ImageBitmap) => void;
}

export interface WebGpuPreview {
  readonly kind: 'webgpu';
  readonly canvas: HTMLCanvasElement;
  readonly active: boolean;
  readonly ready: Promise<boolean>;
  render(frame: GlPreviewFrame): GlPreviewResult;
  clear(): void;
  /** Resolve after the GPU has finished the last submitted frame. */
  whenIdle(): Promise<void>;
  dispose(): void;
}

const BLEND_INDEX: Record<BlendMode, number> = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  darken: 4,
  lighten: 5,
  'color-dodge': 6,
  'soft-light': 7,
};

const SOURCE_SHADER = `
struct SourceUniforms {
  stage: vec2f,
  size: vec2f,
  offset: vec2f,
  scale: vec2f,
  rotation: f32,
  brightness: f32,
  contrast: f32,
  saturation: f32,
  hue: f32,
  pad0: f32,
  pad1: f32,
  pad2: f32,
};
@group(0) @binding(0) var<uniform> u: SourceUniforms;
@group(0) @binding(1) var sourceTex: texture_2d<f32>;
@group(0) @binding(2) var sourceSampler: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) index: u32) -> VertexOut {
  var positions = array<vec2f, 4>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0)
  );
  let corner = positions[index];
  var point = corner * u.size * 0.5;
  point *= u.scale;
  let c = cos(u.rotation);
  let s = sin(u.rotation);
  point = mat2x2f(c, s, -s, c) * point;
  point += u.offset;
  let ndc = point / (u.stage * 0.5);
  var out: VertexOut;
  out.position = vec4f(ndc.x, -ndc.y, 0.0, 1.0);
  out.uv = corner * 0.5 + 0.5;
  return out;
}

fn hueRotate(color: vec3f, angle: f32) -> vec3f {
  let c = cos(angle);
  let s = sin(angle);
  let matrix = mat3x3f(
    0.213 + c * 0.787 - s * 0.213, 0.213 - c * 0.213 + s * 0.143, 0.213 - c * 0.213 - s * 0.787,
    0.715 - c * 0.715 - s * 0.715, 0.715 + c * 0.285 + s * 0.140, 0.715 - c * 0.715 + s * 0.715,
    0.072 - c * 0.072 + s * 0.928, 0.072 - c * 0.072 - s * 0.283, 0.072 + c * 0.928 + s * 0.072
  );
  return clamp(matrix * color, vec3f(0.0), vec3f(1.0));
}

@fragment
fn fs(in: VertexOut) -> @location(0) vec4f {
  let color = textureSampleLevel(sourceTex, sourceSampler, in.uv, 0.0);
  var rgb = color.rgb;
  rgb = clamp(rgb * u.brightness, vec3f(0.0), vec3f(1.0));
  rgb = clamp((rgb - vec3f(0.5)) * u.contrast + vec3f(0.5), vec3f(0.0), vec3f(1.0));
  let luma = dot(rgb, vec3f(0.213, 0.715, 0.072));
  rgb = clamp(mix(vec3f(luma), rgb, u.saturation), vec3f(0.0), vec3f(1.0));
  rgb = hueRotate(rgb, u.hue);
  return vec4f(rgb * color.a, color.a);
}
`;

const FULLSCREEN_VERTEX = `
struct FullscreenOut {
  @builtin(position) position: vec4f,
  @location(0) texUv: vec2f,
  @location(1) screenUv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) index: u32) -> FullscreenOut {
  var positions = array<vec2f, 4>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0)
  );
  let corner = positions[index];
  var out: FullscreenOut;
  out.position = vec4f(corner, 0.0, 1.0);
  out.texUv = vec2f(corner.x * 0.5 + 0.5, 0.5 - corner.y * 0.5);
  out.screenUv = out.texUv;
  return out;
}
`;

const BLUR_SHADER = `
struct BlurUniforms {
  texelDirection: vec4f,
  params: vec4f,
  weights: array<f32, 68>,
};
@group(0) @binding(0) var<uniform> u: BlurUniforms;
@group(0) @binding(1) var sourceTex: texture_2d<f32>;
@group(0) @binding(2) var sourceSampler: sampler;

${FULLSCREEN_VERTEX}

fn fetch(uv: vec2f) -> vec4f {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return vec4f(0.0);
  }
  return textureSampleLevel(sourceTex, sourceSampler, uv, 0.0);
}

@fragment
fn fs(in: FullscreenOut) -> @location(0) vec4f {
  let radius = i32(u.params.x);
  let spacing = u.params.y;
  var sum = fetch(in.texUv) * u.weights[0];
  for (var i: i32 = 1; i <= 64; i = i + 1) {
    if (i > radius) { break; }
    let offset = u.texelDirection.xy * u.texelDirection.zw * (f32(i) * spacing);
    sum += fetch(in.texUv + offset) * u.weights[u32(i)];
    sum += fetch(in.texUv - offset) * u.weights[u32(i)];
  }
  return sum;
}
`;

const MASK_SHADER = `
struct MaskUniforms {
  rect: vec4f,
  params: vec4f,
};
@group(0) @binding(0) var<uniform> u: MaskUniforms;

${FULLSCREEN_VERTEX}

@fragment
fn fs(in: FullscreenOut) -> @location(0) vec4f {
  var coverage = 0.0;
  let shape = i32(u.params.x);
  if (shape == 1) {
    let low = u.rect.xy;
    let high = low + u.rect.zw;
    if (in.screenUv.x >= low.x && in.screenUv.x <= high.x &&
        in.screenUv.y >= low.y && in.screenUv.y <= high.y) {
      coverage = 1.0;
    }
  } else if (shape == 2) {
    let center = u.rect.xy + u.rect.zw * 0.5;
    let radius = max(u.rect.zw * 0.5, vec2f(0.0001));
    let point = (in.screenUv - center) / radius;
    if (dot(point, point) <= 1.0) { coverage = 1.0; }
  }
  return vec4f(coverage);
}
`;

const FINISH_SHADER = `
struct FinishUniforms {
  maskRect: vec4f,
  reveal: vec4f,
  chroma: vec4f,
  lutParams: vec4f,
  featherOpacity: vec4f,
  softnessBlend: vec4f,
};
@group(0) @binding(0) var<uniform> u: FinishUniforms;
@group(0) @binding(1) var layerTex: texture_2d<f32>;
@group(0) @binding(2) var layerSampler: sampler;
@group(0) @binding(3) var toneTex: texture_2d<f32>;
@group(0) @binding(4) var toneSampler: sampler;
@group(0) @binding(5) var lutTex: texture_3d<f32>;
@group(0) @binding(6) var lutSampler: sampler;
@group(0) @binding(7) var maskTex: texture_2d<f32>;

${FULLSCREEN_VERTEX}

fn toneSample(value: f32) -> f32 {
  let index = floor(clamp(value, 0.0, 1.0) * 255.0 + 0.5);
  return textureSampleLevel(toneTex, toneSampler, vec2f((index + 0.5) / 256.0, 0.5), 0.0).r;
}

fn blendWithBlack(mode: i32, color: vec3f) -> vec3f {
  if (mode == 1 || mode == 3 || mode == 4 || mode == 6 || mode == 7) {
    return vec3f(0.0);
  }
  return color;
}

@fragment
fn fs(in: FullscreenOut) -> @location(0) vec4f {
  let layer = textureSampleLevel(layerTex, layerSampler, in.texUv, 0.0);
  var alpha = clamp(layer.a, 0.0, 1.0);
  var rgb = select(vec3f(0.0), clamp(layer.rgb / max(alpha, 0.0001), vec3f(0.0), vec3f(1.0)),
    alpha > 0.0001);

  if (u.lutParams.y > 0.5) {
    let delta = rgb - u.chroma.rgb;
    let distance = sqrt(delta.r * delta.r * 0.5 + delta.g * delta.g + delta.b * delta.b * 0.5);
    if (distance < u.chroma.w) {
      alpha = 0.0;
    } else if (distance < u.chroma.w + u.softnessBlend.x) {
      alpha *= (distance - u.chroma.w) / max(u.softnessBlend.x, 0.0001);
    }
  }

  if (u.lutParams.z > 0.5) {
    rgb = vec3f(toneSample(rgb.r), toneSample(rgb.g), toneSample(rgb.b));
  }

  if (u.lutParams.w > 0.5) {
    let size = u.lutParams.x;
    let coordinate = (clamp(rgb, vec3f(0.0), vec3f(1.0)) * (size - 1.0) + 0.5) / size;
    rgb = textureSampleLevel(lutTex, lutSampler, coordinate, 0.0).rgb;
  }

  if (u.softnessBlend.z > 0.5) {
    alpha *= textureSampleLevel(maskTex, layerSampler, in.texUv, 0.0).a;
  } else {
    let shape = i32(u.softnessBlend.w);
    if (shape == 1) {
      let fx = max(0.0001, u.featherOpacity.x / max(1.0, u.featherOpacity.y));
      let fy = max(0.0001, u.featherOpacity.x / max(1.0, u.featherOpacity.z));
      let left = smoothstep(u.maskRect.x - fx, u.maskRect.x + fx, in.screenUv.x);
      let right = 1.0 - smoothstep(u.maskRect.x + u.maskRect.z - fx,
        u.maskRect.x + u.maskRect.z + fx, in.screenUv.x);
      let top = smoothstep(u.maskRect.y - fy, u.maskRect.y + fy, in.screenUv.y);
      let bottom = 1.0 - smoothstep(u.maskRect.y + u.maskRect.w - fy,
        u.maskRect.y + u.maskRect.w + fy, in.screenUv.y);
      alpha *= left * right * top * bottom;
    } else if (shape == 2) {
      let center = u.maskRect.xy + u.maskRect.zw * 0.5;
      let radius = max(u.maskRect.zw * 0.5, vec2f(0.0001));
      let point = (in.screenUv - center) / radius;
      let distance = length(point);
      let feather = max(0.0001, u.featherOpacity.x /
        max(1.0, min(u.maskRect.z * u.featherOpacity.y, u.maskRect.w * u.featherOpacity.z) * 0.5));
      alpha *= 1.0 - smoothstep(1.0 - feather, 1.0 + feather, distance);
    }
  }

  alpha *= step(u.reveal.w, in.screenUv.x);
  alpha *= step(u.reveal.y, 1.0 - in.screenUv.x);
  alpha *= step(u.reveal.x, in.screenUv.y);
  alpha *= step(u.reveal.z, 1.0 - in.screenUv.y);
  alpha = clamp(alpha * u.featherOpacity.w, 0.0, 1.0);
  if (alpha <= 0.001) { return vec4f(0.0, 0.0, 0.0, 1.0); }

  let blended = blendWithBlack(i32(u.softnessBlend.y), rgb);
  return vec4f(blended * alpha, 1.0);
}
`;

const SOURCE_UNIFORM_SIZE = 64;
const BLUR_UNIFORM_SIZE = 304;
const MASK_UNIFORM_SIZE = 32;
const FINISH_UNIFORM_SIZE = 96;

function isVideo(source: HTMLVideoElement | HTMLImageElement): source is HTMLVideoElement {
  return typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement;
}

function sourceReady(source: HTMLVideoElement | HTMLImageElement): boolean {
  return isVideo(source)
    ? source.readyState >= 2 && source.videoWidth > 0 && source.videoHeight > 0
    : source.complete && source.naturalWidth > 0 && source.naturalHeight > 0;
}

function sourceTime(source: HTMLVideoElement | HTMLImageElement): number {
  return isVideo(source) ? source.currentTime : 0;
}

function gaussianKernel(sigma: number): { weights: Float32Array; radius: number; spacing: number } {
  const radius = Math.min(64, Math.max(1, Math.ceil(sigma * 3)));
  const spacing = Math.max(1, (sigma * 3) / radius);
  const weights = new Float32Array(68);
  let total = 0;
  for (let index = 0; index <= radius; index += 1) {
    const distance = (index * spacing) / sigma;
    const weight = Math.exp(-0.5 * distance * distance);
    weights[index] = weight;
    total += index === 0 ? weight : weight * 2;
  }
  for (let index = 0; index <= radius; index += 1) weights[index] /= Math.max(1e-8, total);
  return { weights, radius, spacing };
}

interface GpuState {
  adapter: GPUAdapter;
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  sourcePipeline: GPURenderPipeline;
  blurPipeline: GPURenderPipeline;
  maskPipeline: GPURenderPipeline;
  finishPipeline: GPURenderPipeline;
  sourceLayout: GPUBindGroupLayout;
  blurLayout: GPUBindGroupLayout;
  maskLayout: GPUBindGroupLayout;
  finishLayout: GPUBindGroupLayout;
  sourceUniform: GPUBuffer;
  blurUniformH: GPUBuffer;
  blurUniformV: GPUBuffer;
  maskBlurUniformH: GPUBuffer;
  maskBlurUniformV: GPUBuffer;
  maskUniform: GPUBuffer;
  finishUniform: GPUBuffer;
  linearSampler: GPUSampler;
  nearestSampler: GPUSampler;
  sourceTexture: GPUTexture | null;
  sourceWidth: number;
  sourceHeight: number;
  layerA: GPUTexture | null;
  layerB: GPUTexture | null;
  maskA: GPUTexture | null;
  maskB: GPUTexture | null;
  toneTexture: GPUTexture;
  lutTexture: GPUTexture;
  width: number;
  height: number;
}

function createTexture(
  device: GPUDevice,
  width: number,
  height: number,
  format: GPUTextureFormat,
  usage: GPUTextureUsageFlags,
): GPUTexture {
  return device.createTexture({
    size: { width, height, depthOrArrayLayers: 1 },
    format,
    usage,
    dimension: '2d',
  });
}

function createToneTexture(device: GPUDevice, curve: ClipEffects['curve']): GPUTexture {
  const texture = device.createTexture({
    size: { width: 256, height: 1, depthOrArrayLayers: 1 },
    format: 'r8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const table = new Uint8Array(toneTable(curve));
  device.queue.writeTexture(
    { texture },
    table,
    { bytesPerRow: 256 },
    { width: 256, height: 1, depthOrArrayLayers: 1 },
  );
  return texture;
}

function createDefaultLut(device: GPUDevice): GPUTexture {
  const texture = device.createTexture({
    size: { width: 1, height: 1, depthOrArrayLayers: 1 },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    dimension: '3d',
  });
  device.queue.writeTexture(
    { texture },
    new Uint8Array([0, 0, 0, 255]),
    { bytesPerRow: 4, rowsPerImage: 1 },
    { width: 1, height: 1, depthOrArrayLayers: 1 },
  );
  return texture;
}

function createLutTexture(device: GPUDevice, effects: ClipEffects): GPUTexture | null {
  const lut = effects.lut;
  if (!lut) return null;
  if (lut.size > device.limits.maxTextureDimension3D) return null;
  const texture = device.createTexture({
    size: { width: lut.size, height: lut.size, depthOrArrayLayers: lut.size },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    dimension: '3d',
  });
  const size = lut.size;
  const pixels = new Uint8Array(size ** 3 * 4);
  for (let index = 0; index < size ** 3; index += 1) {
    const source = index * 3;
    const target = index * 4;
    pixels[target] = Math.round(Math.max(0, Math.min(1, lut.data[source])) * 255);
    pixels[target + 1] = Math.round(Math.max(0, Math.min(1, lut.data[source + 1])) * 255);
    pixels[target + 2] = Math.round(Math.max(0, Math.min(1, lut.data[source + 2])) * 255);
    pixels[target + 3] = 255;
  }
  device.queue.writeTexture(
    { texture },
    pixels,
    { bytesPerRow: size * 4, rowsPerImage: size },
    { width: size, height: size, depthOrArrayLayers: size },
  );
  return texture;
}

export function createWebGpuPreview(
  stage: HTMLElement,
  options: WebGpuPreviewOptions = {},
): WebGpuPreview | null {
  if (typeof document === 'undefined' || typeof navigator === 'undefined' || !navigator.gpu) {
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.className = 'video-preview-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  const context = canvas.getContext('webgpu');
  if (!context) return null;

  let state: GpuState | null = null;
  let active = false;
  let disposed = false;
  let initializing = true;
  let lastSource: HTMLVideoElement | HTMLImageElement | null = null;
  let lastSourceUrl = '';
  let lastSourceTime = -1;
  let lastUploadWidth = 0;
  let lastUploadHeight = 0;
  let uploadCanvas: HTMLCanvasElement | null = null;
  let uploadContext: CanvasRenderingContext2D | null = null;
  let lastToneKey = '';
  let lastLutKey = '';
  let currentLutSize = 1;
  let fallbackNotified = false;

  const fail = (reason: PreviewFallbackReason): void => {
    if (!fallbackNotified) {
      fallbackNotified = true;
      options.onFallback?.(reason);
    }
    active = false;
    canvas.style.display = 'none';
  };

  const initialize = async (): Promise<boolean> => {
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) { fail('inactive'); return false; }
      const device = await adapter.requestDevice();
      if (disposed) { device.destroy(); return false; }
      const format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({
        device,
        format,
        alphaMode: 'opaque',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      device.lost.then(() => {
        if (!disposed) fail('context-lost');
      }).catch(() => undefined);

      const sourceModule = device.createShaderModule({ code: SOURCE_SHADER });
      const blurModule = device.createShaderModule({ code: BLUR_SHADER });
      const maskModule = device.createShaderModule({ code: MASK_SHADER });
      const finishModule = device.createShaderModule({ code: FINISH_SHADER });

      const sourceLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        ],
      });
      const blurLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        ],
      });
      const maskLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        ],
      });
      const finishLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '3d' } },
          { binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        ],
      });

      const sourcePipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [sourceLayout] }),
        vertex: { module: sourceModule, entryPoint: 'vs' },
        fragment: { module: sourceModule, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-strip' },
      });
      const blurPipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [blurLayout] }),
        vertex: { module: blurModule, entryPoint: 'vs' },
        fragment: { module: blurModule, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-strip' },
      });
      const maskPipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [maskLayout] }),
        vertex: { module: maskModule, entryPoint: 'vs' },
        fragment: { module: maskModule, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-strip' },
      });
      const finishPipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [finishLayout] }),
        vertex: { module: finishModule, entryPoint: 'vs' },
        fragment: { module: finishModule, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-strip' },
      });

      const sourceUniform = device.createBuffer({
        size: SOURCE_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const blurUniformH = device.createBuffer({
        size: BLUR_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const blurUniformV = device.createBuffer({
        size: BLUR_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const maskBlurUniformH = device.createBuffer({
        size: BLUR_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const maskBlurUniformV = device.createBuffer({
        size: BLUR_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const maskUniform = device.createBuffer({
        size: MASK_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const finishUniform = device.createBuffer({
        size: FINISH_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const linearSampler = device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
        addressModeW: 'clamp-to-edge',
      });
      const nearestSampler = device.createSampler({
        magFilter: 'nearest',
        minFilter: 'nearest',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
        addressModeW: 'clamp-to-edge',
      });
      const toneTexture = createToneTexture(device, { shadows: 0, midtones: 0, highlights: 0 });
      const lutTexture = createDefaultLut(device);
      state = {
        adapter, device, context, format,
        sourcePipeline, blurPipeline, maskPipeline, finishPipeline,
        sourceLayout, blurLayout, maskLayout, finishLayout,
        sourceUniform, blurUniformH, blurUniformV, maskBlurUniformH, maskBlurUniformV,
        maskUniform, finishUniform,
        linearSampler, nearestSampler,
        sourceTexture: null, sourceWidth: 0, sourceHeight: 0,
        layerA: null, layerB: null, maskA: null, maskB: null,
        toneTexture, lutTexture,
        width: 0, height: 0,
      };
      active = true;
      initializing = false;
      canvas.style.display = 'none';
      stage.append(canvas);
      options.onReady?.();
      return true;
    } catch (error) {
      console.warn('[video-preview] WebGPU initialization failed:', error);
      initializing = false;
      fail('inactive');
      return false;
    }
  };

  const ready = initialize();

  const ensureTextures = (width: number, height: number): boolean => {
    if (!state) return false;
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    if (state.width === width && state.height === height && state.layerA && state.layerB &&
      state.maskA && state.maskB) {
      return true;
    }
    state.layerA?.destroy();
    state.layerB?.destroy();
    state.maskA?.destroy();
    state.maskB?.destroy();
    state.layerA = createTexture(state.device, width, height, 'rgba8unorm', usage);
    state.layerB = createTexture(state.device, width, height, 'rgba8unorm', usage);
    state.maskA = createTexture(state.device, width, height, 'rgba8unorm', usage);
    state.maskB = createTexture(state.device, width, height, 'rgba8unorm', usage);
    state.width = width;
    state.height = height;
    return true;
  };

  const ensureSource = (source: HTMLVideoElement | HTMLImageElement): boolean => {
    if (!state) return false;
    const width = isVideo(source) ? source.videoWidth : source.naturalWidth;
    const height = isVideo(source) ? source.videoHeight : source.naturalHeight;
    if (!width || !height) return false;
    // Match the upload texture to the preview output instead of keeping a
    // full 4K source texture when the preview is 720p/1080p.
    const scale = Math.min(1, state.width / width, state.height / height);
    const uploadWidth = Math.max(1, Math.round(width * scale));
    const uploadHeight = Math.max(1, Math.round(height * scale));
    if (!state.sourceTexture || state.sourceWidth !== uploadWidth || state.sourceHeight !== uploadHeight) {
      state.sourceTexture?.destroy();
      state.sourceTexture = createTexture(
        state.device,
        uploadWidth,
        uploadHeight,
        'rgba8unorm',
        GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      );
      state.sourceWidth = uploadWidth;
      state.sourceHeight = uploadHeight;
      lastSource = null;
    }
    const currentUrl = source.currentSrc || source.src || '';
    const currentTime = sourceTime(source);
    if (source === lastSource && currentUrl === lastSourceUrl && currentTime === lastSourceTime &&
      uploadWidth === lastUploadWidth && uploadHeight === lastUploadHeight) {
      return true;
    }
    try {
      if (!uploadCanvas) {
        uploadCanvas = document.createElement('canvas');
        uploadContext = uploadCanvas.getContext('2d');
      }
      let uploadSource: CanvasImageSource = source;
      if (uploadContext) {
        if (uploadCanvas.width !== uploadWidth || uploadCanvas.height !== uploadHeight) {
          uploadCanvas.width = uploadWidth;
          uploadCanvas.height = uploadHeight;
        }
        uploadContext.clearRect(0, 0, uploadWidth, uploadHeight);
        uploadContext.drawImage(source, 0, 0, uploadWidth, uploadHeight);
        uploadSource = uploadCanvas;
      }
      state.device.queue.copyExternalImageToTexture(
        { source: uploadSource },
        { texture: state.sourceTexture },
        { width: uploadWidth, height: uploadHeight },
      );
      lastSource = source;
      lastSourceUrl = currentUrl;
      lastSourceTime = currentTime;
      lastUploadWidth = uploadWidth;
      lastUploadHeight = uploadHeight;
      return true;
    } catch {
      return false;
    }
  };

  const ensureTone = (effects: ClipEffects): void => {
    if (!state) return;
    const key = `${effects.curve.shadows}|${effects.curve.midtones}|${effects.curve.highlights}`;
    if (key === lastToneKey) return;
    lastToneKey = key;
    state.toneTexture.destroy();
    state.toneTexture = createToneTexture(state.device, effects.curve);
  };

  const ensureLut = (effects: ClipEffects): boolean => {
    if (!state) return false;
    if (!effects.lut) {
      if (lastLutKey !== 'none') {
        state.lutTexture.destroy();
        state.lutTexture = createDefaultLut(state.device);
        lastLutKey = 'none';
        currentLutSize = 1;
      }
      return true;
    }
    if (effects.lut.size > state.device.limits.maxTextureDimension3D) return false;
    const key = lutFingerprint(effects.lut);
    if (key === lastLutKey) return true;
    const created = createLutTexture(state.device, effects);
    if (!created) return false;
    state.lutTexture.destroy();
    state.lutTexture = created;
    lastLutKey = key;
    currentLutSize = effects.lut.size;
    return true;
  };

  const drawPass = (
    encoder: GPUCommandEncoder,
    pipeline: GPURenderPipeline,
    target: GPUTexture,
    bindGroup: GPUBindGroup,
    clear: boolean,
  ): void => {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: target.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: clear ? 0 : 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(4);
    pass.end();
  };

  const render = (frame: GlPreviewFrame): GlPreviewResult => {
    if (disposed) return { rendered: false, reason: 'inactive' };
    if (!active || !state) return { rendered: false, reason: initializing ? 'inactive' : 'context-lost' };
    if (!sourceReady(frame.source)) return { rendered: false, reason: 'source-not-ready' };
    const { plan } = frame;
    const width = Math.max(1, Math.round(plan.output.width));
    const height = Math.max(1, Math.round(plan.output.height));
    if (!ensureTextures(width, height)) return { rendered: false, reason: 'render-target' };
    if (!ensureSource(frame.source)) return { rendered: false, reason: 'source-not-ready' };
    if (!ensureLut(plan.effects)) return { rendered: false, reason: 'lut-too-large' };
    ensureTone(plan.effects);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      state.context.configure({
        device: state.device,
        format: state.format,
        alphaMode: 'opaque',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
    }

    const draw = previewDrawRect(plan);
    const effects = plan.effects;
    const sourceData = new Float32Array(16);
    sourceData.set([
      plan.stage.width, plan.stage.height,
      draw.width, draw.height,
      (plan.transform.x / 100) * plan.stage.width, (plan.transform.y / 100) * plan.stage.height,
      plan.transform.scale * plan.transform.scaleX, plan.transform.scale * plan.transform.scaleY,
      (plan.transform.rotation * Math.PI) / 180,
      (100 + effects.brightness) / 100,
      (100 + effects.contrast) / 100,
      (100 + effects.saturation) / 100,
      (effects.hue * Math.PI) / 180,
      0, 0, 0,
    ]);
    state.device.queue.writeBuffer(state.sourceUniform, 0, sourceData);

    const sourceBind = state.device.createBindGroup({
      layout: state.sourceLayout,
      entries: [
        { binding: 0, resource: { buffer: state.sourceUniform } },
        { binding: 1, resource: state.sourceTexture!.createView() },
        { binding: 2, resource: state.linearSampler },
      ],
    });

    const encoder = state.device.createCommandEncoder();
    drawPass(encoder, state.sourcePipeline, state.layerA!, sourceBind, true);

    const sigma = effects.blur * plan.stage.dpr;
    if (sigma > 0.35 && state.layerA && state.layerB) {
      const { weights, radius, spacing } = gaussianKernel(sigma);
      const horizontalData = new Float32Array(76);
      horizontalData.set([1 / width, 1 / height, 1, 0]);
      horizontalData.set([radius, spacing, 0, 0], 4);
      horizontalData.set(weights, 8);
      state.device.queue.writeBuffer(state.blurUniformH, 0, horizontalData);
      const verticalData = new Float32Array(horizontalData);
      verticalData.set([1 / width, 1 / height, 0, 1]);
      state.device.queue.writeBuffer(state.blurUniformV, 0, verticalData);

      const horizontal = state.device.createBindGroup({
        layout: state.blurLayout,
        entries: [
          { binding: 0, resource: { buffer: state.blurUniformH } },
          { binding: 1, resource: state.layerA.createView() },
          { binding: 2, resource: state.linearSampler },
        ],
      });
      drawPass(encoder, state.blurPipeline, state.layerB, horizontal, true);

      const vertical = state.device.createBindGroup({
        layout: state.blurLayout,
        entries: [
          { binding: 0, resource: { buffer: state.blurUniformV } },
          { binding: 1, resource: state.layerB.createView() },
          { binding: 2, resource: state.linearSampler },
        ],
      });
      drawPass(encoder, state.blurPipeline, state.layerA, vertical, true);
    }

    const mask = effects.mask;
    let maskTextureUsed = false;
    if (mask.shape !== 'none' && mask.feather > 0 && state.maskA && state.maskB) {
      const maskData = new Float32Array(8);
      maskData.set([mask.x / 100, mask.y / 100, mask.width / 100, mask.height / 100]);
      maskData.set([mask.shape === 'rect' ? 1 : 2, 0, 0, 0], 4);
      state.device.queue.writeBuffer(state.maskUniform, 0, maskData);
      const maskBind = state.device.createBindGroup({
        layout: state.maskLayout,
        entries: [{ binding: 0, resource: { buffer: state.maskUniform } }],
      });
      drawPass(encoder, state.maskPipeline, state.maskA, maskBind, true);

      const featherPx = (mask.feather / 100) * Math.min(width, height);
      const { weights, radius, spacing } = gaussianKernel(featherPx);
      const horizontalData = new Float32Array(76);
      horizontalData.set([1 / width, 1 / height, 1, 0]);
      horizontalData.set([radius, spacing, 0, 0], 4);
      horizontalData.set(weights, 8);
      state.device.queue.writeBuffer(state.maskBlurUniformH, 0, horizontalData);
      const verticalData = new Float32Array(horizontalData);
      verticalData.set([1 / width, 1 / height, 0, 1]);
      state.device.queue.writeBuffer(state.maskBlurUniformV, 0, verticalData);
      const horizontal = state.device.createBindGroup({
        layout: state.blurLayout,
        entries: [
          { binding: 0, resource: { buffer: state.maskBlurUniformH } },
          { binding: 1, resource: state.maskA.createView() },
          { binding: 2, resource: state.linearSampler },
        ],
      });
      drawPass(encoder, state.blurPipeline, state.maskB, horizontal, true);
      const vertical = state.device.createBindGroup({
        layout: state.blurLayout,
        entries: [
          { binding: 0, resource: { buffer: state.maskBlurUniformV } },
          { binding: 1, resource: state.maskB.createView() },
          { binding: 2, resource: state.linearSampler },
        ],
      });
      drawPass(encoder, state.blurPipeline, state.maskA, vertical, true);
      maskTextureUsed = true;
    }

    const finishData = new Float32Array(24);
    finishData.set([mask.x / 100, mask.y / 100, mask.width / 100, mask.height / 100]);
    const reveal = plan.motion.reveal;
    finishData.set([
      reveal ? reveal.top / 100 : 0,
      reveal ? reveal.right / 100 : 0,
      reveal ? reveal.bottom / 100 : 0,
      reveal ? reveal.left / 100 : 0,
    ], 4);
    const chroma = effects.chroma.color.replace('#', '');
    finishData.set([
      Number.parseInt(chroma.slice(0, 2), 16) / 255,
      Number.parseInt(chroma.slice(2, 4), 16) / 255,
      Number.parseInt(chroma.slice(4, 6), 16) / 255,
      effects.chroma.tolerance,
    ], 8);
    finishData.set([
      effects.lut ? effects.lut.size : currentLutSize,
      effects.chroma.enabled ? 1 : 0,
      effects.curve.shadows || effects.curve.midtones || effects.curve.highlights ? 1 : 0,
      effects.lut ? 1 : 0,
    ], 12);
    finishData.set([
      (mask.feather / 100) * Math.min(width, height),
      width,
      height,
      plan.opacity,
    ], 16);
    finishData.set([
      Math.max(0.0001, effects.chroma.softness),
      BLEND_INDEX[effects.blend] ?? 0,
      maskTextureUsed ? 1 : 0,
      mask.shape === 'rect' ? 1 : mask.shape === 'ellipse' ? 2 : 0,
    ], 20);
    state.device.queue.writeBuffer(state.finishUniform, 0, finishData);

    const finishBind = state.device.createBindGroup({
      layout: state.finishLayout,
      entries: [
        { binding: 0, resource: { buffer: state.finishUniform } },
        { binding: 1, resource: state.layerA!.createView() },
        { binding: 2, resource: state.linearSampler },
        { binding: 3, resource: state.toneTexture.createView() },
        { binding: 4, resource: state.nearestSampler },
        { binding: 5, resource: state.lutTexture.createView({ dimension: '3d' }) },
        { binding: 6, resource: state.linearSampler },
        { binding: 7, resource: (maskTextureUsed ? state.maskA! : state.layerA!).createView() },
      ],
    });

    const swapchain = state.context.getCurrentTexture();
    drawPass(encoder, state.finishPipeline, swapchain, finishBind, false);
    let readback: {
      buffer: GPUBuffer;
      bytesPerRow: number;
      width: number;
      height: number;
      swapRedBlue: boolean;
    } | null = null;
    if (frame.capture && options.onFrameCaptured) {
      const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
      const buffer = state.device.createBuffer({
        size: bytesPerRow * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      encoder.copyTextureToBuffer(
        { texture: swapchain },
        { buffer, bytesPerRow, rowsPerImage: height },
        { width, height, depthOrArrayLayers: 1 },
      );
      readback = {
        buffer,
        bytesPerRow,
        width,
        height,
        swapRedBlue: state.format === 'bgra8unorm' || state.format === 'bgra8unorm-srgb',
      };
    }
    state.device.queue.submit([encoder.finish()]);
    if (readback) {
      const data = readback;
      void data.buffer.mapAsync(GPUMapMode.READ).then(() => {
        const source = new Uint8Array(data.buffer.getMappedRange());
        const flipped = new Uint8ClampedArray(data.width * data.height * 4);
        const rowBytes = data.width * 4;
        for (let row = 0; row < data.height; row += 1) {
          const start = row * data.bytesPerRow;
          const target = row * rowBytes;
          flipped.set(source.subarray(start, start + rowBytes), target);
          if (data.swapRedBlue) {
            for (let index = 0; index < rowBytes; index += 4) {
              const red = flipped[target + index];
              flipped[target + index] = flipped[target + index + 2];
              flipped[target + index + 2] = red;
            }
          }
        }
        data.buffer.unmap();
        data.buffer.destroy();
        return createImageBitmap(new ImageData(flipped, data.width, data.height));
      }).then((bitmap) => {
        options.onFrameCaptured?.(plan.signature, bitmap);
      }).catch(() => {
        data.buffer.destroy();
      });
    }
    canvas.style.display = 'block';
    return { rendered: true };
  };

  return {
    kind: 'webgpu',
    canvas,
    get active() { return active && !disposed; },
    ready,
    render,
    whenIdle(): Promise<void> {
      return state ? state.device.queue.onSubmittedWorkDone() : Promise.resolve();
    },
    clear(): void {
      canvas.style.display = 'none';
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      active = false;
      if (state) {
        state.layerA?.destroy();
        state.layerB?.destroy();
        state.maskA?.destroy();
        state.maskB?.destroy();
        state.sourceTexture?.destroy();
        state.toneTexture.destroy();
        state.lutTexture.destroy();
        state.sourceUniform.destroy();
        state.blurUniformH.destroy();
        state.blurUniformV.destroy();
        state.maskBlurUniformH.destroy();
        state.maskBlurUniformV.destroy();
        state.maskUniform.destroy();
        state.finishUniform.destroy();
        state.device.destroy();
        state = null;
      }
      canvas.remove();
    },
  };
}
