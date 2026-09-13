// Wraps a recorded clip's encoded chunks in a video file, with mediabunny
// (resource:///modules/toji/lib/replayMux.sys.mjs; bundled by gecko/build.ts).

import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output, WebMOutputFormat } from 'mediabunny';
import type { ReplayChunk } from './replayBuffer';

export interface MuxOptions {
  /** mp4 for H.264 and VP9, webm for VP8. */
  container: 'mp4' | 'webm';
  /** The codec as the muxer names it. */
  codec: 'avc' | 'vp9' | 'vp8';
  /** From the encoder's first output metadata. */
  decoderConfig: VideoDecoderConfig;
}

export async function muxClip(chunks: ReplayChunk[], options: MuxOptions): Promise<{ data: Uint8Array; type: string }> {
  const target = new BufferTarget();
  const output = new Output({
    format: options.container === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
    target
  });
  const source = new EncodedVideoPacketSource(options.codec);
  output.addVideoTrack(source);
  await output.start();
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const next = chunks[i + 1];
    const duration = (next ? next.timestamp - chunk.timestamp : chunk.duration) / 1_000_000;
    const packet = new EncodedPacket(chunk.data, chunk.key ? 'key' : 'delta', chunk.timestamp / 1_000_000, duration);
    await source.add(packet, i === 0 ? { decoderConfig: options.decoderConfig } : undefined);
  }
  await output.finalize();
  if (!target.buffer) throw new Error('the recording could not be written');
  return { data: new Uint8Array(target.buffer), type: options.container === 'mp4' ? 'video/mp4' : 'video/webm' };
}
