// Typed view of the preload bridge (window.toji). Every member is optional: the
// renderer also runs in a plain browser tab during `bun run dev:web`, where there is
// no Electron shell at all, so callers use `bridge().thing?.()` throughout.

import type { Container } from './containers';

export interface TorStatus {
  /** Whether Tor routing is usable right now. Containers on `tor` egress are blocked until it is. */
  ready: boolean;
  state: 'off' | 'starting' | 'bootstrapping' | 'ready' | 'error';
  /** Bootstrap completion, 0-100. */
  progress: number;
  /** Human-readable phase or error ("Connecting to a relay", "tor binary not found"). */
  detail: string;
  /** Where the tor binary came from, for the settings panel. */
  source?: 'managed' | 'external' | null;
  /** Whether each Tor container gets its own circuits (false when using an external Tor). */
  isolated?: boolean;
}

export interface TojiBridge {
  platform?: string;
  setDefaultBrowser?: () => Promise<boolean>;
  isDefaultBrowser?: () => Promise<boolean>;
  addExtension?: () => Promise<{ id: string; name: string } | { error: string } | null>;
  listExtensions?: () => Promise<{ id: string; name: string }[]>;
  webStoreAvailable?: () => Promise<boolean>;

  // --- containers ---
  /** Hand the main process the container table (labelling + Tor circuit assignment). */
  setContainers?: (containers: Container[]) => void;
  /** Erase every cookie, cache entry and storage bucket a container holds. */
  clearContainer?: (containerId: string) => Promise<boolean>;

  // --- tor ---
  torStatus?: () => Promise<TorStatus>;
  torStart?: () => Promise<TorStatus>;
  torStop?: () => Promise<TorStatus>;
  /** Request fresh circuits (Tor NEWNYM). */
  torNewCircuit?: () => Promise<boolean>;
  onTorStatus?: (callback: (status: TorStatus) => void) => () => void;
}

export const bridge = (): TojiBridge => (window as unknown as { toji?: TojiBridge }).toji ?? {};

/** True when running inside the Electron shell (as opposed to a plain dev browser tab). */
export const isElectron = (): boolean => Boolean((window as unknown as { toji?: unknown }).toji);
