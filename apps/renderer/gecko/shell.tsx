// The shell's entry. TojiShell.sys.mjs loads this bundle into a browser window with
// loadSubScript, after putting window.toji and window.tojiShell there, and calls
// window.tojiMountShell with the shadow root it made for it.

import ReactDOM from 'react-dom/client';
import { setPortalRoot } from '../src/lib/portalRoot';
import { GeckoShell } from './GeckoShell';
import './shell.css';

function mount(container: ParentNode) {
  const shell = document.createElement('div');
  shell.className = 'toji-shell';
  const app = document.createElement('div');
  app.className = 'toji-app';
  const portals = document.createElement('div');
  portals.className = 'toji-portals';
  shell.append(app, portals);
  container.append(shell);
  setPortalRoot(portals);
  // The shell's images, icons and links are furniture: dragging one should not start an
  // HTML drag (Electron had -webkit-user-drag for this; Gecko has no such property).
  // Motion's own tab dragging is pointer events and is not affected.
  shell.addEventListener(
    'dragstart',
    (event) => {
      const target = event.target as Element | null;
      if (target instanceof Element && target.closest('img, svg, a') && !target.closest('[draggable="true"]')) event.preventDefault();
    },
    true
  );
  ReactDOM.createRoot(app).render(<GeckoShell root={shell} />);
}

(window as unknown as { tojiMountShell: typeof mount }).tojiMountShell = mount;
