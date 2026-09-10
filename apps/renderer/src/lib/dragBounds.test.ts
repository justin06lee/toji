import { describe, expect, it } from 'vitest';
import { dragBoundsX, dragBoundsY } from './dragBounds';

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

describe('dragBoundsX', () => {
  it('lets an item travel to either edge of its container and no further', () => {
    expect(dragBoundsX(rect(300, 0, 100, 30), rect(100, 0, 600, 30))).toEqual({ left: -200, right: 300 });
  });
  it('pins an item already at an edge', () => {
    expect(dragBoundsX(rect(100, 0, 100, 30), rect(100, 0, 600, 30))).toEqual({ left: 0, right: 500 });
    expect(dragBoundsX(rect(600, 0, 100, 30), rect(100, 0, 600, 30))).toEqual({ left: -500, right: 0 });
  });
  it('never demands a move from an item scrolled partly out of view', () => {
    // Overflowing strip: the last tab starts beyond the right edge. It may come left,
    // and its rest position stays allowed rather than being yanked into view.
    expect(dragBoundsX(rect(742, 0, 104, 30), rect(94, 0, 640, 30))).toEqual({ left: -648, right: 0 });
    expect(dragBoundsX(rect(60, 0, 104, 30), rect(94, 0, 640, 30))).toEqual({ left: 0, right: 570 });
  });
});

describe('dragBoundsY', () => {
  it('mirrors the horizontal bounds vertically', () => {
    expect(dragBoundsY(rect(0, 120, 200, 32), rect(0, 40, 200, 400))).toEqual({ top: -80, bottom: 288 });
    expect(dragBoundsY(rect(0, 500, 200, 32), rect(0, 40, 200, 400))).toEqual({ top: -460, bottom: 0 });
  });
});
