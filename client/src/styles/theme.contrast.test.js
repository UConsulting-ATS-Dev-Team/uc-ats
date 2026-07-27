import { describe, it, expect } from 'vitest';
import { createAppTheme } from './theme';

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const bigint = parseInt(clean, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return [r, g, b];
}

function relativeLuminance([r, g, b]) {
  const srgb = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}

function contrastRatio(a, b) {
  const l1 = relativeLuminance(hexToRgb(a));
  const l2 = relativeLuminance(hexToRgb(b));
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

const MODES = ['light', 'dark'];

describe('createAppTheme contrast checks', () => {
  MODES.forEach((mode) => {
    const theme = createAppTheme(mode);
    const p = theme.palette;

    it(`${mode}: text primary on background default meets 7:1`, () => {
      expect(contrastRatio(p.text.primary, p.background.default)).toBeGreaterThanOrEqual(7);
    });

    it(`${mode}: text primary on background paper meets 7:1`, () => {
      expect(contrastRatio(p.text.primary, p.background.paper)).toBeGreaterThanOrEqual(7);
    });

    it(`${mode}: text secondary on background default meets 4.5:1`, () => {
      expect(contrastRatio(p.text.secondary, p.background.default)).toBeGreaterThanOrEqual(4.5);
    });

    it(`${mode}: primary contrast text on primary main meets 4.5:1`, () => {
      expect(contrastRatio(p.primary.contrastText, p.primary.main)).toBeGreaterThanOrEqual(4.5);
    });

    it(`${mode}: secondary contrast text on secondary main meets 4.5:1`, () => {
      expect(contrastRatio(p.secondary.contrastText, p.secondary.main)).toBeGreaterThanOrEqual(4.5);
    });

    it(`${mode}: success contrast text on success main meets 4.5:1`, () => {
      expect(contrastRatio(p.success.contrastText, p.success.main)).toBeGreaterThanOrEqual(4.5);
    });

    it(`${mode}: error contrast text on error main meets 4.5:1`, () => {
      expect(contrastRatio(p.error.contrastText, p.error.main)).toBeGreaterThanOrEqual(4.5);
    });

    it(`${mode}: warning contrast text on warning main meets 4.5:1`, () => {
      expect(contrastRatio(p.warning.contrastText, p.warning.main)).toBeGreaterThanOrEqual(4.5);
    });

    it(`${mode}: info contrast text on info main meets 4.5:1`, () => {
      expect(contrastRatio(p.info.contrastText, p.info.main)).toBeGreaterThanOrEqual(4.5);
    });

    it(`${mode}: status dark text on status light background meets 4.5:1`, () => {
      expect(contrastRatio(p.success.dark, p.success.light)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(p.error.dark, p.error.light)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(p.warning.dark, p.warning.light)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(p.info.dark, p.info.light)).toBeGreaterThanOrEqual(4.5);
    });
  });
});
