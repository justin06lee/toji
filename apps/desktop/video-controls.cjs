'use strict';

// Two things Toji adds to video on every page.
//
// PICTURE IN PICTURE. A small button lives at the top-right corner of any video that is
// playing. It is invisible until the pointer comes near that corner, fades in, and one
// click pops the video out into the system's floating picture-in-picture window (which
// on macOS has rounded corners of its own); a second click brings it back. Sites' own
// controls are untouched — the button is Toji's, drawn above the page.
//
// THE SPACE BAR. Pressing space pauses whatever is playing, and pressing it again
// resumes what was paused. Pages that already handle space (YouTube does, when its
// player has the keyboard) keep doing so: Toji only acts when the page let the key
// through, and never while something is being typed.
//
// The file is both a module and a session preload (see installGuestFixups in main.cjs).
// A sandboxed preload cannot require() a sibling, so the page-side code lives in the
// file that is registered; the parts that can be exercised without a browser are exported.

/** Videos smaller than this are thumbnails and hover previews, not something to pop out. */
const MIN_WIDTH = 200;
const MIN_HEIGHT = 112;
/** The corner zone: this far from the video's top-right corner, the button appears. */
const ZONE_WIDTH = 180;
const ZONE_HEIGHT = 120;
/** Slack past the edge, so a pointer skimming the border still counts. */
const ZONE_SLACK = 12;
const BUTTON_SIZE = 32;
const BUTTON_INSET = 12;
/** How long the button lingers once the pointer leaves the corner. */
const LINGER_MS = 260;

const PIP_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3"/><path d="M3 6v12a2 2 0 0 0 2 2h5"/><rect x="13" y="13" width="9" height="7" rx="1.5"/></svg>';

/** Is this video something a person is watching? Started, and big enough to matter. */
function isWatchable(video) {
  if (!video || !video.isConnected) return false;
  if (video.readyState < 1) return false;
  if (video.paused && !(video.currentTime > 0)) return false;
  const rect = video.getBoundingClientRect();
  return rect.width >= MIN_WIDTH && rect.height >= MIN_HEIGHT;
}

/** The zone, in viewport coordinates, that reveals a video's button. */
function cornerZone(rect) {
  return {
    left: Math.max(rect.left, rect.right - ZONE_WIDTH),
    right: rect.right + ZONE_SLACK,
    top: rect.top - ZONE_SLACK,
    bottom: Math.min(rect.bottom, rect.top + ZONE_HEIGHT)
  };
}

function inZone(point, rect) {
  const zone = cornerZone(rect);
  return point.x >= zone.left && point.x <= zone.right && point.y >= zone.top && point.y <= zone.bottom;
}

/**
 * The video whose corner the pointer is near, if any. When two overlap (a player and a
 * preview stacked on it) the larger wins, being the one that is actually being watched.
 */
function videoAtCorner(doc, point) {
  let best = null;
  let bestArea = 0;
  for (const video of doc.querySelectorAll('video')) {
    if (!isWatchable(video)) continue;
    const rect = video.getBoundingClientRect();
    if (!inZone(point, rect)) continue;
    const area = rect.width * rect.height;
    if (area > bestArea) {
      best = video;
      bestArea = area;
    }
  }
  return best;
}

/** Where the button sits for a video: inside its top-right corner. */
function buttonPosition(rect) {
  return { left: Math.round(rect.right - BUTTON_INSET - BUTTON_SIZE), top: Math.round(rect.top + BUTTON_INSET) };
}

function makeButton(doc) {
  const button = doc.createElement('button');
  button.type = 'button';
  button.setAttribute('data-toji', 'pip');
  button.setAttribute('aria-label', 'Picture in picture');
  button.title = 'Picture in picture';
  button.innerHTML = PIP_ICON;
  button.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    `width:${BUTTON_SIZE}px`,
    `height:${BUTTON_SIZE}px`,
    'margin:0',
    'padding:0',
    'border:0',
    'border-radius:9px',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'color:#fff',
    'background:rgba(0,0,0,0.62)',
    'backdrop-filter:blur(6px)',
    '-webkit-backdrop-filter:blur(6px)',
    'box-shadow:0 1px 4px rgba(0,0,0,0.35)',
    'cursor:pointer',
    'opacity:0',
    'pointer-events:none',
    'transition:opacity 180ms ease',
    'font:inherit',
    'line-height:0'
  ].join(';');
  button.addEventListener('mouseenter', () => (button.style.background = 'rgba(0,0,0,0.82)'));
  button.addEventListener('mouseleave', () => (button.style.background = 'rgba(0,0,0,0.62)'));
  return button;
}

/**
 * Wire the picture-in-picture button into a document. Returns a small controller —
 * `pointer(x, y)` feeds a pointer position (tests drive it directly; the page feeds it
 * from mousemove) and `stop()` tears everything down.
 */
