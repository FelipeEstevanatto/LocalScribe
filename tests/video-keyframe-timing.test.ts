import { expect, test } from 'bun:test';
import { normalizeAnimation } from '../src/video-effects';
import { retimeKeys } from '../src/video-keyframe-timing';

test('moves keys on different properties by one frame-aligned delta and keeps easing', () => {
  const animation = normalizeAnimation({
    scale: [{ at: 1, value: 1.3, easing: 'ease-in' }],
    opacity: [{ at: 2, value: 0.6, easing: 'hold' }],
  });
  const result = retimeKeys(animation, [{ property: 'scale', at: 1 }, { property: 'opacity', at: 2 }], 5 / 24, 5)!;
  expect(result.animation.scale[0]).toEqual({ at: 1 + 5 / 24, value: 1.3, easing: 'ease-in' });
  expect(result.animation.opacity[0]).toEqual({ at: 2 + 5 / 24, value: 0.6, easing: 'hold' });
  expect(animation.scale[0].at).toBe(1);
});

test('clamps the whole selection and refuses to overwrite a stationary key', () => {
  const animation = normalizeAnimation({ scale: [{ at: 1, value: 1 }, { at: 3, value: 2 }] });
  expect(retimeKeys(animation, [{ property: 'scale', at: 1 }], 2, 5)).toBeNull();
  const result = retimeKeys(animation, [{ property: 'scale', at: 1 }, { property: 'scale', at: 3 }], 3, 5)!;
  expect(result.selection.map(({ at }) => at)).toEqual([3, 5]);
});
