import { motion } from 'motion/react';
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { bridge } from '../lib/bridge';
import { DRAG_HANDLE_DWELL_MS, revealDragHandle } from '../lib/dragHandle';

/**
 * The visible "grab here" notch at the top of the window, for macOS, where the native
 * title bar is hidden. It mounts only while revealDragHandle says the tracked cursor is
 * near the top band — it must unmount when hidden, because even a transparent handle
 * would steal clicks from the tabs beneath it.
 *
 * It reveals from the tracked cursor position streamed by the browser, never from DOM
 * hover: the chrome around it is a native drag region, so mouse events over that are
 * swallowed by the OS and hover there never fires. Two things keep it steady rather
 * than strobing: it never hides while the pointer is actually on it (the notch itself is
 * not a drag region, so it does get hover), and hiding waits out a brief dwell so one
 * stray sample can't blink it away.
 *
 * It is deliberately NOT a native drag region either. Those swallow every mouse event,
 * which is why the notch had no grab cursor and no double-click, and why it flickered.
 * Instead the browser follows the cursor between drag-start and drag-end.
 *
 * It fades out exactly as it fades in: the same slide and fade, run backwards. While it
 * is on its way out it takes no pointer events, so a tab underneath is clickable at
 * once, and it leaves the tree only when the animation has finished.
 */
export function WindowDragHandle({ layout, crowded }: { layout: 'top' | 'side'; crowded: boolean }) {
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [holding, setHolding] = useState(false);
  // Mirrors `visible` for the cursor stream (which reads it far more often than React
  // re-renders), and pins it while the pointer is on the notch or holding it.
  const visibleRef = useRef(false);
  const heldRef = useRef(false);

  const setShown = useCallback((next: boolean) => {
    if (visibleRef.current === next) return;
    visibleRef.current = next;
    setVisible(next);
    if (next) setMounted(true);
  }, []);
  useEffect(() => {
    setShown(false);
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelHide = () => {
      if (hideTimer === null) return;
      clearTimeout(hideTimer);
      hideTimer = null;
    };
    const off = bridge().onWindowCursor?.((cursor) => {
      const shown = visibleRef.current;
      if (heldRef.current || revealDragHandle(cursor, shown, layout)) {
        cancelHide();
        setShown(true);
        return;
      }
      if (!shown || hideTimer !== null) return;
      hideTimer = setTimeout(() => {
        hideTimer = null;
        if (!heldRef.current) setShown(false);
      }, DRAG_HANDLE_DWELL_MS);
    });
    return () => {
      cancelHide();
      off?.();
    };
  }, [layout, setShown]);
  // Grabbing the notch hands the window to the browser, which follows the cursor until
  // we let go. Letting go is watched on the whole window, not just the notch: the
  // pointer can outrun a window that has hit a screen edge, and a drag that never ends
  // would leave the window stuck to the cursor.
  const release = useCallback(() => {
    if (!heldRef.current) return;
    heldRef.current = false;
    setHolding(false);
    bridge().endWindowDrag?.();
  }, []);
  const hold = useCallback(
    (event: ReactMouseEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      heldRef.current = true;
      setHolding(true);
      setShown(true);
      bridge().startWindowDrag?.();
    },
    [setShown]
  );
  useEffect(() => {
    if (!holding) return;
    window.addEventListener('mouseup', release);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('mouseup', release);
      window.removeEventListener('blur', release);
    };
  }, [holding, release]);

  if (!mounted) return null;
  const shown = visible && (layout === 'side' || crowded);
  return (
    <motion.div
      className={`drag-strip drag-strip-${layout === 'side' ? 'side' : 'tabs'}`}
      data-testid="window-drag-handle"
      data-state={shown ? 'shown' : 'hiding'}
      aria-hidden
      initial={{ opacity: 0, y: '-100%' }}
      animate={shown ? { opacity: 1, y: 0 } : { opacity: 0, y: '-100%' }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      onAnimationComplete={() => {
        if (!visibleRef.current) setMounted(false);
      }}
    >
      <span
        className={`drag-notch${holding ? ' drag-notch-holding' : ''}`}
        data-testid="window-drag-notch"
        role="presentation"
        title="Drag to move the window — double-click to zoom"
        style={{ pointerEvents: shown ? 'auto' : 'none' }}
        onMouseDown={hold}
        onMouseUp={release}
        onMouseEnter={() => setShown(true)}
        onDoubleClick={() => {
          release();
          bridge().windowTitleAction?.();
        }}
      >
        <span className="drag-grip">
          {Array.from({ length: 12 }, (_, i) => (
            <i key={i} />
          ))}
        </span>
      </span>
    </motion.div>
  );
}
