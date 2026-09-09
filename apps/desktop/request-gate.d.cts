// Type surface for request-gate.cjs.

export type RequestDecision = { cancel?: boolean; redirectURL?: string } | undefined;
export type RequestCheck = (details: { url: string; [key: string]: unknown }, callback: (decision?: RequestDecision) => void) => void;

export interface RequestGate {
  checks: Array<{ name: string; check: RequestCheck; priority: number }>;
}

export declare function requestGate(sess: unknown): RequestGate;
export declare function addRequestCheck(sess: unknown, name: string, check: RequestCheck, priority?: number): void;
export declare function removeRequestCheck(sess: unknown, name: string): void;
export declare function decide(checks: RequestGate['checks'], details: { url: string }, callback: (decision: RequestDecision) => void, index?: number): void;
