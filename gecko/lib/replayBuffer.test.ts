import { describe, expect, test } from 'vitest';
import { ReplayBuffer, ReplayClock, type ReplayChunk } from './replayBuffer';

const FRAME = 66_667; // 15 fps
const SECOND = 1_000_000;
const KEY_EVERY = 30; // a keyframe every 2 seconds

const chunk = (index: number, key = index % KEY_EVERY === 0): ReplayChunk => ({ timestamp: index * FRAME, duration: FRAME, key, data: new Uint8Array([index % 256]) });

function recorded(seconds: number): ReplayBuffer {
  const buffer = new ReplayBuffer(15 * SECOND, 3 * FRAME);
  for (let i = 0; i < seconds * 15; i += 1) buffer.push(chunk(i));
  return buffer;
}

const span = (clip: ReplayChunk[]) => clip[clip.length - 1].timestamp + clip[clip.length - 1].duration;

describe('ReplayBuffer', () => {
  test('a clip covers the whole window, starts on a keyframe, and is timed from zero', () => {
    const clip = recorded(40).clip();
    expect(clip[0].key).toBe(true);
    expect(clip[0].timestamp).toBe(0);
    expect(span(clip)).toBeGreaterThanOrEqual(15 * SECOND);
    // No more than one keyframe interval beyond the window.
    expect(span(clip)).toBeLessThanOrEqual(17 * SECOND + FRAME);
  });

  test('keeps only what a clip can use, however long it records', () => {
    const buffer = recorded(600);
    const everything = buffer.clip(Number.POSITIVE_INFINITY);
    expect(everything.length).toBeLessThanOrEqual(17 * 15 + 1);
    expect(everything[0].key).toBe(true);
  });

  test('a short recording gives what there is', () => {
    const clip = recorded(4).clip();
    expect(clip).toHaveLength(60);
    expect(clip[0].key).toBe(true);
  });

  test('frames before the first keyframe are never kept', () => {
    const buffer = new ReplayBuffer(15 * SECOND, 3 * FRAME);
    buffer.push(chunk(1, false));
    buffer.push(chunk(2, false));
    expect(buffer.isEmpty).toBe(true);
    buffer.push(chunk(3, true));
    expect(buffer.clip().map((c) => c.data[0])).toEqual([3]);
  });

  test('after a clear, nothing is kept until the next keyframe', () => {
    const buffer = recorded(10);
    buffer.clear();
    buffer.push(chunk(151, false));
    expect(buffer.isEmpty).toBe(true);
    buffer.push(chunk(152, true));
    buffer.push(chunk(153, false));
    expect(buffer.clip().map((c) => c.data[0])).toEqual([152, 153]);
  });

  test('a gap longer than the limit is closed up in the clip', () => {
    const buffer = new ReplayBuffer(15 * SECOND, 3 * FRAME);
    buffer.push(chunk(0, true));
    buffer.push(chunk(1, false));
    buffer.push({ ...chunk(0, true), timestamp: 60 * SECOND });
    const clip = buffer.clip(Number.POSITIVE_INFINITY);
    expect(clip.map((c) => c.timestamp)).toEqual([0, FRAME, FRAME + 3 * FRAME]);
  });
});

describe('ReplayClock', () => {
  test('follows real time between frames and caps a pause', () => {
    const clock = new ReplayClock(200_000);
    expect(clock.stamp(1000)).toBe(0);
    expect(clock.stamp(1066.667)).toBe(66_667);
    // Paused for a minute: the recording moves on by the cap, not by the minute.
    expect(clock.stamp(61_066.667)).toBe(266_667);
  });

  test('never repeats or goes back, even when the timer bunches frames', () => {
    const clock = new ReplayClock(200_000);
    const stamps = [5, 5, 5, 4, 70].map((ms) => clock.stamp(ms));
    for (let i = 1; i < stamps.length; i += 1) expect(stamps[i]).toBeGreaterThan(stamps[i - 1]);
  });
});
