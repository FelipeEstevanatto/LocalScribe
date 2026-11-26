/**
 * WebGL2 preview compositor.
 *
 * Pipeline:
 *   1. transformed source + CSS colour filters into an RGBA layer target
 *   2. optional separable Gaussian blur (towards the exporter's canvas blur)
 *   3. chroma key, tone table, 3D LUT, mask, motion reveal, opacity, blend
 *
 * The colour, chroma, tone, LUT, and mask math mirrors video-effects.ts /
 * video-export.ts. Unsupported limits return a fallback reason instead of
 * displaying a different picture.
 */

import { toneTable, type BlendMode, type ClipEffects } from './video-effects';
import { lutFingerprint, previewDrawRect, type PreviewFramePlan } from './video-preview-plan';

export type PreviewFallbackReason =
  | 'inactive'
  | 'source-not-ready'
  | 'render-target'
  | 'lut-too-large'
  | 'context-lost';

export interface GlPreviewFrame {
  plan: PreviewFramePlan;
  source: HTMLVideoElement | HTMLImageElement;
  /** Read the finished frame back for the bounded render cache. */
  capture?: boolean;
}

export interface GlPreviewResult {
  rendered: boolean;
  reason?: PreviewFallbackReason;
}

export interface GlPreviewOptions {
  /** Tests and frame capture need to read the drawing buffer after render. */
  preserveDrawingBuffer?: boolean;
  onFallback?: (reason: PreviewFallbackReason) => void;
  onFrameCaptured?: (signature: string, bitmap: ImageBitmap) => void;
}

export interface GlPreview {
  readonly kind: 'webgl';
  readonly canvas: HTMLCanvasElement;
  readonly active: boolean;
  render(frame: GlPreviewFrame): GlPreviewResult;
  clear(): void;
  /** Resolve after the GPU has finished the last submitted frame. */
  whenIdle(): Promise<void>;
  dispose(): void;
}

const VERTEX_SOURCE = `#version 300 es
layout(location = 0) in vec2 aPos;
uniform vec2 uStage;
uniform vec2 uSize;
uniform vec2 uOffset;
uniform vec2 uScale;
uniform float uRotation;
out vec2 vUv;
void main() {
  vec2 p = aPos * uSize * 0.5;
  p *= uScale;
  float c = cos(uRotation);
  float s = sin(uRotation);
  p = mat2(c, s, -s, c) * p;
  p += uOffset;
  vec2 ndc = p / (uStage * 0.5);
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  vUv = aPos * 0.5 + 0.5;
}`;

