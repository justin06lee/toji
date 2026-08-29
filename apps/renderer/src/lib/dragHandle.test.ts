import { describe, expect, test } from 'vitest';
import type { WindowCursor } from './bridge';
import { revealDragHandle } from './dragHandle';

const cursor = (next: Partial<WindowCursor> = {}): WindowCursor => ({
  x: 400,
  y: 20,
  width: 1480,
  height: 960,
  inside: true,
  ...next
});

describe('revealDragHandle', () => {
  test('reveals near the top edge', () => {
    expect(revealDragHandle(cursor({ y: 5 }), false, 'side')).toBe(true);
    expect(revealDragHandle(cursor({ y: 5 }), false, 'top')).toBe(true);
  });

  test('side mode reveals across the whole omnibox row, top mode only near the strip top', () => {
    expect(revealDragHandle(cursor({ y: 45 }), false, 'side')).toBe(true);
    expect(revealDragHandle(cursor({ y: 45 }), false, 'top')).toBe(false);
  });

  test('never reveals from the sidebar or page area', () => {
    // The sidebar starts below the header (~y 56); deep pointer positions stay hidden.
    expect(revealDragHandle(cursor({ y: 120 }), false, 'side')).toBe(false);
    expect(revealDragHandle(cursor({ y: 120 }), true, 'side')).toBe(false);
    expect(revealDragHandle(cursor({ y: 500 }), true, 'top')).toBe(false);
  });

  test('hysteresis: stays visible over the notch itself, below the show band', () => {
    expect(revealDragHandle(cursor({ y: 40 }), true, 'top')).toBe(true);
    expect(revealDragHandle(cursor({ y: 40 }), false, 'top')).toBe(false);
    expect(revealDragHandle(cursor({ y: 60 }), true, 'side')).toBe(true);
    expect(revealDragHandle(cursor({ y: 60 }), false, 'side')).toBe(false);
  });

  test('hides once the pointer leaves the window or focus is lost', () => {
    expect(revealDragHandle(cursor({ y: 5, inside: false }), true, 'side')).toBe(false);
    expect(revealDragHandle(cursor({ x: -1, y: -1, width: 0, height: 0, inside: false }), true, 'top')).toBe(false);
  });
});