function installPipButton(doc, options = {}) {
  const view = doc.defaultView;
  if (!view || !doc.pictureInPictureEnabled) return { pointer() {}, stop() {}, button: null };
  const setTimer = options.setTimeout || view.setTimeout.bind(view);
  const clearTimer = options.clearTimeout || view.clearTimeout.bind(view);
  const button = makeButton(doc);
  let target = null;
  let lingerTimer = null;
  let frame = null;

  const mount = () => {
    if (button.isConnected) return;
    (doc.body || doc.documentElement).appendChild(button);
  };
  const place = () => {
    if (!target || !isWatchable(target)) return hide();
    const { left, top } = buttonPosition(target.getBoundingClientRect());
    button.style.left = `${left}px`;
    button.style.top = `${top}px`;
    const popped = doc.pictureInPictureElement === target;
    button.title = popped ? 'Back from picture in picture' : 'Picture in picture';
    button.setAttribute('aria-label', button.title);
  };
  const follow = () => {
    frame = null;
    if (!target) return;
    place();
    if (button.style.opacity === '1') frame = view.requestAnimationFrame(follow);
  };
  const show = (video) => {
    if (lingerTimer !== null) {
      clearTimer(lingerTimer);
      lingerTimer = null;
    }
    target = video;
    mount();
    place();
    button.style.pointerEvents = 'auto';
    button.style.opacity = '1';
    if (frame === null) frame = view.requestAnimationFrame(follow);
  };
  const hide = () => {
    target = null;
    button.style.opacity = '0';
    button.style.pointerEvents = 'none';
  };
  const linger = () => {
    if (lingerTimer !== null || !target) return;
    lingerTimer = setTimer(() => {
      lingerTimer = null;
      hide();
    }, LINGER_MS);
  };

  const pointer = (x, y) => {
    if (doc.fullscreenElement) return hide(); // the page owns a full-screen video
    const rect = button.getBoundingClientRect();
    const onButton = target && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    if (onButton) return;
    const video = videoAtCorner(doc, { x, y });
    if (video) show(video);
    else linger();
  };

  const toggle = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const video = target;
    if (!video) return;
    try {
      if (doc.pictureInPictureElement === video) await doc.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch {
      /* the site forbids it, or the video is not ready — nothing to do */
    }
    place();
  };
  button.addEventListener('click', toggle);
  const onMove = (event) => pointer(event.clientX, event.clientY);
  const onLeave = () => linger();
  doc.addEventListener('mousemove', onMove, { passive: true });
  doc.addEventListener('mouseleave', onLeave);

  return {
    button,
    pointer,
    stop() {
      doc.removeEventListener('mousemove', onMove);
      doc.removeEventListener('mouseleave', onLeave);
      if (frame !== null) view.cancelAnimationFrame(frame);
      if (lingerTimer !== null) clearTimer(lingerTimer);
      button.remove();
    }
  };
}

// ---- the space bar -----------------------------------------------------------------

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
/** Focused things that already do something on space — leave the key to them. */
const SPACE_OWNERS = 'button, a[href], summary, video, audio, [role="button"], [role="checkbox"], [role="switch"], [role="menuitem"], [role="option"], [role="tab"], [role="slider"]';

function isTyping(el) {
  if (!el || typeof el.closest !== 'function') return false;
  return Boolean(el.closest(EDITABLE)) || Boolean(el.isContentEditable);
}

function ownsSpace(el) {
  return Boolean(el && typeof el.closest === 'function' && el.closest(SPACE_OWNERS));
}

function isPlaying(video) {
  return video.isConnected && !video.paused && !video.ended && video.readyState > 0;
}

/**
 * The space-bar toggle: decides, for one keydown, what to do with a document's videos.
 * Exposed as a function of the document plus a little memory so tests can drive it.
 *
 * Returns true when the key was taken.
 */
function createSpaceToggle(doc) {
  let paused = []; // what the last press paused, to resume on the next
  let last = null; // the video most recently started by anyone

  doc.addEventListener('play', (event) => {
    if (event.target && event.target.tagName === 'VIDEO') last = event.target;
  }, true);

  return function toggle(event) {
    if (event.key !== ' ' && event.code !== 'Space') return false;
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return false;
    const target = event.target;
    if (isTyping(target) || isTyping(doc.activeElement) || ownsSpace(target) || ownsSpace(doc.activeElement)) return false;
    const videos = Array.from(doc.querySelectorAll('video'));
    const playing = videos.filter(isPlaying);
    if (playing.length > 0) {
      for (const video of playing) video.pause();
      paused = playing;
      event.preventDefault();
      return true;
    }
    let resume = paused.filter((video) => video.isConnected && video.paused);
    if (resume.length === 0 && last && last.isConnected && last.paused) resume = [last];
    if (resume.length === 0) {
      const started = videos.filter((video) => video.paused && video.currentTime > 0);
      if (started.length > 0) resume = [started[0]];
    }
    if (resume.length === 0) return false;
    paused = [];
    for (const video of resume) {
      const result = video.play();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    }
    event.preventDefault();
    return true;
  };
}

function installSpaceToggle(doc) {
  const view = doc.defaultView;
  if (!view) return () => {};
  const toggle = createSpaceToggle(doc);
  // On the window and bubbling, so the page's own handlers (YouTube's live on the
  // document) have already had the key, and their preventDefault is visible here.
  view.addEventListener('keydown', toggle);
  return () => view.removeEventListener('keydown', toggle);
}

if (typeof module === 'object' && module) {
  module.exports = { isWatchable, cornerZone, videoAtCorner, buttonPosition, installPipButton, createSpaceToggle, installSpaceToggle, BUTTON_SIZE, BUTTON_INSET, LINGER_MS };
}

// As a preload: every guest frame gets both.
if (typeof document !== 'undefined' && typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) {
  installPipButton(document);
  installSpaceToggle(document);
}
