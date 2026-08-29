// Typed view of the preload bridge (window.toji). Every member is optional: the
// renderer also runs in a plain browser tab during `bun run dev:web`, where there is
// no Electron shell at all, so callers use `bridge().thing?.()` throughout.

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

/** Pointer position relative to the window's content area, streamed while focused. */
export interface WindowCursor {
  x: number;
  y: number;
  /** Content-area size at the moment of sampling, for edge/zone math. */
  width: number;
  height: number;
  /** False once the pointer leaves the window (or the window loses focus). */
  inside: boolean;
}

/** Vault calls return either a value or a message; they never throw across IPC. */
export type VaultResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Credential metadata. Never carries the password. */
export interface VaultEntry {
  id: string;
  /** Display name derived from the saved website (for example, "github.com"). */
  name: string;
  origin: string;
  username: string;
  containerId: string | null;
  updatedAt?: string;
  note?: string;
}

export interface VaultDraft {
  id?: string;
  origin: string;
  username: string;
  password: string;
  containerId?: string | null;
  note?: string;
}

/** A login the user just submitted, waiting on their decision. Carries no password. */
export interface VaultPrompt {
  webContentsId: number;
  origin: string;
  username: string;
  containerId: string | null;
  /** 'saved' = already committed (a password Toji itself generated); just informational. */
  status: 'new' | 'update' | 'saved';
}

export interface VaultStatus {
  /** False when the OS offers no keychain-backed encryption; the vault is then disabled. */
  available: boolean;
  count: number;
  error?: string;
}

export interface TojiBridge {
  platform?: string;
  setDefaultBrowser?: () => Promise<boolean>;
  isDefaultBrowser?: () => Promise<boolean>;
  addExtension?: () => Promise<{ id: string; name: string } | { error: string } | null>;
  listExtensions?: () => Promise<{ id: string; name: string }[]>;
  webStoreAvailable?: () => Promise<boolean>;

  // --- containers ---
  /** Erase every cookie, cache entry and storage bucket a container holds. */
  clearContainer?: (containerId: string) => Promise<boolean>;

  // --- password vault ---
  // There is deliberately no "read a password" call: the renderer can see which
  // credentials exist and ask for one to be filled, but never receives a secret.
  vaultStatus?: () => Promise<VaultStatus>;
  vaultList?: (containerId?: string | null) => Promise<VaultResult<VaultEntry[]>>;
  vaultMatches?: (webContentsId: number) => Promise<VaultResult<VaultEntry[]>>;
  vaultSave?: (entry: VaultDraft) => Promise<VaultResult<boolean>>;
  vaultDelete?: (id: string) => Promise<VaultResult<boolean>>;
  vaultGenerate?: (length?: number) => Promise<string>;
  vaultFill?: (webContentsId: number, entryId: string) => Promise<boolean>;
  vaultCommit?: (webContentsId: number) => Promise<VaultResult<boolean>>;
  vaultDismiss?: (webContentsId: number) => Promise<boolean>;
  onVaultPrompt?: (callback: (prompt: VaultPrompt) => void) => () => void;
  /** file:// URL of the preload every <webview> guest loads. */
  guestPreload?: string;

  // --- tor ---
  torStatus?: () => Promise<TorStatus>;
  torStart?: () => Promise<TorStatus>;
  torStop?: () => Promise<TorStatus>;
  /** Request fresh circuits (Tor NEWNYM). */
  torNewCircuit?: () => Promise<boolean>;
  onTorStatus?: (callback: (status: TorStatus) => void) => () => void;

  // --- window chrome ---
  /** Cursor tracking for the window-drag notch; see WindowCursor. */
  onWindowCursor?: (callback: (cursor: WindowCursor) => void) => () => void;
}

export const bridge = (): TojiBridge => (window as unknown as { toji?: TojiBridge }).toji ?? {};

/** True when running inside the Electron shell (as opposed to a plain dev browser tab). */
export const isElectron = (): boolean => Boolean((window as unknown as { toji?: unknown }).toji);
