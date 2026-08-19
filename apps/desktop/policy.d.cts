// Type surface for policy.cjs (the Electron main process is CommonJS, so the module
// itself stays plain JS; this keeps the tests and any TS caller honest).

export type Egress = 'direct' | 'tor';

export interface ContainerPolicy {
  id: string;
  egress: Egress;
}

/** The Tor controller shape policy.cjs depends on (see tor.cjs). */
export interface TorLike {
  isReady(): boolean;
  socksPortFor(containerId: string): number | null;
}

export declare const PARTITION_RE: RegExp;
export declare function parsePartition(partition: string): ContainerPolicy | null;
export declare function applySessionPolicy(sess: unknown, partition: string, tor: TorLike | null): string | null;
export declare function applyWebRtcPolicy(contents: unknown, partition: string | undefined): void;
export declare function installKillSwitch(sess: unknown, tor: TorLike | null): void;
