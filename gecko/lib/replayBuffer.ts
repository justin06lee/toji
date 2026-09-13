// What "report the last 15 seconds" keeps: encoded video, never raw frames, and only as
// much of it as a clip can still use.
//
// Video can only be cut at a keyframe, so the buffer holds the window plus the stretch
// before it back to the keyframe the window starts inside. The recorder asks for a
// keyframe every couple of seconds (see replayRecorder.ts), which bounds that slack to a
// few hundred kilobytes. Plain data only — no WebCodecs — so it is tested in Node.

export interface ReplayChunk {
  /** When the frame shows, on the recording's own timeline, in microseconds. */
  timestamp: number;
  /** How long it shows, in microseconds. */
  duration: number;
  /** A keyframe: playback can start here. */
  key: boolean;
  data: Uint8Array;
}

/**
 * The recording's timeline. Each frame is stamped with the time that passed since the
 * one before, but a pause — the window hidden, a private window, the report sheet open —
 * counts for no more than `maxStepUs`. The clip cuts straight across it instead of
 * holding a frozen frame, and "the last 15 seconds" means the last 15 seconds that were
 * actually recorded.
 */
export class ReplayClock {
  private lastWallMs: number | null = null;
  private lastUs = 0;

  constructor(private readonly maxStepUs: number) {}

  /** The timestamp for a frame captured at `wallMs` (performance.now()). Always increases. */
  stamp(wallMs: number): number {
    if (this.lastWallMs === null) {
      this.lastWallMs = wallMs;
      return this.lastUs;
    }
    const elapsedUs = Math.round((wallMs - this.lastWallMs) * 1000);
    this.lastWallMs = wallMs;
    this.lastUs += Math.min(Math.max(elapsedUs, 1), this.maxStepUs);
    return this.lastUs;
  }
}

export class ReplayBuffer {
  private chunks: ReplayChunk[] = [];
  /** Nothing is kept until a keyframe arrives: what comes before one cannot be decoded. */
  private awaitingKey = true;

  constructor(
    /** How much video a clip holds, in microseconds. */
    readonly windowUs: number,
    /** The longest step a clip keeps between two frames; longer gaps are closed up. */
    private readonly maxGapUs: number
  ) {}

  push(chunk: ReplayChunk): void {
    if (this.awaitingKey && !chunk.key) return;
    this.awaitingKey = false;
    this.chunks.push(chunk);
    const start = this.startOf(this.windowUs);
    if (start > 0) this.chunks.splice(0, start);
  }

  get isEmpty(): boolean {
    return this.chunks.length === 0;
  }

  /**
   * The last `windowUs` of video, starting on a keyframe and retimed to start at zero,
   * with any gap longer than the limit closed up.
   */
  clip(windowUs = this.windowUs): ReplayChunk[] {
    const kept = this.chunks.slice(this.startOf(windowUs));
    let at = 0;
    return kept.map((chunk, index) => {
      if (index > 0) at += Math.min(chunk.timestamp - kept[index - 1].timestamp, this.maxGapUs);
      return { ...chunk, timestamp: at };
    });
  }

  clear(): void {
    this.chunks = [];
    this.awaitingKey = true;
  }

  private end(): number {
    const last = this.chunks[this.chunks.length - 1];
    return last ? last.timestamp + last.duration : 0;
  }

  /**
   * Where a clip `windowUs` long starts: the last keyframe at or before the window's
   * start, or — when none that old survives — the first keyframe after it.
   */
  private startOf(windowUs: number): number {
    const from = this.end() - windowUs;
    let start = -1;
    for (let index = 0; index < this.chunks.length; index += 1) {
      const chunk = this.chunks[index];
      if (!chunk.key) continue;
      if (chunk.timestamp <= from || start < 0) start = index;
      if (chunk.timestamp > from) break;
    }
    return Math.max(start, 0);
  }
}
