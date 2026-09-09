import { describe, expect, test } from 'vitest';
import { hexToHsv, hexToRgb, hsvToHex, hsvToRgb, normalizeHex, rgbToHex, rgbToHsv } from './color';

describe('normalizeHex', () => {
  test('accepts short, long, bare and upper-case forms', () => {
    expect(normalizeHex('#abc')).toBe('#aabbcc');
    expect(normalizeHex('ABC')).toBe('#aabbcc');
    expect(normalizeHex('#0EA5E9')).toBe('#0ea5e9');
    expect(normalizeHex('  0ea5e9 ')).toBe('#0ea5e9');
  });

  test('rejects anything that is not a colour', () => {
    expect(normalizeHex('')).toBeNull();
    expect(normalizeHex('#12')).toBeNull();
    expect(normalizeHex('#12345')).toBeNull();
    expect(normalizeHex('#gggggg')).toBeNull();
    expect(normalizeHex('rgb(1,2,3)')).toBeNull();
  });
});

describe('hex <-> rgb', () => {
  test('round-trips', () => {
    expect(hexToRgb('#0ea5e9')).toEqual([14, 165, 233]);
    expect(rgbToHex(14, 165, 233)).toBe('#0ea5e9');
    expect(rgbToHex(255.4, -3, 300)).toBe('#ff00ff');
  });
});

describe('hsv', () => {
  test('primary and neutral colours land where expected', () => {
    expect(rgbToHsv(255, 0, 0)).toEqual({ h: 0, s: 1, v: 1 });
    expect(rgbToHsv(0, 255, 0)).toEqual({ h: 120, s: 1, v: 1 });
    expect(rgbToHsv(0, 0, 255)).toEqual({ h: 240, s: 1, v: 1 });
    expect(rgbToHsv(0, 0, 0)).toEqual({ h: 0, s: 0, v: 0 });
    expect(rgbToHsv(255, 255, 255)).toEqual({ h: 0, s: 0, v: 1 });
  });

  test('round-trips every container preset through hex', () => {
    for (const hex of ['#0ea5e9', '#10b981', '#f59e0b', '#f43f5e', '#06b6d4', '#84cc16', '#f97316', '#64748b']) {
      expect(hsvToHex(hexToHsv(hex))).toBe(hex);
    }
  });

  test('keeps hue through zero saturation, which hex cannot', () => {
    // The picker holds HSV precisely so that dragging saturation to 0 and back does
    // not snap the hue slider to red.
    const grey = hsvToRgb({ h: 200, s: 0, v: 0.5 });
    expect(grey.map(Math.round)).toEqual([128, 128, 128]);
    expect(hsvToHex({ h: 200, s: 1, v: 1 })).toBe('#00aaff');
  });

  test('wraps hue outside 0–360', () => {
    expect(hsvToHex({ h: 360, s: 1, v: 1 })).toBe('#ff0000');
    expect(hsvToHex({ h: -120, s: 1, v: 1 })).toBe('#0000ff');
  });
});
