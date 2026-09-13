/**
 * Where menus, sheets and other overlays are portalled. In the Electron app and in
 * Toji's pages that is document.body. In the Gecko browser the shell lives inside a
 * shadow root in the browser window (so its styles and Firefox's never meet), and its
 * overlays have to be portalled into that root too, or they would render unstyled
 * outside it. The shell sets its root once, before it mounts.
 */
let root: Element | null = null;

export function setPortalRoot(element: Element | null) {
  root = element;
}

export function portalRoot(): Element {
  return root ?? document.body;
}
