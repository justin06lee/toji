// Type surface for vault.cjs.

export interface VaultEntryMeta {
  id: string;
  name: string;
  origin: string;
  username: string;
  containerId: string | null;
  updatedAt?: string;
  note?: string;
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export declare class Vault {
  constructor(options: { file: string; safeStorage: SafeStorageLike; log?: (m: string) => void });
  available(): boolean;
  load(): unknown[];
  persist(): void;
  /** Metadata only — never passwords. This is all the renderer is allowed to see. */
  list(containerId?: string | null): VaultEntryMeta[];
  matchesFor(url: string, containerId?: string | null): VaultEntryMeta[];
  save(entry: { id?: string; origin: string; username: string; password: string; containerId?: string | null; note?: string }): boolean;
  /** 'new' | 'update' | 'same' | 'ignore' — whether to offer to save a submitted login. */
  captureStatus(entry: { origin: string; username: string; password: string; containerId?: string | null }): 'new' | 'update' | 'same' | 'ignore';
  remove(id: string): boolean;
  /** The secret, released only for the origin the entry was saved against. */
  secretFor(id: string, expectedOrigin?: string, expectedContainerId?: string | null): { username: string; password: string } | null;
}

export declare function generatePassword(length?: number, alphabet?: string): string;
export declare function originOf(url: string): string | null;
export declare function siteName(origin: string): string;
export declare function entryMatches(entry: { origin: string; containerId?: string | null } | null, origin: string, containerId?: string | null): boolean;
export declare const GEN_ALPHABET: string;
