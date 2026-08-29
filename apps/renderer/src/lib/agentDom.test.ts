import { describe, expect, test } from 'vitest';
import { toPagePoint } from './agentDom';

// The screenshot is captured in DEVICE pixels and then downscaled, so the image the model
// reads is almost never the same size as the CSS viewport the mouse works in. Getting this
// mapping wrong doesn't error — it just clicks the wrong thing — so it is pinned here.
describe('toPagePoint', () => {
  const retina = { width: 1400, height: 833, viewport: { w: 1512, h: 900 } };

  test('scales image pixels to CSS pixels', () => {
    // The centre of the image is the centre of the viewport, whatever the capture scale:
    // 700/1400 of the way across a 1512px viewport is 756.
    expect(toPagePoint(700, 416, retina)).toEqual({ x: 756, y: 449 });
    expect(toPagePoint(0, 0, retina)).toEqual({ x: 0, y: 0 });
    // A point read off the right-hand third of the image lands there on the page too.
    expect(toPagePoint(1050, 200, retina)).toEqual({ x: 1134, y: 216 });
  });

  test('is identity when the capture already matches the viewport', () => {
    const same = { width: 1200, height: 800, viewport: { w: 1200, h: 800 } };
    expect(toPagePoint(345, 678, same)).toEqual({ x: 345, y: 678 });
  });

  test('treats a 0..1 pair as a fraction of the viewport', () => {
    expect(toPagePoint(0.5, 0.5, retina)).toEqual({ x: 756, y: 450 });
    expect(toPagePoint(1, 1, retina)).toEqual({ x: 1512, y: 900 });
  });

  test('clamps a point past the edge into the viewport', () => {
    // A model that overshoots must not produce an out-of-bounds click.
    expect(toPagePoint(9999, 9999, retina)).toEqual({ x: 1511, y: 899 });
  });

  test('passes coordinates through when the viewport is unknown', () => {
    expect(toPagePoint(120, 240, { width: 800, height: 600 })).toEqual({ x: 120, y: 240 });
  });
});
