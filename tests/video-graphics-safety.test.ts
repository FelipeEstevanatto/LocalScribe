import { describe, expect, test } from 'bun:test';
import { defaultGraphic, safeCssColor, safeSvgSource, sanitizeGraphic } from '../src/video-graphics';

describe('project graphic sanitising', () => {
  test('rejects external SVG sources', () => {
    expect(safeSvgSource('https://example.invalid/tracker.png?leak=1')).toBeUndefined();
    expect(safeSvgSource('//example.invalid/x.svg')).toBeUndefined();
    expect(safeSvgSource('javascript:alert(1)')).toBeUndefined();
    expect(safeSvgSource(42)).toBeUndefined();
  });

  test('keeps inline SVG data URLs and escapes CSS breakouts', () => {
    expect(safeSvgSource('data:image/svg+xml;base64,PHN2Zy8+')).toBe('data:image/svg+xml;base64,PHN2Zy8+');
    const escaped = safeSvgSource('data:image/svg+xml,a"), url(https://x/y');
    expect(escaped).not.toContain('"');
  });

  test('colours cannot carry url() or lists', () => {
    expect(safeCssColor('#ff0000', 'x')).toBe('#ff0000');
    expect(safeCssColor('rgba(1, 2, 3, 0.5)', 'x')).toBe('rgba(1, 2, 3, 0.5)');
    expect(safeCssColor('url(https://x/y)', 'x')).toBe('x');
    expect(safeCssColor('red), url(https://x/y', 'x')).toBe('x');
  });

  test('sanitizeGraphic cleans a crafted SVG clip', () => {
    const clip = { ...defaultGraphic('svg', 1, 0, 5), svg: 'https://example.invalid/a.png', stroke: 'url(https://x)' };
    const clean = sanitizeGraphic(clip);
    expect(clean.svg).toBeUndefined();
    expect(clean.stroke).toBe('transparent');
  });
});
