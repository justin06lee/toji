// Type surface for tor.cjs (the Electron main process is CommonJS).

export interface TorStatus {
  ready: boolean;
  state: 'off' | 'starting' | 'bootstrapping' | 'ready' | 'error';
  progress: number;
  detail: string;
  source: 'managed' | 'external' | null;
  /** Whether each Tor container gets its own circuits (false with an external Tor). */
  isolated: boolean;
}

export interface TorControllerOptions {
  dataDir: string;
  resourcesPath?: string;
  log?: (message: string) => void;
}

export declare class TorController {
  constructor(options: TorControllerOptions);
  status: TorStatus;
  /** SOCKS ports of the managed instance; one is assigned per Tor container. */
  socksPorts: number[];
  /** Set instead when reusing a Tor that was already running (single shared port). */
  externalPort: number | null;
  /** True when each Tor container gets its own circuits (managed instance only). */
  readonly isolated: boolean;
  onStatus(listener: (status: TorStatus) => void): () => void;
  setStatus(patch: Partial<TorStatus>): void;
  isReady(): boolean;
  socksPortFor(containerId: string): number | null;
  start(): Promise<TorStatus>;
  stop(): TorStatus;
  newCircuit(): Promise<boolean>;
}

export declare const SOCKS_BASE: number;
export declare const SOCKS_POOL_SIZE: number;
export declare const EXTERNAL_SOCKS_PORTS: number[];
export declare function findTorBinary(resourcesPath?: string): string | null;
export declare function findExternalSocks(): Promise<number | null>;
export declare function probePort(port: number, host?: string, timeoutMs?: number): Promise<boolean>;
export declare function portIsFree(port: number): Promise<boolean>;
export declare function allocatePorts(base: number, count: number): Promise<number[]>;
export declare function buildTorrc(options: { dataDir: string; socksPorts: number[]; controlPort: number }): string;
export declare function parseBootstrap(line: string): { progress: number; detail: string } | null;
export declare function controlCommands(cookieHex: string, commands: string[]): string;
