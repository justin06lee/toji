// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BUTTON_INSET, BUTTON_SIZE, buttonPosition, createSpaceToggle, installPipButton, videoAtCorner } from './video-controls.cjs';

/** A video with a fixed place on screen and a playback state. jsdom lays nothing out. */
function video(rect: { left: number; top: number; width: number; height: number }, state: { paused?: boolean; currentTime?: number; readyState?: number } = {}) {
  const el = document.createElement('video');
  document.body.appendChild(el);
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON() {} })
  });
  let paused = state.paused ?? false;
  Object.defineProperty(el, 'paused', { get: () => paused, configurable: true });
  Object.defineProperty(el, 'readyState', { get: () => state.readyState ?? 4, configurable: true });
  Object.defineProperty(el, 'ended', { get: () => false, configurable: true });
  el.currentTime = state.currentTime ?? (paused ? 0 : 12);
  el.pause = vi.fn(() => {
    paused = true;
  });
  el.play = vi.fn(() => {
    paused = false;
    el.dispatchEvent(new Event('play'));
    return Promise.resolve();
  });
  return el;
}

beforeEach(() => {
  document.body.innerHTML = '';
  Object.defineProperty(document, 'pictureInPictureEnabled', { value: true, configurable: true });
  Object.defineProperty(document, 'pictureInPictureElement', { value: null, configurable: true, writable: true });
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 0)) as unknown as typeof requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof cancelAnimationFrame;
});
afterEach(() => vi.useRealTimers());

describe('which video the pointer is near', () => {
  test('a playing video is found from its top-right corner, and nowhere else', () => {
    const player = video({ left: 100, top: 100, width: 640, height: 360 });
    expect(videoAtCorner(document, { x: 700, y: 130 })).toBe(player);
    expect(videoAtCorner(document, { x: 745, y: 105 })).toBe(player); // just past the edge still counts
    expect(videoAtCorner(document, { x: 120, y: 130 })).toBeNull(); // top-left corner
    expect(videoAtCorner(document, { x: 700, y: 400 })).toBeNull(); // bottom-right corner
    expect(videoAtCorner(document, { x: 900, y: 130 })).toBeNull(); // off the video
  });

  test('thumbnails, previews and videos that never started are ignored', () => {
    video({ left: 100, top: 100, width: 160, height: 90 }); // hover preview
    video({ left: 100, top: 300, width: 640, height: 360 }, { paused: true, currentTime: 0 }); // poster
    video({ left: 100, top: 700, width: 640, height: 360 }, { readyState: 0 }); // no media yet
    expect(videoAtCorner(document, { x: 250, y: 105 })).toBeNull();
    expect(videoAtCorner(document, { x: 700, y: 330 })).toBeNull();
    expect(videoAtCorner(document, { x: 700, y: 730 })).toBeNull();
  });

  test('a paused video that was playing still offers the button', () => {
    const player = video({ left: 0, top: 0, width: 640, height: 360 }, { paused: true, currentTime: 30 });
    expect(videoAtCorner(document, { x: 600, y: 20 })).toBe(player);
  });

  test('the larger of two stacked videos wins', () => {
    video({ left: 0, top: 0, width: 320, height: 180 });
    const big = video({ left: 0, top: 0, width: 1280, height: 720 });
    expect(videoAtCorner(document, { x: 1200, y: 40 })).toBe(big);
  });

  test('the button sits inside the corner', () => {
    expect(buttonPosition({ left: 100, top: 50, right: 740, bottom: 410, width: 640, height: 360 })).toEqual({ left: 740 - BUTTON_INSET - BUTTON_SIZE, top: 50 + BUTTON_INSET });
  });
});

