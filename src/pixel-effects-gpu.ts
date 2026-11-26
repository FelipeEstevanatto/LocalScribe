/**
 * The export pixel pass (chroma key, tone curve, 3D LUT) on the GPU with
 * WebGL2. Prototype for O8: it runs only the per-pixel pass, which the parity
 * harness found export-safe, and leaves geometry, CSS filters and masks on
 * Canvas2D. The shader follows pixel-effects-kernel.ts step by step (same
 * order, byte inputs, LUT values fetched exactly with texelFetch, round half
 * up and clamp on output) so the result can be compared with the CPU kernel.
 *
 * The frame stays on the GPU: the layer canvas is uploaded as a texture, the
 * pass draws into this module's OffscreenCanvas, and the caller draws that
 * back into the layer. No getImageData or putImageData.
 */
import type { PixelPass } from './pixel-effects-kernel';

const VERTEX = `#version 300 es
in vec2 aPosition;
void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }
`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;
uniform sampler2D uSource;
uniform int uHeight;
uniform bool uHasKey;
uniform vec3 uKey;
uniform float uTolerance;
uniform float uSoftness;
uniform bool uHasTone;
uniform float uTone[256];
uniform bool uHasLut;
uniform sampler3D uLut;
uniform int uLutSize;
out vec4 outColor;

vec3 lutAt(int r, int g, int b) { return texelFetch(uLut, ivec3(r, g, b), 0).rgb; }

void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  // Texture row 0 is the top of the canvas; framebuffer row 0 is the bottom.
  vec4 source = texelFetch(uSource, ivec2(pixel.x, uHeight - 1 - pixel.y), 0);
  ivec4 byteValue = ivec4(floor(source * 255.0 + 0.5));
  if (byteValue.a == 0) { outColor = source; return; }
  float alpha = float(byteValue.a);
  vec3 rgb = vec3(byteValue.rgb) / 255.0;
  if (uHasKey) {
    vec3 d = rgb - uKey;
    float distance = sqrt(d.r * d.r * 0.5 + d.g * d.g + d.b * d.b * 0.5);
    if (distance < uTolerance) { outColor = vec4(source.rgb, 0.0); return; }
    if (distance < uTolerance + uSoftness) alpha = floor(alpha * ((distance - uTolerance) / uSoftness) + 0.5);
  }
  if (uHasTone) rgb = vec3(uTone[byteValue.r], uTone[byteValue.g], uTone[byteValue.b]);
  else rgb = vec3(byteValue.rgb) / 255.0;
  if (uHasLut) {
    int n = uLutSize;
    float top = float(n - 1);
    vec3 f = clamp(rgb * top, 0.0, top);
    ivec3 i0 = ivec3(floor(f));
    ivec3 i1 = min(i0 + 1, ivec3(n - 1));
    vec3 t = f - vec3(i0);
    // Same interpolation order as the CPU kernel: red, then green, then blue.
    vec3 v000 = lutAt(i0.r, i0.g, i0.b);
    vec3 lowGreen = v000 + (lutAt(i1.r, i0.g, i0.b) - v000) * t.r;
    vec3 v001 = lutAt(i0.r, i0.g, i1.b);
    vec3 highGreen = v001 + (lutAt(i1.r, i0.g, i1.b) - v001) * t.r;
    vec3 v010 = lutAt(i0.r, i1.g, i0.b);
    vec3 lowBlue = lowGreen + ((v010 + (lutAt(i1.r, i1.g, i0.b) - v010) * t.r) - lowGreen) * t.g;
    vec3 v011 = lutAt(i0.r, i1.g, i1.b);
    vec3 highBlue = highGreen + ((v011 + (lutAt(i1.r, i1.g, i1.b) - v011) * t.r) - highGreen) * t.g;
    rgb = lowBlue + (highBlue - lowBlue) * t.b;
  }
  outColor = vec4(clamp(floor(rgb * 255.0 + 0.5), 0.0, 255.0) / 255.0, alpha / 255.0);
}
`;

interface GpuPass {
  canvas: OffscreenCanvas;
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  source: WebGLTexture;
  lut: WebGLTexture;
  lutKey: string | null;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

let state: GpuPass | null | undefined;

function compile(gl: WebGL2RenderingContext, type: number, text: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, text);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader compile failed');
  return shader;
}

function create(): GpuPass | null {
  if (typeof OffscreenCanvas === 'undefined') return null;
  try {
    const canvas = new OffscreenCanvas(16, 16);
    const gl = canvas.getContext('webgl2', {
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      antialias: false,
      depth: false,
      stencil: false,
    });
    if (!gl) return null;
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link failed');
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const texture = (unit: number, target: number): WebGLTexture => {
      const handle = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(target, handle);
      gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return handle;
    };
    const source = texture(0, gl.TEXTURE_2D);
    const lut = texture(1, gl.TEXTURE_3D);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    const names = ['uSource', 'uHeight', 'uHasKey', 'uKey', 'uTolerance', 'uSoftness', 'uHasTone', 'uTone', 'uHasLut', 'uLut', 'uLutSize'];
    const uniforms = Object.fromEntries(names.map((name) => [name, gl.getUniformLocation(program, name)]));
    gl.uniform1i(uniforms.uSource, 0);
    gl.uniform1i(uniforms.uLut, 1);
    // Unpremultiplied bytes in, like getImageData.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    return { canvas, gl, program, source, lut, lutKey: null, uniforms };
  } catch (error) {
    console.warn('GPU pixel pass unavailable; using the CPU pass.', error);
    return null;
  }
}

/** True when this browser can run the GPU pass. */
export function gpuPixelPassAvailable(): boolean {
  if (state === undefined) state = create();
  return state !== null;
}

/**
 * Run the pass over `layer` and return the canvas holding the result (same
 * size as the layer), or null when the GPU pass is unavailable.
 */
export function runPixelPassGpu(layer: OffscreenCanvas | HTMLCanvasElement, pass: PixelPass, lutKey: string | null): OffscreenCanvas | null {
  if (state === undefined) state = create();
  if (!state) return null;
  const { gl, canvas, uniforms } = state;
  if (gl.isContextLost()) {
    state = null;
    return null;
  }
  const width = layer.width;
  const height = layer.height;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  gl.viewport(0, 0, width, height);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, state.source);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, layer);
  gl.uniform1i(uniforms.uHeight, height);
  gl.uniform1i(uniforms.uHasKey, pass.key ? 1 : 0);
  if (pass.key) gl.uniform3f(uniforms.uKey, pass.key[0], pass.key[1], pass.key[2]);
  gl.uniform1f(uniforms.uTolerance, pass.tolerance);
  gl.uniform1f(uniforms.uSoftness, pass.softness);
  gl.uniform1i(uniforms.uHasTone, pass.tone ? 1 : 0);
  if (pass.tone) gl.uniform1fv(uniforms.uTone, new Float32Array(pass.tone));
  gl.uniform1i(uniforms.uHasLut, pass.lut ? 1 : 0);
  if (pass.lut) {
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, state.lut);
    const key = lutKey ?? `anonymous:${pass.lutSize}:${pass.lut.length}`;
    if (state.lutKey !== key || !lutKey) {
      const n = pass.lutSize;
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, n, n, n, 0, gl.RGB, gl.FLOAT, new Float32Array(pass.lut));
      state.lutKey = key;
    }
    gl.uniform1i(uniforms.uLutSize, pass.lutSize);
  }
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  return canvas;
}

/** Whether exports should use the GPU pass (prototype: opt in per browser). */
export function gpuPixelPassEnabled(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('localscribe.gpuPixelPass') === '1';
  } catch {
    return false;
  }
}
