/**
 * How far a draggable item may travel before it leaves its container, as the numeric
 * constraints Motion's drag gesture takes ({ left, right } or { top, bottom }, in px
 * from where the item rests).
 *
 * This exists instead of handing Motion the container as a `dragConstraints` ref. With
 * a ref, Motion listens for window resizes and rewrites every item's drag offset to keep
 * its RELATIVE position inside the (re-measured) container — meant for a free-floating
 * draggable, but for tabs at rest it leaves them shifted, overlapping, and stuck there
 * whenever the window is resized and the strip overflows or its width changes unevenly.
 * Measuring once on pointer-down gives the same edge-stopping while dragging, and no
 * resize listener at all.
 *
 * An item already partly outside the container (scrolled out of view) keeps its rest
 * position reachable: the bound never asks it to move before the drag starts.
 */
export type DragBoundsX = { left: number; right: number };
export type DragBoundsY = { top: number; bottom: number };

export function dragBoundsX(item: DOMRect, container: DOMRect): DragBoundsX {
  return { left: Math.min(0, container.left - item.left), right: Math.max(0, container.right - item.right) };
}

export function dragBoundsY(item: DOMRect, container: DOMRect): DragBoundsY {
  return { top: Math.min(0, container.top - item.top), bottom: Math.max(0, container.bottom - item.bottom) };
}
