import type { ModelVariant, SupportedModel } from './catalog';

export interface DeviceProfile {
  cores: number | null;
  memoryGB: number | null;
  mobile: boolean;
  webgpu: boolean;
  shaderF16?: boolean;
}

export type FitTone = 'good' | 'warn' | 'muted';

export interface FitResult {
  tone: FitTone;
  label: string;
  detail: string;
}

type NavigatorWithMemory = Navigator & { deviceMemory?: number };

function isMobile(): boolean {
  const ua = navigator.userAgent;
  const touch = window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
  return touch && /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
}

export function readDeviceProfile(webgpu: boolean, shaderF16?: boolean): DeviceProfile {
  const cores = navigator.hardwareConcurrency;
  const memory = (navigator as NavigatorWithMemory).deviceMemory;

  return {
    cores:
      typeof cores === 'number' && Number.isFinite(cores) && cores > 0
        ? cores
        : null,
    memoryGB:
      typeof memory === 'number' && Number.isFinite(memory) && memory > 0
        ? memory
        : null,
    mobile: isMobile(),
    webgpu,
    shaderF16,
  };
}

export function modelNeedsWebGpu(
  model: SupportedModel,
  gpu: { supported: boolean; shaderF16?: boolean },
): boolean {
  return Boolean(model.requiresWebGPU &&
    (!gpu.supported || (model.requiresWebGPU === 'shader-f16' && !gpu.shaderF16)));
}

/** Prefer the compact model tier on phones, low-RAM machines, and CPU-only browsers. */
export function prefersCompactModel(profile: DeviceProfile): boolean {
  return (
    profile.mobile ||
    (profile.memoryGB !== null && profile.memoryGB <= 4) ||
    (profile.cores !== null && profile.cores <= 4) ||
    !profile.webgpu
  );
}

export function modelFit(
  model: SupportedModel,
  variant: ModelVariant,
  profile: DeviceProfile,
): FitResult {
  if (modelNeedsWebGpu(model, { supported: profile.webgpu, shaderF16: profile.shaderF16 })) {
    return {
      tone: 'warn',
      label: 'WebGPU required',
      detail: model.requiresWebGPU === 'shader-f16'
        ? 'This model requires WebGPU with shader-f16 support.'
        : 'This model requires WebGPU and will not run in this browser.',
    };
  }

  if (variant.approxBytes >= 2_000_000_000) {
    return {
      tone: 'warn',
      label: 'Not loadable',
      detail: 'A single file above about 2 GB exceeds the Chromium buffer limit.',
    };
  }

  if (profile.memoryGB !== null) {
    const neededGB = variant.approxBytes / 1_000_000_000;
    if (neededGB > profile.memoryGB * 0.7) {
      return {
        tone: 'warn',
        label: 'Heavy for this device',
        detail: `About ${neededGB.toFixed(1)} GB of weights against roughly ${profile.memoryGB} GB of RAM.`,
      };
    }
  }

  if (profile.mobile && variant.approxBytes > 250_000_000) {
    return {
      tone: 'warn',
      label: 'Heavy on mobile',
      detail: 'A smaller model is the safer choice on a phone or tablet.',
    };
  }

  if (!profile.webgpu && variant.approxBytes > 800_000_000) {
    return {
      tone: 'warn',
      label: 'CPU only',
      detail: 'No WebGPU adapter, so this model will run slowly on WebAssembly.',
    };
  }

  if (!profile.webgpu) {
    return {
      tone: 'good',
      label: 'Runs here',
      detail: 'Uses the multi-threaded CPU backend.',
    };
  }

  return {
    tone: 'good',
    label: 'Runs here',
    detail: 'WebGPU is available for the encoder.',
  };
}
