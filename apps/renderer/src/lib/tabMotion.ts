/**
 * How tabs come and go, shared by the top strip and the sidebar: quick enough to stay
 * out of the way, with just enough motion to follow. A new tab slides in from beside
 * its neighbour along the strip's own axis; a closed one shrinks away where it was
 * while the rest close the gap. Position moves (opening, closing, reordering) share
 * the timing so the whole change reads as one gesture.
 */
export const TAB_EASE = [0.22, 1, 0.36, 1] as const;
export const TAB_TRANSITION = { layout: { duration: 0.18, ease: TAB_EASE }, default: { duration: 0.14, ease: TAB_EASE } };
export const TAB_ENTER = { x: { opacity: 0, x: -12 }, y: { opacity: 0, y: -8 } } as const;
export const TAB_REST = { opacity: 1, x: 0, y: 0, scale: 1 };
export const TAB_EXIT = { opacity: 0, scale: 0.9 };
