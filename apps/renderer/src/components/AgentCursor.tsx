import { MousePointer2 } from 'lucide-react';
import { motion, useSpring, type MotionValue } from 'motion/react';
import { createPortal } from 'react-dom';
import { portalRoot } from '../lib/portalRoot';

/**
 * Where the agent's pointer is, in window coordinates; `tick` counts its clicks (each one
 * ripples). The position is either a pair of numbers (a render per move) or a pair of
 * motion values the host drives directly (no render per move: the Gecko shell gets a
 * sample for every step of a glide).
 */
export interface AgentCursorAt {
  x: number | MotionValue<number>;
  y: number | MotionValue<number>;
  tick: number;
}

const SPRING = { stiffness: 240, damping: 24 };

/** The agent's visible "own mouse" — glides to each target and ripples on click. */
export function AgentCursor({ cursor }: { cursor: AgentCursorAt | null }) {
  if (!cursor) return null;
  return createPortal(<Pointer cursor={cursor} />, portalRoot());
}

function Pointer({ cursor }: { cursor: AgentCursorAt }) {
  // useSpring takes a number or a motion value; its typings want one at a time.
  const x = useSpring(cursor.x as number, SPRING);
  const y = useSpring(cursor.y as number, SPRING);
  return (
    <motion.div className="pointer-events-none fixed left-0 top-0 z-[55]" style={{ x, y }}>
      <MousePointer2 size={22} className="fill-white text-neutral-900 drop-shadow-[0_2px_6px_rgba(0,0,0,0.55)]" />
      <motion.span key={cursor.tick} className="absolute left-0 top-0 block h-5 w-5 rounded-full border-2 border-white shadow-[0_0_0_1.5px_rgba(0,0,0,0.55)]" initial={{ scale: 0.3, opacity: 0.9 }} animate={{ scale: 1.9, opacity: 0 }} transition={{ duration: 0.45 }} />
    </motion.div>
  );
}
