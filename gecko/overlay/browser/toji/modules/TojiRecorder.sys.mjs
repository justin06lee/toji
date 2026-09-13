/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The rolling "last 15 seconds" behind bug reports. Each window records itself:
// drawSnapshot of the window's own (chrome) WindowGlobal, which stitches in the
// page, so no Screen Recording permission is involved. Frames are encoded as
// they come (WebCodecs, hardware H.264 first) into a buffer that keeps only what
// a clip can use; nothing is written anywhere until a report sends it.
//
// Never recorded: Private and Tor windows (ephemeral or Tor containers, and
// hold-to-Tor), a window that isn't the focused one, or anything while the
// Settings switch is off (toji.replay).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  TojiContainers: "resource:///modules/toji/TojiContainers.sys.mjs",
  TojiWindows: "resource:///modules/toji/TojiWindows.sys.mjs",
});
// gecko/lib bundles export plain functions, so each of these holds the whole module.
ChromeUtils.defineLazyGetter(lazy, "ReplayBuffer", () =>
  ChromeUtils.importESModule("resource:///modules/toji/lib/replayBuffer.sys.mjs")
);
ChromeUtils.defineLazyGetter(lazy, "ReplayMux", () =>
  ChromeUtils.importESModule("resource:///modules/toji/lib/replayMux.sys.mjs")
);

const SECONDS = 15;
const FPS = 15;
const FRAME_US = Math.round(1_000_000 / FPS);
const KEYFRAME_EVERY_US = 2_000_000;
const MAX_EDGE = 1920;
const PREF = "toji.replay";

const even = v => Math.max(2, Math.round(v / 2) * 2);

async function chooseCodec(win, width, height) {
  const bitrate = Math.round(Math.min(3_500_000, Math.max(1_000_000, width * height * FPS * 0.07)));
  const base = { width, height, bitrate, framerate: FPS, latencyMode: "realtime", bitrateMode: "variable" };
  const candidates = [
    { config: { ...base, codec: "avc1.640033", hardwareAcceleration: "prefer-hardware", avc: { format: "avc" } }, mux: "avc", container: "mp4" },
    { config: { ...base, codec: "avc1.640033", avc: { format: "avc" } }, mux: "avc", container: "mp4" },
    { config: { ...base, codec: "vp09.00.41.08" }, mux: "vp9", container: "mp4" },
    { config: { ...base, codec: "vp8" }, mux: "vp8", container: "webm" },
  ];
  for (const candidate of candidates) {
    try {
      if ((await win.VideoEncoder.isConfigSupported(candidate.config)).supported) {
        return candidate;
      }
    } catch {}
  }
  return null;
}

class WindowRecorder {
  state = "idle";
  #win;
  #buffer = new lazy.ReplayBuffer.ReplayBuffer(SECONDS * 1_000_000, 3 * FRAME_US);
  #clock = new lazy.ReplayBuffer.ReplayClock(3 * FRAME_US);
  #encoder = null;
  #codec = null;
  #decoderConfig = null;
  #timer = null;
  #busy = false;
  #width = 0;
  #height = 0;
  #scale = 1;
  #lastKeyUs = -Infinity;
  #needKey = true;
  #lastBitmapCanvas = null;
  /** Capture timing, for the feasibility check: frames taken and ms spent. */
  stats = { frames: 0, captureMs: 0, skippedBusy: 0, since: 0 };

  constructor(win) {
    this.#win = win;
  }

