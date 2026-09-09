// What to say beside a coding CLI that cannot serve a model right now.
//
// Toji lists the installed CLIs in two places — the welcome page and Settings — and
// they used to describe the same failure with different words ("signed out" in one,
// "unavailable" in the other). Both now ask here, so the same CLI in the same state
// reads the same everywhere.

interface ProviderLike {
  usable: boolean;
  /** yagami's reason for a failed probe: not installed, not logged in, handshake failed… */
  error?: string;
}

/** The shapes yagami and the CLIs use for "log in first". Mirrors yagami's own list. */
const SIGNED_OUT = [
  /not (logged|signed) in/i,
  /log ?in required/i,
  /please (run|use) [`'"]?\/?log ?in/i,
  /sign(ed)? ?(in|out)/i,
  /invalid api key/i,
  /authentication[_ ]error/i,
  /auth(entication)? required/i,
  /not authenticated/i,
  /unauthori[sz]ed/i,
  /credentials? (are|is) (missing|invalid|expired)/i,
  /token (has )?expired/i,
  /no credentials/i
];

export type ProviderNote = 'signed out' | 'unavailable';

/**
 * `null` when the CLI answered its model probe and is ready; `'signed out'` when it is
 * installed but its login is missing or expired; `'unavailable'` for any other failure
 * (the raw error belongs in a tooltip, not the label).
 */
export function providerNote(provider: ProviderLike): ProviderNote | null {
  if (provider.usable) return null;
  if (provider.error && SIGNED_OUT.some((re) => re.test(provider.error ?? ''))) return 'signed out';
  return 'unavailable';
}
