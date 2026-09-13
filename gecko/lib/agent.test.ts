import { describe, expect, it } from 'vitest';
import { appendMemory, captureScale, clip, glidePath, isBlankPage, pressKey, stepBudget, toPagePoint, waitMs } from './agent';

describe('toPagePoint', () => {
  const shot = { width: 1400, height: 875, viewport: { w: 1600, h: 1000 } };

  it('scales screenshot pixels to CSS pixels', () => {
    expect(toPagePoint(700, 437.5, shot)).toEqual({ x: 800, y: 500 });
  });

  it('accepts 0..1 fractions', () => {
    expect(toPagePoint(0.5, 0.25, shot)).toEqual({ x: 800, y: 250 });
  });

  it('clamps inside the viewport', () => {
    expect(toPagePoint(99999, -5, shot)).toEqual({ x: 1599, y: 0 });
  });

  it('passes points through without a viewport', () => {
    expect(toPagePoint(12.4, 7.6, {})).toEqual({ x: 12, y: 8 });
  });
});

describe('captureScale', () => {
  it('keeps the long edge at or under the limit', () => {
    const s = captureScale({ w: 1600, h: 1000 }, 2, 1400);
    expect(1600 * s).toBeCloseTo(1400);
  });

  it('never upscales past the device pixel ratio', () => {
    expect(captureScale({ w: 400, h: 300 }, 1, 1400)).toBe(1);
  });
});

describe('glidePath', () => {
  it('ends exactly at the target, 11 ms per step, 10–30 steps', () => {
    const p = glidePath({ x: 0, y: 0 }, { x: 800, y: 0 }, 1);
    expect(p.at(-1)).toEqual({ x: 800, y: 0, at: p.length * 11 });
    expect(p.length).toBe(30);
    expect(glidePath({ x: 0, y: 0 }, { x: 20, y: 0 }, 1)).toHaveLength(10);
  });

  it('bows to the side it is told', () => {
    const left = glidePath({ x: 0, y: 0 }, { x: 400, y: 0 }, 1);
    const right = glidePath({ x: 0, y: 0 }, { x: 400, y: 0 }, -1);
    const mid = Math.floor(left.length / 2);
    expect(Math.sign(left[mid].y)).toBe(-Math.sign(right[mid].y));
    expect(Math.abs(left[mid].y)).toBeLessThanOrEqual(80);
  });

  it('is a single point for a zero-length move', () => {
    expect(glidePath({ x: 5, y: 5 }, { x: 5, y: 5 }, 1)).toEqual([{ x: 5, y: 5, at: 0 }]);
  });
});

describe('small rules', () => {
  it('clamps waits', () => {
    expect(waitMs(undefined)).toBe(2500);
    expect(waitMs(10)).toBe(800);
    expect(waitMs(99999)).toBe(8000);
  });

  it('keeps the tail of memory', () => {
    expect(appendMemory('', 'a')).toBe('a');
    expect(appendMemory('abc', 'def', 5)).toBe('c\ndef');
  });

  it('computes the step budget', () => {
    expect(stepBudget(40, false)).toBe(40);
    expect(stepBudget(0, false)).toBe(1);
    expect(stepBudget(5, true)).toBe(Infinity);
  });

  it('clips', () => {
    expect(clip('hello world', 6)).toBe('hello…');
    expect(clip('hi', 6)).toBe('hi');
  });

  it('knows pages the agent must leave', () => {
    expect(isBlankPage('about:start')).toBe(true);
    expect(isBlankPage('https://example.com')).toBe(false);
  });

  it('maps key names', () => {
    expect(pressKey(undefined)?.key).toBe('Enter');
    expect(pressKey('arrow_down')?.key).toBe('ArrowDown');
    expect(pressKey('a')).toEqual({ key: 'a', code: '', keyCode: 0 });
    expect(pressKey('Hyper')).toBeNull();
  });
});
