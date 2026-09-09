// Type surface for adblock.cjs.

export interface AdblockStatus {
  enabled: boolean;
  /** An engine is loaded and deciding requests. */
  ready: boolean;
  /** Requests refused or redirected since launch. */
  blocked: number;
  /** Times a page asked for its element-hiding rules; zero means the cosmetic preload is not running. */
  cosmetics: number;
  /** When the cached engine was last built (ms since epoch), if ever. */
  updatedAt: number | null;
}

/** The subset of Ghostery's ElectronBlocker this module drives. */
export interface BlockerLike {
  onBeforeRequest(details: unknown, callback: (decision?: { cancel?: boolean; redirectURL?: string }) => void): void;
  onHeadersReceived(details: unknown, callback: (decision?: unknown) => void): void;
  onInjectCosmeticFilters(event: unknown, url: string, message?: unknown): Promise<unknown> | unknown;
  config?: { enableMutationObserver?: boolean };
}

export interface AdblockOptions {
  dataDir: string;
  ipcMain?: { handle(channel: string, listener: (...args: unknown[]) => unknown): void } | null;
  log?: (message: string) => void;
  buildEngine?: () => Promise<Uint8Array>;
  deserialize?: (bytes: Uint8Array) => BlockerLike;
  preloadPath?: string | null;
  now?: () => number;
}

export declare class Adblock {
  constructor(options: AdblockOptions);
  enabled: boolean;
  engine: BlockerLike | null;
  blocked: number;
  status(): AdblockStatus;
  setEnabled(enabled: boolean): AdblockStatus;
  load(): Promise<BlockerLike | null>;
  rebuild(): Promise<void>;
  active(): boolean;
  attach(sess: unknown): void;
}

export declare function buildInWorker(lists?: string[]): Promise<Uint8Array>;
export declare function readEnabled(file: string): boolean;
export declare const REFRESH_MS: number;
export declare const IPC_COSMETICS: string;
export declare const IPC_OBSERVER: string;
