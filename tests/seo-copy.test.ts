import { expect, test } from 'bun:test';
import { QUICK_LANGUAGES } from '../src/quick-locale';
import { quickCopy } from '../seo/quick-copy';

test('every Quick Tools locale has complete landing-page copy', () => {
  for (const [locale] of QUICK_LANGUAGES) {
    const copy = quickCopy(locale);
    expect(copy.howTitle.length).toBeGreaterThan(2);
    expect(copy.steps).toHaveLength(3);
    expect(copy.steps.every((step) => step.length > 5)).toBe(true);
    expect(copy.faqs).toHaveLength(3);
    expect(copy.faqs.every((faq) => faq.q.length > 4 && faq.a.length > 12)).toBe(true);
    expect(copy.proof).toHaveLength(4);
    expect(copy.formatsBody.length).toBeGreaterThan(20);
    expect(copy.privacyBody.length).toBeGreaterThan(20);
  }
});
