import { MousePointer2 } from 'lucide-react';
import { motion } from 'motion/react';
import { createPortal } from 'react-dom';
import { portalRoot } from '../lib/portalRoot';

/** Where the agent's pointer is, in window coordinates; `tick` counts its clicks (each one ripples). */
export interface AgentCursorAt {
  x: number;
  y: number;
  tick: number;
}

/** The agent's visible "own mouse" — glides to each target and ripples on click. */
export function AgentCursor({ cursor }: { cursor: AgentCursorAt | null }) {
  if (!cursor) return null;
  return createPortal(
    <motion.div className="pointer-events-none fixed left-0 top-0 z-[55]" animate={{ x: cursor.x, y: cursor.y }} transition={{ type: 'spring', stiffness: 240, damping: 24 }}>
      <MousePointer2 size={22} className="fill-white text-neutral-900 drop-shadow-[0_2px_6px_rgba(0,0,0,0.55)]" />
      <motion.span key={cursor.tick} className="absolute left-0 top-0 block h-5 w-5 rounded-full border-2 border-white shadow-[0_0_0_1.5px_rgba(0,0,0,0.55)]" initial={{ scale: 0.3, opacity: 0.9 }} animate={{ scale: 1.9, opacity: 0 }} transition={{ duration: 0.45 }} />
    </motion.div>,
    portalRoot()
  );
}
