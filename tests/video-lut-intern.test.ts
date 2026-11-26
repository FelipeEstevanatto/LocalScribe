import { describe, expect, test } from 'bun:test';
import { cloneEffects, effectsSignature, internLut, lutKey, normalizeEffects, parseCubeLut } from '../src/video-effects';

const CUBE = (shift = 0): string => {
  const rows: string[] = [];
  for (let b = 0; b < 2; b += 1) for (let g = 0; g < 2; g += 1) for (let r = 0; r < 2; r += 1) rows.push(`${r} ${g} ${Math.min(1, b + shift)}`);
  return `LUT_3D_SIZE 2\n${rows.join('\n')}\n`;
};

describe('LUT interning', () => {
  test('the same LUT loaded twice is one shared frozen object', () => {
    const first = parseCubeLut(CUBE(), 'grade');
    const second = parseCubeLut(CUBE(), 'grade');
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
  });

  test('different data or names stay distinct', () => {
    const base = parseCubeLut(CUBE(), 'grade');
    expect(parseCubeLut(CUBE(0.5), 'grade')).not.toBe(base);
    expect(parseCubeLut(CUBE(), 'other')).not.toBe(base);
    expect(lutKey(parseCubeLut(CUBE(0.5), 'grade'))).not.toBe(lutKey(base));
  });

  test('normalizeEffects interns a plain (saved) LUT and keeps its values', () => {
    const shared = parseCubeLut(CUBE(), 'grade');
    const saved = { name: 'grade', size: 2, data: [...shared.data] };
    const effects = normalizeEffects({ lut: saved });
    expect(effects.lut).toBe(shared);
    expect(normalizeEffects(effects).lut).toBe(shared);
  });

  test('cloneEffects copies everything but shares the LUT', () => {
    const effects = normalizeEffects({ brightness: 10, lut: parseCubeLut(CUBE(), 'grade') });
    const copy = cloneEffects(effects);
    expect(copy).toEqual(effects);
    expect(copy.lut).toBe(effects.lut);
    expect(copy.mask).not.toBe(effects.mask);
    copy.mask.x = 50;
    expect(effects.mask.x).toBe(0);
  });

  test('the signature names the LUT without its data and still tells LUTs apart', () => {
    const a = normalizeEffects({ lut: parseCubeLut(CUBE(), 'grade') });
    const b = normalizeEffects({ lut: parseCubeLut(CUBE(0.5), 'grade') });
    expect(effectsSignature(a).length).toBeLessThan(600);
    expect(effectsSignature(a)).not.toBe(effectsSignature(b));
    expect(effectsSignature(a)).toBe(effectsSignature(cloneEffects(a)));
    expect(effectsSignature(normalizeEffects({}))).toBe(JSON.stringify({ ...normalizeEffects({}), lut: null }));
  });

  test('interning is idempotent', () => {
    const lut = parseCubeLut(CUBE(), 'grade');
    expect(internLut(lut)).toBe(lut);
  });
});
