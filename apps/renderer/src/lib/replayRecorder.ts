// The rolling recording behind "report the last 15 seconds".
//
// The window records itself: Chromium's tab capture of this renderer, which includes
// every <webview> composited into it and needs no screen-recording permission. Each
// frame is encoded as it arrives (WebCodecs; hardware H.264 where the machine has it)
// into a ReplayBuffer that keeps only what a clip can use. Nothing is written anywhere —
// the video lives in memory until a report sends it or the window closes.

import { REPLAY_SECONDS } from './bugReport';
import { ReplayBuffer, ReplayClock, type ReplayChunk } from './replayBuffer';

const FPS = 15;
const FRAME_US = Math.round(1_000_000 / FPS);
/** A keyframe this often bounds how much older video a clip must carry to start cleanly. */
const KEYFRAME_EVERY_US = 2_000_000;
/** The long edge of the recorded frame: UI text stays readable, the file stays attachable. */
const MAX_EDGE = 1920;

export interface ReplayClip {
  blob: Blob;
  /** video/mp4 (H.264 or VP9) or video/webm (VP8). */
  type: string;
  seconds: number;
  width: number;
  height: number;
  /** The window at the moment the clip was taken, as a PNG. */
  poster: Blob | null;
}

export type ReplayState = 'idle' | 'starting' | 'recording' | 'unsupported' | 'failed';

interface CodecChoice {
  config: VideoEncoderConfig;
  /** The codec as the muxer names it. */
  mux: 'avc' | 'vp9' | 'vp8';
  container: 'mp4' | 'webm';
}

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

/** The first encoder this machine can run, hardware H.264 first: it costs almost nothing to keep running. */
async function chooseCodec(width: number, height: number): Promise<CodecChoice | null> {
  // Screen content compresses well; this reads cleanly and keeps 17 s under GitHub's 10 MB video limit.
  const bitrate = Math.round(Math.min(3_500_000, Math.max(1_000_000, width * height * FPS * 0.07)));
  const base = { width, height, bitrate, framerate: FPS, latencyMode: 'realtime' as const, bitrateMode: 'variable' as const };
  const candidates: CodecChoice[] = [
    { config: { ...base, codec: 'avc1.640033', hardwareAcceleration: 'prefer-hardware', avc: { format: 'avc' } }, mux: 'avc', container: 'mp4' },
    { config: { ...base, codec: 'avc1.640033', avc: { format: 'avc' } }, mux: 'avc', container: 'mp4' },
    { config: { ...base, codec: 'vp09.00.41.08' }, mux: 'vp9', container: 'mp4' },
    { config: { ...base, codec: 'vp8' }, mux: 'vp8', container: 'webm' }
  ];
  for (const candidate of candidates) {
    try {
      if ((await VideoEncoder.isConfigSupported(candidate.config)).supported) return candidate;
    } catch {
      // Not this one.
    }
  }
  return null;
}

/** Wrap encoded chunks in a file. The muxer loads only when a report asks for a clip. */
async function muxClip(chunks: ReplayChunk[], codec: CodecChoice, decoderConfig: VideoDecoderConfig): Promise<Blob> {
  const { BufferTarget, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output, WebMOutputFormat } = await import('mediabunny');
  const target = new BufferTarget();
  const output = new Output({ format: codec.container === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(), target });
  const source = new EncodedVideoPacketSource(codec.mux);
  output.addVideoTrack(source);
  await output.start();
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const next = chunks[index + 1];
    const duration = (next ? next.timestamp - chunk.timestamp : chunk.duration) / 1_000_000;
    const packet = new EncodedPacket(chunk.data, chunk.key ? 'key' : 'delta', chunk.timestamp / 1_000_000, duration);
    await source.add(packet, index === 0 ? { decoderConfig } : undefined);
  }
  await output.finalize();
  if (!target.buffer) throw new Error('the recording could not be written');
  return new Blob([target.buffer], { type: codec.container === 'mp4' ? 'video/mp4' : 'video/webm' });
}

export class ReplayRecorder {
  private readonly buffer = new ReplayBuffer(REPLAY_SECONDS * 1_000_000, 3 * FRAME_US);
  private readonly clock = new ReplayClock(3 * FRAME_US);
  /** Why frames are not being taken right now; recording runs while this is empty. */
  private readonly pauses = new Set<string>();
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private encoder: VideoEncoder | null = null;
  private codec: CodecChoice | null = null;
  private decoderConfig: VideoDecoderConfig | null = null;
  /** Draws frames whose size no longer matches the encoder (the window was resized). */
  private fitCanvas: OffscreenCanvas | null = null;
  private timer: number | null = null;
  private width = 0;
  private height = 0;
  private lastKeyUs = -Infinity;
  private needKey = true;
  private stopped = false;
  state: ReplayState = 'idle';

  constructor(
    /** A capture id for this window from the main process (valid for a few seconds). */
    private readonly sourceId: () => Promise<string | null>,
    private readonly onState?: (state: ReplayState) => void
  ) {}