describe('the picture-in-picture button', () => {
  test('fades in near the corner, lingers briefly, then fades out', () => {
    vi.useFakeTimers();
    const player = video({ left: 100, top: 100, width: 640, height: 360 });
    const pip = installPipButton(document);
    expect(pip.button!.style.opacity).toBe('0');
    pip.pointer(700, 130);
    expect(pip.button!.isConnected).toBe(true);
    expect(pip.button!.style.opacity).toBe('1');
    expect(pip.button!.style.pointerEvents).toBe('auto');
    expect(pip.button!.style.left).toBe(`${740 - BUTTON_INSET - BUTTON_SIZE}px`);
    expect(pip.button!.style.top).toBe(`${100 + BUTTON_INSET}px`);
    pip.pointer(300, 300);
    expect(pip.button!.style.opacity).toBe('1'); // still there for a moment
    vi.advanceTimersByTime(400);
    expect(pip.button!.style.opacity).toBe('0');
    expect(pip.button!.style.pointerEvents).toBe('none');
    expect(player.isConnected).toBe(true);
    pip.stop();
  });

  test('clicking asks the video for picture in picture, and again brings it back', async () => {
    const player = video({ left: 100, top: 100, width: 640, height: 360 });
    const request = vi.fn(async () => {
      (document as { pictureInPictureElement: Element | null }).pictureInPictureElement = player;
    });
    const exit = vi.fn(async () => {
      (document as { pictureInPictureElement: Element | null }).pictureInPictureElement = null;
    });
    (player as unknown as { requestPictureInPicture: () => Promise<void> }).requestPictureInPicture = request;
    (document as unknown as { exitPictureInPicture: () => Promise<void> }).exitPictureInPicture = exit;
    const pip = installPipButton(document);
    pip.pointer(700, 130);
    pip.button!.click();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(pip.button!.title).toBe('Back from picture in picture');
    pip.button!.click();
    await Promise.resolve();
    expect(exit).toHaveBeenCalledTimes(1);
    pip.stop();
  });

  test('stays out of the way of a full-screen video', () => {
    video({ left: 0, top: 0, width: 1920, height: 1080 });
    Object.defineProperty(document, 'fullscreenElement', { value: document.body, configurable: true });
    const pip = installPipButton(document);
    pip.pointer(1900, 20);
    expect(pip.button!.style.opacity).toBe('0');
    Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
    pip.stop();
  });
});

describe('the space bar', () => {
  const press = (init: Partial<KeyboardEventInit> & { target?: Element } = {}) => {
    const { target, ...rest } = init;
    const event = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true, ...rest });
    if (target) Object.defineProperty(event, 'target', { value: target });
    return event;
  };

  test('pauses what is playing, then resumes exactly that', () => {
    const a = video({ left: 0, top: 0, width: 640, height: 360 });
    const b = video({ left: 0, top: 400, width: 640, height: 360 });
    const c = video({ left: 0, top: 800, width: 640, height: 360 }, { paused: true, currentTime: 5 });
    const toggle = createSpaceToggle(document);
    const first = press();
    expect(toggle(first)).toBe(true);
    expect(first.defaultPrevented).toBe(true);
    expect(a.pause).toHaveBeenCalled();
    expect(b.pause).toHaveBeenCalled();
    expect(c.pause).not.toHaveBeenCalled();
    const second = press();
    expect(toggle(second)).toBe(true);
    expect(a.play).toHaveBeenCalled();
    expect(b.play).toHaveBeenCalled();
    expect(c.play).not.toHaveBeenCalled();
  });

  test('with nothing paused by Toji, resumes the video that last played', () => {
    const a = video({ left: 0, top: 0, width: 640, height: 360 }, { paused: true, currentTime: 5 });
    const b = video({ left: 0, top: 400, width: 640, height: 360 }, { paused: true, currentTime: 5 });
    const toggle = createSpaceToggle(document);
    b.dispatchEvent(new Event('play')); // the site started b at some point
    expect(toggle(press())).toBe(true);
    expect(b.play).toHaveBeenCalled();
    expect(a.play).not.toHaveBeenCalled();
  });

  test('leaves the key alone while typing, on controls, or when the page took it', () => {
    const player = video({ left: 0, top: 0, width: 640, height: 360 });
    const toggle = createSpaceToggle(document);
    const input = document.createElement('input');
    document.body.appendChild(input);
    expect(toggle(press({ target: input }))).toBe(false);
    const button = document.createElement('button');
    document.body.appendChild(button);
    expect(toggle(press({ target: button }))).toBe(false);
    const taken = press();
    taken.preventDefault();
    expect(toggle(taken)).toBe(false);
    expect(toggle(press({ metaKey: true }))).toBe(false);
    expect(toggle(press({ key: 'k', code: 'KeyK' }))).toBe(false);
    expect(player.pause).not.toHaveBeenCalled();
  });

  test('does nothing on a page with no video to speak of', () => {
    const toggle = createSpaceToggle(document);
    const event = press();
    expect(toggle(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false); // the page scrolls as usual
  });
});
