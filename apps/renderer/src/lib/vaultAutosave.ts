// Whether a submitted login is stored without asking, and how Toji decides the login
// actually worked before it does.
//
// The capture fires on submit, before the site has answered. Saving at that instant
// would store a mistyped password — and, worse, overwrite a correct one on the next
// typo. So after a submit Toji watches what the page does next: a page with no
// password field means the sign-in went through (save); a login form again means it
// probably did not (ask, never drop); nothing at all within the timeout means a site
// that signs in without navigating (save).

export const VAULT_AUTOSAVE_KEY = 'toji-vault-autosave';

/** Reports from the same page within this window are the form reacting to the click, not the outcome. */
export const AUTOSAVE_SETTLE_MS = 1000;
/** How long to wait for the page to show an outcome before saving anyway. */
export const AUTOSAVE_TIMEOUT_MS = 6000;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** On unless the user turned it off. */
export function autosaveEnabled(storage: Store = localStorage): boolean {
  return storage.getItem(VAULT_AUTOSAVE_KEY) !== 'off';
}

export function setAutosaveEnabled(on: boolean, storage: Store = localStorage): void {
  if (on) storage.removeItem(VAULT_AUTOSAVE_KEY);
  else storage.setItem(VAULT_AUTOSAVE_KEY, 'off');
}

export type AutosaveVerdict = 'save' | 'ask' | 'wait';

export interface FormReport {
  hasLogin: boolean;
  url?: string;
}

/**
 * Given what the page reported after the submit (or that it reported nothing in time),
 * whether to store the login, ask the user, or keep waiting.
 */
export function autosaveVerdict(report: FormReport | 'timeout', context: { submittedUrl: string | null; elapsedMs: number }): AutosaveVerdict {
  if (report === 'timeout') return 'save';
  if (!report.hasLogin) return 'save';
  const samePage = !report.url || !context.submittedUrl || report.url === context.submittedUrl;
  if (samePage && context.elapsedMs < AUTOSAVE_SETTLE_MS) return 'wait';
  return 'ask';
}