  async start(): Promise<void> {
    if (this.state !== 'idle') return;
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return this.setState('unsupported');
    this.setState('starting');
    try {
      const id = await this.sourceId();
      if (!id) throw new Error('no capture source for this window');
      // Capture comes back at exactly the size asked for, letterboxed if the window later
      // changes shape, so ask for the window's own shape at its pixel density, capped.
      const dpr = window.devicePixelRatio || 1;
      const scale = Math.min(1, MAX_EDGE / Math.max(window.innerWidth * dpr, window.innerHeight * dpr));
      const width = even(window.innerWidth * dpr * scale);
      const height = even(window.innerHeight * dpr * scale);
      const constraints = { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: id, minWidth: width, maxWidth: width, minHeight: height, maxHeight: height, maxFrameRate: FPS } };
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: constraints as unknown as MediaTrackConstraints });
      this.stream = stream;
      if (this.stopped) return this.release();
      const video = document.createElement('video');
      video.muted = true;
      video.srcObject = stream;
      video.setAttribute('aria-hidden', 'true');
      // It must be in the document to keep decoding, and must never show.
      video.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
      document.body.appendChild(video);
      this.video = video;
      await video.play();
      const codec = await chooseCodec(width, height);
      if (this.stopped) return this.release();
      if (!codec) {
        this.release();
        return this.setState('unsupported');
      }
      const encoder = new VideoEncoder({ output: (chunk, meta) => this.take(chunk, meta), error: (error) => this.fail(error) });
      encoder.configure(codec.config);
      this.encoder = encoder;
      this.codec = codec;
      this.width = width;
      this.height = height;
      stream.getVideoTracks()[0]?.addEventListener('ended', () => this.fail(new Error('the window capture ended')));
      // The frame timer runs only while this window is focused and visible; a window in
      // the background has no timer at all rather than a timer that skips.
      window.addEventListener('focus', this.arm);
      window.addEventListener('blur', this.arm);
      document.addEventListener('visibilitychange', this.arm);
      this.arm();
      this.setState('recording');
    } catch (error) {
      this.fail(error);
    }
  }

  /** Stop recording for good and forget everything recorded. */
  stop(): void {
    this.stopped = true;
    this.release();
    if (this.state === 'starting' || this.state === 'recording') this.setState('idle');
  }

  /** Take no frames for `reason` until resume(reason). */
  pause(reason: string): void {
    this.pauses.add(reason);
    this.needKey = true;
  }

  resume(reason: string): void {
    this.pauses.delete(reason);
  }

  /** The last 15 recorded seconds as a video file, or null when there are none. */
  async snapshot(): Promise<ReplayClip | null> {
    const { encoder, codec } = this;
    if (!encoder || !codec) return null;
    // The poster is drawn now, before anything awaited lets the page paint over it.
    const poster = this.posterFrame();
    try {
      if (encoder.state === 'configured') await encoder.flush();
    } catch {
      // A closed encoder has nothing waiting.
    }
    const chunks = this.buffer.clip();
    if (!chunks.length || !this.decoderConfig) return null;
    const blob = await muxClip(chunks, codec, this.decoderConfig);
    const last = chunks[chunks.length - 1];
    return { blob, type: blob.type, seconds: (last.timestamp + last.duration) / 1_000_000, width: this.width, height: this.height, poster: await poster };
  }

  /** Arms the frame timer while the window is focused and visible, and drops it otherwise. */
  private arm = (): void => {
    const live = document.visibilityState !== 'hidden' && document.hasFocus() && !this.stopped;
    if (live && this.timer === null) {
      this.needKey = true;
      this.timer = window.setInterval(() => this.tick(), Math.round(1000 / FPS));
    } else if (!live && this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  };

  private tick(): void {
    const { video, encoder } = this;
    if (!video || !encoder || encoder.state !== 'configured') return;
    if (this.pauses.size || document.visibilityState === 'hidden' || !document.hasFocus() || video.readyState < 2) {
      this.needKey = true;
      return;
    }
    // A backed-up encoder skips a frame rather than building a queue.
    if (encoder.encodeQueueSize > 2) return;
    const timestamp = this.clock.stamp(performance.now());
    let frame: VideoFrame;
    try {
      frame = this.frameFrom(video, timestamp);
    } catch {
      return;
    }
    const keyFrame = this.needKey || timestamp - this.lastKeyUs >= KEYFRAME_EVERY_US;
    if (keyFrame) {
      this.lastKeyUs = timestamp;
      this.needKey = false;
    }
    try {
      encoder.encode(frame, { keyFrame });
    } finally {
      frame.close();
    }
  }

  /** The video's current frame at the encoder's size — scaled to fit if the capture has changed size. */
  private frameFrom(video: HTMLVideoElement, timestamp: number): VideoFrame {
    if (video.videoWidth === this.width && video.videoHeight === this.height) return new VideoFrame(video, { timestamp, duration: FRAME_US });
    const canvas = (this.fitCanvas ??= new OffscreenCanvas(this.width, this.height));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no canvas');
    const scale = Math.min(this.width / video.videoWidth, this.height / video.videoHeight);
    const w = video.videoWidth * scale;
    const h = video.videoHeight * scale;
    context.fillStyle = '#000';
    context.fillRect(0, 0, this.width, this.height);
    context.drawImage(video, (this.width - w) / 2, (this.height - h) / 2, w, h);
    return new VideoFrame(canvas, { timestamp, duration: FRAME_US });
  }

  private take(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void {
    if (meta?.decoderConfig) this.decoderConfig = meta.decoderConfig;
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.buffer.push({ timestamp: chunk.timestamp, duration: chunk.duration ?? FRAME_US, key: chunk.type === 'key', data });
  }

  private posterFrame(): Promise<Blob | null> {
    const video = this.video;
    if (!video || video.readyState < 2) return Promise.resolve(null);
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    canvas.getContext('2d')?.drawImage(video, 0, 0, this.width, this.height);
    return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
  }

  private fail(error: unknown): void {
    console.warn('[replay]', error instanceof Error ? error.message : error);
    this.release();
    this.setState('failed');
  }

  private release(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video?.remove();
    this.video = null;
    try {
      if (this.encoder && this.encoder.state !== 'closed') this.encoder.close();
    } catch {
      // Already closed.
    }
    this.encoder = null;
    this.buffer.clear();
  }

  private setState(state: ReplayState): void {
    this.state = state;
    this.onState?.(state);
  }
}
