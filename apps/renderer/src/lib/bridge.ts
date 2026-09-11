import type { BookmarkImportError, BrowserProfile, DetectedBrowser as ImportBrowser, ImportResult, ImportedBookmark, PasswordImportError } from '../../../desktop/browser-import.cjs';

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

/** How a link handed over by the main process should open. */
export interface OpenUrlOptions {
  /** Keep the current tab in front (⌘-click, "Open Link in New Tab"). */
  background?: boolean;
  /** A page opened it, so the new tab belongs beside that page's tab. */
  fromPage?: boolean;
}

/** Whether a guest page is making sound, by its webContents id. */
export interface TabAudioState {
  webContentsId: number;
  audible: boolean;
}

export interface AdblockStatus {
  enabled: boolean;
  /** The filter engine is loaded and deciding requests. */
  ready: boolean;
  /** Requests refused since launch. */
  blocked: number;
  /** Pages that asked for element-hiding rules since launch. */
  cosmetics: number;
  /** When the filter lists were last fetched, in ms since the epoch. */
  updatedAt: number | null;
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

export type { BookmarkImportError, BrowserProfile, ImportBrowser, ImportResult, ImportedBookmark, PasswordImportError };

/** Who files bug reports from this machine, and so which route they take (see bug-report.cjs). */
export interface BugReportAccount {
  mode: 'direct' | 'form';
  repo: string;
  login?: string;
  /** Where the login came from: 'gh' (the GitHub CLI's), or the variable holding the token. */
  source?: string;
  reason?: 'no-login' | 'no-access' | 'bad-login' | 'unreachable';
}

export interface BugReportFile {
  type: string;
  role: 'recording' | 'poster' | 'image';
  data: Uint8Array;
}

export interface BugReportDraft {
  kind: 'recording' | 'written';
  title: string;
  description: string;
  /** Only when the reporter chose to include it: reports are public. */
  pageUrl?: string;
  /** How long the recording runs, in seconds. */
  seconds?: number;
  context: { window: string; layout: string; theme: string };
  files: BugReportFile[];
  /** Take GitHub's form even though filing directly is available (after it failed). */
  via?: 'form';
}

export type BugReportResult =
  | { ok: true; mode: 'direct'; number: number; url: string }
  | { ok: true; mode: 'form'; reportId: string; url: string; files: string[]; bodyOnClipboard: boolean }
  | { ok: false; error: string; canUseForm?: boolean };

export type BugReportAttach = { ok: true; method: 'drop' | 'input' } | { ok: false; error: string };

export interface PasswordsFileImport {
  canceled: boolean;
  found: number;
  added: number;
  /** Rows without a website or a password. */
  skipped: number;
  error?: 'no-vault' | 'unreadable';
}

export interface TojiBridge {
  platform?: string;
  /** Resolves once macOS has answered — true only when Toji really is the default. */
  setDefaultBrowser?: () => Promise<boolean>;
  isDefaultBrowser?: () => Promise<boolean>;

  // --- import from other browsers ---
  importBrowsers?: () => Promise<ImportBrowser[]>;
  /** Bookmarks come back; passwords go straight into the vault under `containerId`. */
  importBrowser?: (options: { browser: string; profile: string; containerId: string }) => Promise<ImportResult>;
  importBookmarksFile?: () => Promise<{ canceled: boolean; bookmarks: ImportedBookmark[] }>;
  importPasswordsFile?: (containerId: string) => Promise<PasswordsFileImport>;
  /** macOS: the Full Disk Access pane, where Toji can be allowed to read Safari's data. */
  openFullDiskAccess?: () => Promise<void>;
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
  /** Links from other apps held since before this window existed; also marks it able to take more. */
  takeExternalUrls?: () => Promise<string[]>;
  /**
   * A link the main process wants opened as a tab: from a page (a popup, a ⌘-click, the
   * context menu — `fromPage`, and `background` when the current tab should stay in
   * front) or from another app (no options).
   */
  onOpenUrl?: (callback: (url: string, options: OpenUrlOptions) => void) => () => void;
  /** A tab's page started or stopped making sound. */
  onTabAudio?: (callback: (state: TabAudioState) => void) => () => void;
  /** Toji's theme, applied to every page's prefers-color-scheme. */
  setTheme?: (theme: 'light' | 'dark') => void;

  // --- ad blocking ---
  adblockStatus?: () => Promise<AdblockStatus>;
  setAdblock?: (enabled: boolean) => Promise<AdblockStatus>;

  // --- tor ---
  torStatus?: () => Promise<TorStatus>;
  torStart?: () => Promise<TorStatus>;
  torStop?: () => Promise<TorStatus>;
  /** Request fresh circuits (Tor NEWNYM). */
  torNewCircuit?: () => Promise<boolean>;
  onTorStatus?: (callback: (status: TorStatus) => void) => () => void;

  // --- bug reports ---
  /** Help › Report a Bug… (⌥⇧I) was chosen while this window was in front. */
  onReportBug?: (callback: () => void) => () => void;
  /** A capture id for this window's own contents, for the rolling recording. Valid a few seconds. */
  replaySourceId?: () => Promise<string | null>;
  /** A still of this window as it is right now. */
  captureWindow?: () => Promise<{ type: string; data: Uint8Array } | null>;
  bugReportAccount?: (options?: { refresh?: boolean }) => Promise<BugReportAccount>;
  submitBugReport?: (draft: BugReportDraft) => Promise<BugReportResult>;
  /** Drop a waiting report's files onto GitHub's issue form in one of this window's tabs. */
  attachBugReport?: (webContentsId: number, reportId: string) => Promise<BugReportAttach>;
  /** Start a native drag of one of a waiting report's files, to drop onto the form by hand. */
  dragBugReportFile?: (reportId: string, name: string) => void;
  /** Show a waiting report's files in Finder / the file manager. */
  revealBugReport?: (reportId: string) => Promise<boolean>;

  // --- window chrome ---
  /** Cursor tracking for the window-drag notch; see WindowCursor. */
  onWindowCursor?: (callback: (cursor: WindowCursor) => void) => () => void;
  /** Grab the window: the main process follows the cursor until endWindowDrag. */
  startWindowDrag?: () => void;
  endWindowDrag?: () => void;
  /** The platform's title-bar double-click action (zoom / maximize / minimize). */
  windowTitleAction?: () => void;
}

export const bridge = (): TojiBridge => (window as unknown as { toji?: TojiBridge }).toji ?? {};

/** True when running inside the Electron shell (as opposed to a plain dev browser tab). */
export const isElectron = (): boolean => Boolean((window as unknown as { toji?: unknown }).toji);