  #paused() {
    const win = this.#win;
    if (!Services.prefs.getBoolPref(PREF, true)) {
      return true;
    }
    if (Services.focus.activeWindow !== win || win.document.hidden) {
      return true;
    }
    if (win.document.documentElement.hasAttribute("toji-picking")) {
      return true;
    }
    const id = lazy.TojiWindows.containerOf(win);
    const c = id ? lazy.TojiContainers.byId(id) : null;
    return !c || c.ephemeral || c.egress === "tor";
  }

  async start() {
    const win = this.#win;
    if (this.state !== "idle") {
      return;
    }
    if (typeof win.VideoEncoder === "undefined" || typeof win.VideoFrame === "undefined") {
      this.state = "unsupported";
      return;
    }
    this.state = "starting";
    const dpr = win.devicePixelRatio || 1;
    this.#scale = Math.min(dpr, MAX_EDGE / Math.max(win.innerWidth, win.innerHeight));
    this.#width = even(win.innerWidth * this.#scale);
    this.#height = even(win.innerHeight * this.#scale);
    const codec = await chooseCodec(win, this.#width, this.#height);
    if (!codec) {
      this.state = "unsupported";
      return;
    }
    this.#codec = codec;
    this.#encoder = new win.VideoEncoder({
      output: (chunk, meta) => this.#take(chunk, meta),
      error: e => this.#fail(e),
    });
    this.#encoder.configure(codec.config);
    this.stats = { frames: 0, captureMs: 0, skippedBusy: 0, since: Date.now() };
    this.#timer = win.setInterval(() => this.#tick(), Math.round(1000 / FPS));
    this.state = "recording";
  }

  async #tick() {
    const win = this.#win;
    const encoder = this.#encoder;
    if (!encoder || encoder.state !== "configured") {
      return;
    }
    if (this.#paused()) {
      this.#needKey = true;
      return;
    }
    if (this.#busy) {
      this.stats.skippedBusy++;
      return;
    }
    if (encoder.encodeQueueSize > 2) {
      return;
    }
    this.#busy = true;
    let bitmap = null;
    try {
      const t0 = Date.now();
      bitmap = await win.browsingContext.currentWindowGlobal.drawSnapshot(
        null,
        this.#scale,
        "rgb(255,255,255)"
      );
      this.stats.captureMs += Date.now() - t0;
      this.stats.frames++;
      const timestamp = this.#clock.stamp(Date.now());
      let source = bitmap;
      if (bitmap.width !== this.#width || bitmap.height !== this.#height) {
        // The window was resized: letterbox into the encoder's size.
        const canvas = (this.#lastBitmapCanvas ??= new OffscreenCanvas(this.#width, this.#height));
        const ctx = canvas.getContext("2d");
        const s = Math.min(this.#width / bitmap.width, this.#height / bitmap.height);
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, this.#width, this.#height);
        ctx.drawImage(bitmap, (this.#width - bitmap.width * s) / 2, (this.#height - bitmap.height * s) / 2, bitmap.width * s, bitmap.height * s);
        source = canvas;
      }
      const frame = new win.VideoFrame(source, { timestamp, duration: FRAME_US });
      const keyFrame = this.#needKey || timestamp - this.#lastKeyUs >= KEYFRAME_EVERY_US;
      if (keyFrame) {
        this.#lastKeyUs = timestamp;
        this.#needKey = false;
      }
      try {
        encoder.encode(frame, { keyFrame });
      } finally {
        frame.close();
      }
    } catch (e) {
      // A frame that couldn't be taken (window closing, mid-resize) is skipped.
    } finally {
      bitmap?.close();
      this.#busy = false;
    }
  }

  #take(chunk, meta) {
    if (meta?.decoderConfig) {
      this.#decoderConfig = meta.decoderConfig;
    }
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.#buffer.push({
      timestamp: chunk.timestamp,
      duration: chunk.duration ?? FRAME_US,
      key: chunk.type === "key",
      data,
    });
  }

  #fail(e) {
    console.warn("[toji:replay]", e?.message ?? e);
    this.stop();
    this.state = "failed";
  }

  stop() {
    if (this.#timer !== null) {
      this.#win.clearInterval(this.#timer);
    }
    this.#timer = null;
    try {
      if (this.#encoder && this.#encoder.state !== "closed") {
        this.#encoder.close();
      }
    } catch {}
    this.#encoder = null;
    this.#buffer.clear();
    this.state = "idle";
  }

  /** Measured capture rate while recording, for the feasibility check. */
  measured() {
    const seconds = Math.max(1, (Date.now() - this.stats.since) / 1000);
    return {
      fps: this.stats.frames / seconds,
      avgCaptureMs: this.stats.frames ? this.stats.captureMs / this.stats.frames : null,
      skippedBusy: this.stats.skippedBusy,
      width: this.#width,
      height: this.#height,
      codec: this.#codec?.config.codec ?? null,
    };
  }

  /** The last 15 recorded seconds as a video file, or null. */
  async clip() {
    const encoder = this.#encoder;
    if (!encoder || !this.#codec) {
      return null;
    }
    try {
      if (encoder.state === "configured") {
        await encoder.flush();
      }
    } catch {}
    const chunks = this.#buffer.clip();
    if (!chunks.length || !this.#decoderConfig) {
      return null;
    }
    const { data, type } = await lazy.ReplayMux.muxClip(chunks, {
      container: this.#codec.container,
      codec: this.#codec.mux,
      decoderConfig: this.#decoderConfig,
    });
    const last = chunks[chunks.length - 1];
    return { type, data, seconds: (last.timestamp + last.duration) / 1_000_000 };
  }
}

const recorders = new WeakMap();

export const TojiRecorder = {
  initWindow(win) {
    const recorder = new WindowRecorder(win);
    recorders.set(win, recorder);
    // Starting costs a codec probe; do it once the window has settled.
    win.setTimeout(() => recorder.start().catch(e => console.warn("[toji:replay]", e)), 3000);
    win.addEventListener("unload", () => recorder.stop(), { once: true });
  },

  get(win) {
    return recorders.get(win) ?? null;
  },

  /** The report's clip for this window (and a poster), or null. */
  async clip(win) {
    const recorder = recorders.get(win);
    if (!recorder || recorder.state !== "recording") {
      return null;
    }
    return recorder.clip();
  },
};