const VERTEX_FULLSCREEN = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vTexUv;
out vec2 vScreenUv;
void main() {
  vTexUv = aPos * 0.5 + 0.5;
  vScreenUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSource;
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform float uHue;
layout(location = 0) out vec4 outColor;

const vec3 LUMA = vec3(0.213, 0.715, 0.072);

vec3 hueRotate(vec3 color, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  mat3 matrix = transpose(mat3(
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072
  ));
  return clamp(matrix * color, 0.0, 1.0);
}

void main() {
  vec4 color = texture(uSource, vUv);
  vec3 rgb = color.rgb;
  rgb = clamp(rgb * uBrightness, 0.0, 1.0);
  rgb = clamp((rgb - 0.5) * uContrast + 0.5, 0.0, 1.0);
  float luma = dot(rgb, LUMA);
  rgb = clamp(mix(vec3(luma), rgb, uSaturation), 0.0, 1.0);
  rgb = hueRotate(rgb, uHue);
  // Keep the layer premultiplied so separable blur and the zero border behave
  // like Canvas2D's premultiplied filter pipeline.
  outColor = vec4(rgb * color.a, color.a);
}`;

const FRAGMENT_BLUR = `#version 300 es
precision highp float;
in vec2 vTexUv;
in vec2 vScreenUv;
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform vec2 uDirection;
uniform float uWeights[65];
uniform int uRadius;
uniform float uSpacing;
layout(location = 0) out vec4 outColor;

vec4 fetch(vec2 uv) {
  // The layer is premultiplied, so transparent pixels outside the surface
  // contribute zero exactly like Canvas2D's filter source.
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
  return texture(uSource, uv);
}

void main() {
  vec4 sum = fetch(vTexUv) * uWeights[0];
  for (int i = 1; i <= 64; i++) {
    if (i > uRadius) break;
    vec2 offset = uDirection * uTexel * (float(i) * uSpacing);
    sum += fetch(vTexUv + offset) * uWeights[i];
    sum += fetch(vTexUv - offset) * uWeights[i];
  }
  outColor = sum;
}`;

const FRAGMENT_MASK = `#version 300 es
precision highp float;
in vec2 vScreenUv;
uniform int uMaskShape;
uniform vec4 uMaskRect;
layout(location = 0) out vec4 outColor;
void main() {
  float coverage = 0.0;
  if (uMaskShape == 1) {
    vec2 low = uMaskRect.xy;
    vec2 high = low + uMaskRect.zw;
    if (vScreenUv.x >= low.x && vScreenUv.x <= high.x &&
        vScreenUv.y >= low.y && vScreenUv.y <= high.y) coverage = 1.0;
  } else if (uMaskShape == 2) {
    vec2 center = uMaskRect.xy + uMaskRect.zw * 0.5;
    vec2 radius = max(uMaskRect.zw * 0.5, vec2(0.0001));
    vec2 point = (vScreenUv - center) / radius;
    if (dot(point, point) <= 1.0) coverage = 1.0;
  }
  outColor = vec4(coverage);
}`;

const FRAGMENT_FINISH = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vTexUv;
in vec2 vScreenUv;
uniform sampler2D uLayer;
uniform sampler2D uTone;
uniform sampler3D uLut;
uniform bool uHasTone;
uniform bool uHasLut;
uniform float uLutSize;
uniform bool uChroma;
uniform vec3 uChromaColor;
uniform float uTolerance;
uniform float uSoftness;
uniform float uOpacity;
uniform int uMaskShape;
uniform vec4 uMaskRect;
uniform float uFeatherPx;
uniform vec2 uStagePx;
uniform sampler2D uMaskTexture;
uniform bool uHasMaskTexture;
uniform vec4 uReveal;
uniform int uBlend;
layout(location = 0) out vec4 outColor;

float toneSample(float value) {
  float index = floor(clamp(value, 0.0, 1.0) * 255.0 + 0.5);
  return texture(uTone, vec2((index + 0.5) / 256.0, 0.5)).r;
}

vec3 blendWithBlack(int mode, vec3 sourceColor) {
  // Canvas2D composites every blend mode over the black stage fill. For black
  // backdrop, only normal, screen, and lighten are not zero.
  if (mode == 1 || mode == 3 || mode == 4 || mode == 6 || mode == 7) return vec3(0.0);
  return sourceColor;
}

void main() {
  vec4 layer = texture(uLayer, vTexUv);
  float alpha = clamp(layer.a, 0.0, 1.0);
  vec3 rgb = alpha > 0.0001 ? clamp(layer.rgb / alpha, 0.0, 1.0) : vec3(0.0);

  if (uChroma) {
    vec3 delta = rgb - uChromaColor;
    float distance = sqrt(delta.r * delta.r * 0.5 + delta.g * delta.g + delta.b * delta.b * 0.5);
    if (distance < uTolerance) {
      alpha = 0.0;
    } else if (distance < uTolerance + uSoftness) {
      alpha *= (distance - uTolerance) / max(uSoftness, 0.0001);
    }
  }

  if (uHasTone) {
    rgb = vec3(toneSample(rgb.r), toneSample(rgb.g), toneSample(rgb.b));
  }

  if (uHasLut) {
    vec3 coordinate = (clamp(rgb, 0.0, 1.0) * (uLutSize - 1.0) + 0.5) / uLutSize;
    rgb = texture(uLut, coordinate).rgb;
  }

  if (uHasMaskTexture) {
    alpha *= texture(uMaskTexture, vTexUv).a;
  } else if (uMaskShape == 1) {
    float featherX = max(0.0001, uFeatherPx / max(1.0, uStagePx.x));
    float featherY = max(0.0001, uFeatherPx / max(1.0, uStagePx.y));
    float left = smoothstep(uMaskRect.x - featherX, uMaskRect.x + featherX, vScreenUv.x);
    float right = 1.0 - smoothstep(uMaskRect.x + uMaskRect.z - featherX,
      uMaskRect.x + uMaskRect.z + featherX, vScreenUv.x);
    float top = smoothstep(uMaskRect.y - featherY, uMaskRect.y + featherY, vScreenUv.y);
    float bottom = 1.0 - smoothstep(uMaskRect.y + uMaskRect.w - featherY,
      uMaskRect.y + uMaskRect.w + featherY, vScreenUv.y);
    alpha *= left * right * top * bottom;
  } else if (uMaskShape == 2) {
    vec2 center = uMaskRect.xy + uMaskRect.zw * 0.5;
    vec2 radius = max(uMaskRect.zw * 0.5, vec2(0.0001));
    vec2 point = (vScreenUv - center) / radius;
    float distance = length(point);
    float feather = max(0.0001, uFeatherPx /
      max(1.0, min(uMaskRect.z * uStagePx.x, uMaskRect.w * uStagePx.y) * 0.5));
    alpha *= 1.0 - smoothstep(1.0 - feather, 1.0 + feather, distance);
  }

  alpha *= step(uReveal.w, vScreenUv.x);
  alpha *= step(uReveal.y, 1.0 - vScreenUv.x);
  alpha *= step(uReveal.x, vScreenUv.y);
  alpha *= step(uReveal.z, 1.0 - vScreenUv.y);
  alpha = clamp(alpha * uOpacity, 0.0, 1.0);

  if (alpha <= 0.001) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec3 blended = blendWithBlack(uBlend, rgb);
  outColor = vec4(blended * alpha, 1.0);
}`;

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

interface ProgramInfo {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

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

export function createGlPreview(
  stage: HTMLElement,
  options: GlPreviewOptions = {},
): GlPreview | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.className = 'video-preview-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: Boolean(options.preserveDrawingBuffer),
  });
  if (!gl) return null;

  const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  const max3dTextureSize = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number;
  let active = true;
  let disposed = false;
  let canvasWidth = 0;
  let canvasHeight = 0;
  let sourceTexture: WebGLTexture | null = null;
  let toneTexture: WebGLTexture | null = null;
  let lutTexture: WebGLTexture | null = null;
  let layerTextureA: WebGLTexture | null = null;
  let layerTextureB: WebGLTexture | null = null;
  let frameBufferA: WebGLFramebuffer | null = null;
  let frameBufferB: WebGLFramebuffer | null = null;
  let maskTextureA: WebGLTexture | null = null;
  let maskTextureB: WebGLTexture | null = null;
  let maskFrameBufferA: WebGLFramebuffer | null = null;
  let maskFrameBufferB: WebGLFramebuffer | null = null;
  let vertexArray: WebGLVertexArrayObject | null = null;
  let vertexBuffer: WebGLBuffer | null = null;
  let sourceProgram: ProgramInfo | null = null;
  let blurProgram: ProgramInfo | null = null;
  let maskProgram: ProgramInfo | null = null;
  let finishProgram: ProgramInfo | null = null;
  let toneKey = '';
  let lutKey = '';
  let lastSource: HTMLVideoElement | HTMLImageElement | null = null;
  let lastSourceUrl = '';
  let lastSourceTime = -1;
  let lastSourceWidth = 0;
  let lastSourceHeight = 0;
  let lastUploadWidth = 0;
  let lastUploadHeight = 0;
  let lastSourceReadyState = -1;
  let uploadCanvas: HTMLCanvasElement | null = null;
  let uploadContext: CanvasRenderingContext2D | null = null;
  let fallbackNotice = '';

  const compile = (type: number, source: string): WebGLShader | null => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.warn('[video-preview] shader compile failed:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  };

  const createProgram = (vertexSource: string, fragmentSource: string, names: string[]): ProgramInfo | null => {
    const vertex = compile(gl.VERTEX_SHADER, vertexSource);
    const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    if (!vertex || !fragment || !program) {
      if (vertex) gl.deleteShader(vertex);
      if (fragment) gl.deleteShader(fragment);
      if (program) gl.deleteProgram(program);
      return null;
    }
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn('[video-preview] program link failed:', gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      return null;
    }
    const uniforms: Record<string, WebGLUniformLocation | null> = {};
    for (const name of names) uniforms[name] = gl.getUniformLocation(program, name);
    return { program, uniforms };
  };

  const deleteProgram = (info: ProgramInfo | null): void => {
    if (info) gl.deleteProgram(info.program);
  };

  const deleteTargets = (): void => {
    if (layerTextureA) gl.deleteTexture(layerTextureA);
    if (layerTextureB) gl.deleteTexture(layerTextureB);
    if (maskTextureA) gl.deleteTexture(maskTextureA);
    if (maskTextureB) gl.deleteTexture(maskTextureB);
    if (frameBufferA) gl.deleteFramebuffer(frameBufferA);
    if (frameBufferB) gl.deleteFramebuffer(frameBufferB);
    if (maskFrameBufferA) gl.deleteFramebuffer(maskFrameBufferA);
    if (maskFrameBufferB) gl.deleteFramebuffer(maskFrameBufferB);
    layerTextureA = null;
    layerTextureB = null;
    maskTextureA = null;
    maskTextureB = null;
    frameBufferA = null;
    frameBufferB = null;
    maskFrameBufferA = null;
    maskFrameBufferB = null;
    canvasWidth = 0;
    canvasHeight = 0;
  };

  const createTextureTarget = (): WebGLTexture | null => {
    const texture = gl.createTexture();
    if (!texture) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, canvasWidth, canvasHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return texture;
  };

  const ensureTargets = (width: number, height: number): boolean => {
    if (width > maxTextureSize || height > maxTextureSize) return false;
    if (canvasWidth === width && canvasHeight === height && layerTextureA && layerTextureB &&
      maskTextureA && maskTextureB && frameBufferA && frameBufferB &&
      maskFrameBufferA && maskFrameBufferB) {
      return true;
    }
    deleteTargets();
    canvasWidth = width;
    canvasHeight = height;
    layerTextureA = createTextureTarget();
    layerTextureB = createTextureTarget();
    maskTextureA = createTextureTarget();
    maskTextureB = createTextureTarget();
    frameBufferA = gl.createFramebuffer();
    frameBufferB = gl.createFramebuffer();
    maskFrameBufferA = gl.createFramebuffer();
    maskFrameBufferB = gl.createFramebuffer();
    if (!layerTextureA || !layerTextureB || !maskTextureA || !maskTextureB ||
      !frameBufferA || !frameBufferB || !maskFrameBufferA || !maskFrameBufferB) return false;
    const targets = [
      [frameBufferA, layerTextureA],
      [frameBufferB, layerTextureB],
      [maskFrameBufferA, maskTextureA],
      [maskFrameBufferB, maskTextureB],
    ] as const;
    for (const [buffer, texture] of targets) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, buffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return false;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  };

  const createSolidTone = (): WebGLTexture | null => {
    const texture = gl.createTexture();
    if (!texture) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const identity = new Uint8Array(256);
    for (let index = 0; index < 256; index += 1) identity[index] = index;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 1, 0, gl.RED, gl.UNSIGNED_BYTE, identity);
    return texture;
  };

  const createSolidLut = (): WebGLTexture | null => {
    const texture = gl.createTexture();
    if (!texture) return null;
    gl.bindTexture(gl.TEXTURE_3D, texture);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    return texture;
  };

  const initialize = (): boolean => {
    sourceProgram = createProgram(VERTEX_SOURCE, FRAGMENT_SOURCE, [
      'uStage', 'uSize', 'uOffset', 'uScale', 'uRotation', 'uSource',
      'uBrightness', 'uContrast', 'uSaturation', 'uHue',
    ]);
    blurProgram = createProgram(VERTEX_FULLSCREEN, FRAGMENT_BLUR, [
      'uSource', 'uTexel', 'uDirection', 'uWeights', 'uRadius', 'uSpacing',
    ]);
    maskProgram = createProgram(VERTEX_FULLSCREEN, FRAGMENT_MASK, [
      'uMaskShape', 'uMaskRect',
    ]);
    finishProgram = createProgram(VERTEX_FULLSCREEN, FRAGMENT_FINISH, [
      'uLayer', 'uTone', 'uLut', 'uHasTone', 'uHasLut', 'uLutSize',
      'uChroma', 'uChromaColor', 'uTolerance', 'uSoftness', 'uOpacity',
      'uMaskShape', 'uMaskRect', 'uFeatherPx', 'uStagePx', 'uMaskTexture',
      'uHasMaskTexture', 'uReveal', 'uBlend',
    ]);
    if (!sourceProgram || !blurProgram || !maskProgram || !finishProgram) return false;

    sourceTexture = gl.createTexture();
    toneTexture = createSolidTone();
    lutTexture = createSolidLut();
    vertexBuffer = gl.createBuffer();
    vertexArray = gl.createVertexArray();
    if (!sourceTexture || !toneTexture || !lutTexture || !vertexBuffer || !vertexArray) return false;
    gl.bindVertexArray(vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    // Keep the browser's color conversion so video frames reach the shader in
    // the same color space as the CSS/Canvas2D preview and export paths.
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    toneKey = '';
    lutKey = '';
    lastSource = null;
    lastSourceUrl = '';
    return true;
  };

  const destroyResources = (): void => {
    deleteProgram(sourceProgram);
    deleteProgram(blurProgram);
    deleteProgram(maskProgram);
    deleteProgram(finishProgram);
    sourceProgram = null;
    blurProgram = null;
    maskProgram = null;
    finishProgram = null;
    if (sourceTexture) gl.deleteTexture(sourceTexture);
    if (toneTexture) gl.deleteTexture(toneTexture);
    if (lutTexture) gl.deleteTexture(lutTexture);
    sourceTexture = null;
    toneTexture = null;
    lutTexture = null;
    deleteTargets();
    if (vertexBuffer) gl.deleteBuffer(vertexBuffer);
    if (vertexArray) gl.deleteVertexArray(vertexArray);
    vertexBuffer = null;
    vertexArray = null;
  };

  const uploadSource = (source: HTMLVideoElement | HTMLImageElement): boolean => {
    if (!sourceTexture) return false;
    const currentUrl = source.currentSrc || source.src || '';
    const currentTime = sourceTime(source);
    const width = isVideo(source) ? source.videoWidth : source.naturalWidth;
    const height = isVideo(source) ? source.videoHeight : source.naturalHeight;
    const readyState = isVideo(source) ? source.readyState : 4;
    // A 4K source at a 720p preview does not need a 4K texture. Downscale in
    // the 2D upload path so upload bandwidth and texture memory match the
    // preview target instead of the source resolution.
    const scale = Math.min(1, canvasWidth / width, canvasHeight / height);
    const uploadWidth = Math.max(1, Math.round(width * scale));
    const uploadHeight = Math.max(1, Math.round(height * scale));
    if (source === lastSource && currentUrl === lastSourceUrl && currentTime === lastSourceTime &&
      width === lastSourceWidth && height === lastSourceHeight &&
      uploadWidth === lastUploadWidth && uploadHeight === lastUploadHeight &&
      readyState === lastSourceReadyState) {
      return true;
    }
    try {
      // Upload through a 2D canvas so the browser applies the same color
      // management it uses for the CSS preview and the Canvas2D exporter.
      if (!uploadCanvas) {
        uploadCanvas = document.createElement('canvas');
        uploadContext = uploadCanvas.getContext('2d');
      }
      let upload: CanvasImageSource = source;
      if (uploadContext) {
        if (uploadCanvas.width !== uploadWidth || uploadCanvas.height !== uploadHeight) {
          uploadCanvas.width = uploadWidth;
          uploadCanvas.height = uploadHeight;
        }
        uploadContext.clearRect(0, 0, uploadWidth, uploadHeight);
        uploadContext.drawImage(source, 0, 0, uploadWidth, uploadHeight);
        upload = uploadCanvas;
      }
      gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, upload);
      lastSource = source;
      lastSourceUrl = currentUrl;
      lastSourceTime = currentTime;
      lastSourceWidth = width;
      lastSourceHeight = height;
      lastUploadWidth = uploadWidth;
      lastUploadHeight = uploadHeight;
      lastSourceReadyState = readyState;
      return true;
    } catch {
      lastSource = null;
      return false;
    }
  };

  const updateTone = (effects: ClipEffects): void => {
    if (!toneTexture) return;
    const key = `${effects.curve.shadows}|${effects.curve.midtones}|${effects.curve.highlights}`;
    if (key === toneKey) return;
    toneKey = key;
    const table = toneTable(effects.curve);
    gl.bindTexture(gl.TEXTURE_2D, toneTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 1, 0, gl.RED, gl.UNSIGNED_BYTE, table);
  };

  const updateLut = (effects: ClipEffects): boolean => {
    if (!effects.lut) {
      lutKey = 'none';
      return true;
    }
    if (effects.lut.size > max3dTextureSize) return false;
    const key = lutFingerprint(effects.lut);
    if (key === lutKey) return true;
    const size = effects.lut.size;
    const pixels = new Uint8Array(size ** 3 * 4);
    for (let index = 0; index < size ** 3; index += 1) {
      const source = index * 3;
      const target = index * 4;
      pixels[target] = Math.round(Math.max(0, Math.min(1, effects.lut.data[source])) * 255);
      pixels[target + 1] = Math.round(Math.max(0, Math.min(1, effects.lut.data[source + 1])) * 255);
      pixels[target + 2] = Math.round(Math.max(0, Math.min(1, effects.lut.data[source + 2])) * 255);
      pixels[target + 3] = 255;
    }
    if (!lutTexture) {
      lutTexture = gl.createTexture();
      if (!lutTexture) return false;
    }
    gl.bindTexture(gl.TEXTURE_3D, lutTexture);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, size, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    lutKey = key;
    return true;
  };

  const drawSource = (frame: GlPreviewFrame): void => {
    if (!sourceProgram || !frameBufferA) return;
    const { plan } = frame;
    const draw = previewDrawRect(plan);
    const effects = plan.effects;
    gl.useProgram(sourceProgram.program);
    const uniforms = sourceProgram.uniforms;
    gl.uniform2f(uniforms.uStage, plan.stage.width, plan.stage.height);
    gl.uniform2f(uniforms.uSize, draw.width, draw.height);
    gl.uniform2f(
      uniforms.uOffset,
      (plan.transform.x / 100) * plan.stage.width,
      (plan.transform.y / 100) * plan.stage.height,
    );
    gl.uniform2f(uniforms.uScale, plan.transform.scale * plan.transform.scaleX,
      plan.transform.scale * plan.transform.scaleY);
    gl.uniform1f(uniforms.uRotation, (plan.transform.rotation * Math.PI) / 180);
    gl.uniform1f(uniforms.uBrightness, (100 + effects.brightness) / 100);
    gl.uniform1f(uniforms.uContrast, (100 + effects.contrast) / 100);
    gl.uniform1f(uniforms.uSaturation, (100 + effects.saturation) / 100);
    gl.uniform1f(uniforms.uHue, (effects.hue * Math.PI) / 180);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
    gl.uniform1i(uniforms.uSource, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, frameBufferA);
    gl.viewport(0, 0, canvasWidth, canvasHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindVertexArray(vertexArray);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  const gaussianKernel = (sigma: number): { weights: Float32Array; radius: number; spacing: number } => {
    const radius = Math.min(64, Math.max(1, Math.ceil(sigma * 3)));
    // Keep the kernel inside 64 taps while still covering three standard
    // deviations for large blur radii.
    const spacing = Math.max(1, (sigma * 3) / radius);
    const weights = new Float32Array(65);
    let total = 0;
    for (let index = 0; index <= radius; index += 1) {
      const distance = (index * spacing) / sigma;
      const weight = Math.exp(-0.5 * distance * distance);
      weights[index] = weight;
      total += index === 0 ? weight : weight * 2;
    }
    for (let index = 0; index <= radius; index += 1) weights[index] /= Math.max(1e-8, total);
    return { weights, radius, spacing };
  };

  const blurTextures = (
    sourceTexture: WebGLTexture,
    tempTexture: WebGLTexture,
    tempFrameBuffer: WebGLFramebuffer,
    destinationFrameBuffer: WebGLFramebuffer,
    sigma: number,
  ): void => {
    if (!blurProgram || !vertexArray) return;
    const { weights, radius, spacing } = gaussianKernel(sigma);
    const program = blurProgram.program;
    const uniforms = blurProgram.uniforms;
    gl.useProgram(program);
    gl.uniform2f(uniforms.uTexel, 1 / canvasWidth, 1 / canvasHeight);
    gl.uniform1fv(uniforms.uWeights, weights);
    gl.uniform1i(uniforms.uRadius, radius);
    gl.uniform1f(uniforms.uSpacing, spacing);
    gl.uniform1i(uniforms.uSource, 0);
    gl.bindVertexArray(vertexArray);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
    gl.uniform2f(uniforms.uDirection, 1, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, tempFrameBuffer);
    gl.viewport(0, 0, canvasWidth, canvasHeight);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.bindTexture(gl.TEXTURE_2D, tempTexture);
    gl.uniform2f(uniforms.uDirection, 0, 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, destinationFrameBuffer);
    gl.viewport(0, 0, canvasWidth, canvasHeight);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  const drawBlur = (sigma: number): void => {
    if (!frameBufferA || !frameBufferB || !layerTextureA || !layerTextureB) return;
    blurTextures(layerTextureA, layerTextureB, frameBufferB, frameBufferA, sigma);
  };

  /** Draw the mask shape, then blur it exactly like drawMask() in export. */
  const drawMask = (mask: ClipEffects['mask']): boolean => {
    if (!maskProgram || !maskFrameBufferA || !maskFrameBufferB || !maskTextureA || !maskTextureB ||
      !vertexArray || mask.shape === 'none' || mask.feather <= 0) return false;
    const shape = mask.shape === 'rect' ? 1 : 2;
    gl.useProgram(maskProgram.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, maskFrameBufferA);
    gl.viewport(0, 0, canvasWidth, canvasHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1i(maskProgram.uniforms.uMaskShape, shape);
    gl.uniform4f(maskProgram.uniforms.uMaskRect, mask.x / 100, mask.y / 100,
      mask.width / 100, mask.height / 100);
    gl.bindVertexArray(vertexArray);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const featherPx = (mask.feather / 100) * Math.min(canvasWidth, canvasHeight);
    blurTextures(maskTextureA, maskTextureB, maskFrameBufferB, maskFrameBufferA, featherPx);
    return true;
  };

  const drawFinish = (frame: GlPreviewFrame, maskTextureUsed: boolean): void => {
    if (!finishProgram || !layerTextureA) return;
    const { plan } = frame;
    const effects = plan.effects;
    const mask = effects.mask;
    const stagePixels = {
      width: plan.stage.width * plan.stage.dpr,
      height: plan.stage.height * plan.stage.dpr,
    };
    gl.useProgram(finishProgram.program);
    const uniforms = finishProgram.uniforms;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, layerTextureA);
    gl.uniform1i(uniforms.uLayer, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, toneTexture);
    gl.uniform1i(uniforms.uTone, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_3D, lutTexture);
    gl.uniform1i(uniforms.uLut, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, maskTextureUsed ? maskTextureA : layerTextureA);
    gl.uniform1i(uniforms.uMaskTexture, 3);
    gl.uniform1i(uniforms.uHasMaskTexture, maskTextureUsed ? 1 : 0);
    gl.uniform1i(uniforms.uHasTone, effects.curve.shadows || effects.curve.midtones ||
      effects.curve.highlights ? 1 : 0);
    gl.uniform1i(uniforms.uHasLut, effects.lut ? 1 : 0);
    gl.uniform1f(uniforms.uLutSize, effects.lut ? effects.lut.size : 1);
    gl.uniform1i(uniforms.uChroma, effects.chroma.enabled ? 1 : 0);
    const chroma = effects.chroma.color.replace('#', '');
    gl.uniform3f(
      uniforms.uChromaColor,
      Number.parseInt(chroma.slice(0, 2), 16) / 255,
      Number.parseInt(chroma.slice(2, 4), 16) / 255,
      Number.parseInt(chroma.slice(4, 6), 16) / 255,
    );
    gl.uniform1f(uniforms.uTolerance, effects.chroma.tolerance);
    gl.uniform1f(uniforms.uSoftness, Math.max(0.0001, effects.chroma.softness));
    gl.uniform1f(uniforms.uOpacity, plan.opacity);
    gl.uniform1i(uniforms.uMaskShape, mask.shape === 'rect' ? 1 : mask.shape === 'ellipse' ? 2 : 0);
    gl.uniform4f(uniforms.uMaskRect, mask.x / 100, mask.y / 100, mask.width / 100, mask.height / 100);
    gl.uniform1f(uniforms.uFeatherPx, (mask.feather / 100) * Math.min(stagePixels.width, stagePixels.height));
    gl.uniform2f(uniforms.uStagePx, stagePixels.width, stagePixels.height);
    const reveal = plan.motion.reveal;
    gl.uniform4f(
      uniforms.uReveal,
      reveal ? reveal.top / 100 : 0,
      reveal ? reveal.right / 100 : 0,
      reveal ? reveal.bottom / 100 : 0,
      reveal ? reveal.left / 100 : 0,
    );
    gl.uniform1i(uniforms.uBlend, BLEND_INDEX[effects.blend] ?? 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasWidth, canvasHeight);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindVertexArray(vertexArray);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.useProgram(null);
  };

  const captureFrame = (signature: string): void => {
    if (!options.onFrameCaptured || typeof createImageBitmap !== 'function' ||
      typeof ImageData === 'undefined') return;
    const width = canvasWidth;
    const height = canvasHeight;
    if (width < 1 || height < 1) return;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const flipped = new Uint8ClampedArray(pixels.length);
    const rowBytes = width * 4;
    for (let row = 0; row < height; row += 1) {
      const sourceStart = (height - 1 - row) * rowBytes;
      flipped.set(pixels.subarray(sourceStart, sourceStart + rowBytes), row * rowBytes);
    }
    const image = new ImageData(flipped, width, height);
    void createImageBitmap(image).then((bitmap) => {
      options.onFrameCaptured?.(signature, bitmap);
    }).catch(() => undefined);
  };

  const fail = (reason: PreviewFallbackReason): GlPreviewResult => {
    if (reason === 'context-lost' && fallbackNotice !== reason) {
      fallbackNotice = reason;
      options.onFallback?.(reason);
    }
    canvas.style.display = 'none';
    return { rendered: false, reason };
  };

  const handleLost = (event: Event): void => {
    event.preventDefault();
    active = false;
    canvas.style.display = 'none';
    fallbackNotice = '';
    options.onFallback?.('context-lost');
  };

  const handleRestored = (): void => {
    if (disposed) return;
    active = initialize();
    if (active) canvas.style.display = 'none';
  };

  canvas.addEventListener('webglcontextlost', handleLost, false);
  canvas.addEventListener('webglcontextrestored', handleRestored, false);
  if (!initialize()) {
    destroyResources();
    canvas.remove();
    return null;
  }
  stage.append(canvas);

  return {
    kind: 'webgl',
    canvas,
    get active() {
      return active && !disposed;
    },
    render(frame: GlPreviewFrame): GlPreviewResult {
      if (disposed) return { rendered: false, reason: 'inactive' };
      if (!active) return { rendered: false, reason: 'context-lost' };
      const { plan } = frame;
      if (!sourceReady(frame.source)) return fail('source-not-ready');
      const width = Math.max(1, Math.round(plan.output.width));
      const height = Math.max(1, Math.round(plan.output.height));
      if (!ensureTargets(width, height)) {
        destroyResources();
        active = false;
        options.onFallback?.('render-target');
        return fail('render-target');
      }
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        lastSource = null;
      }
      if (!uploadSource(frame.source)) return fail('source-not-ready');
      if (!updateLut(plan.effects)) return fail('lut-too-large');
      updateTone(plan.effects);
      drawSource(frame);
      const sigma = plan.effects.blur * plan.stage.dpr;
      if (sigma > 0.35) drawBlur(sigma);
      const maskTextureUsed = drawMask(plan.effects.mask);
      drawFinish(frame, maskTextureUsed);
      canvas.style.display = 'block';
      if (frame.capture) captureFrame(plan.signature);
      return { rendered: true };
    },
    whenIdle(): Promise<void> {
      if (!gl || disposed || canvas.width < 1 || canvas.height < 1) return Promise.resolve();
      // A 1×1 readback is the portable way to make the main thread wait for
      // all previously submitted fragments, including the blur passes.
      // (fenceSync alone can return before the compositor has drawn them.)
      const probe = new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, probe);
      return Promise.resolve();
    },
    clear(): void {
      if (gl && active && !disposed) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvas.width || 1, canvas.height || 1);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      canvas.style.display = 'none';
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      active = false;
      canvas.removeEventListener('webglcontextlost', handleLost);
      canvas.removeEventListener('webglcontextrestored', handleRestored);
      destroyResources();
      canvas.remove();
    },
  };
}
