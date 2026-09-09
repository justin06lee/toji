export function externalUrl(candidate: unknown): string | null;
export function urlsFromArgv(argv: readonly unknown[] | undefined): string[];
export class ExternalLinkQueue {
  push(candidate: unknown, deliver?: (url: string) => boolean): boolean;
  take(): string[];
  readonly size: number;
}
