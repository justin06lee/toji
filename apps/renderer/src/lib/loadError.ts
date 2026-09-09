// What to tell someone when a page cannot load. Chromium reports a numeric net error
// and a code name; a person needs a sentence about the site they typed.

export interface LoadFailure {
  /** Chromium net error, e.g. -102 (ERR_CONNECTION_REFUSED). */
  code: number;
  /** Chromium's code name, e.g. "ERR_CONNECTION_REFUSED". */
  description: string;
  url: string;
}

export type LoadErrorKind = 'offline' | 'notfound' | 'refused' | 'timeout' | 'interrupted' | 'insecure' | 'blocked' | 'address' | 'generic';

export interface LoadErrorCopy {
  kind: LoadErrorKind;
  title: string;
  detail: string;
  /** Whether "Try again" is worth offering. A bad certificate will not fix itself. */
  retry: boolean;
}

export function hostOfUrl(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Errors where "the request never got through" — the ones Tor being down would explain. */
const NETWORK_KINDS: LoadErrorKind[] = ['offline', 'refused', 'timeout', 'interrupted', 'blocked', 'generic'];

export function describeLoadError(failure: LoadFailure, options: { tor?: boolean } = {}): LoadErrorCopy {
  const host = hostOfUrl(failure.url);
  const code = failure.code;
  let copy: LoadErrorCopy;

  if (code === -106) {
    copy = { kind: 'offline', title: 'You are offline', detail: 'Toji could not reach the network. Check the connection and try again.', retry: true };
  } else if (code === -105 || code === -137) {
    copy = { kind: 'notfound', title: `There is no site at ${host}`, detail: 'No server answers to that name. Check the address for typos.', retry: true };
  } else if (code === -102) {
    copy = { kind: 'refused', title: `${host} refused the connection`, detail: 'Nothing is listening there right now. If it is your own server, make sure it is running.', retry: true };
  } else if (code === -7 || code === -118) {
    copy = { kind: 'timeout', title: `${host} took too long to respond`, detail: 'The server never answered. It may be overloaded, or something between you and it is slow.', retry: true };
  } else if (code === -100 || code === -101 || code === -103 || code === -104 || code === -15 || code === -21 || code === -324) {
    copy = { kind: 'interrupted', title: `The connection to ${host} was interrupted`, detail: 'The site stopped responding partway through. Trying again usually works.', retry: true };
  } else if ((code <= -200 && code >= -299) || code === -501) {
    copy = { kind: 'insecure', title: `${host} is not secure`, detail: 'Its certificate could not be verified, so Toji did not load the page.', retry: false };
  } else if (code === -20 || code === -27) {
    copy = { kind: 'blocked', title: 'This request was blocked', detail: 'Something in the way refused to let it through.', retry: true };
  } else if (code <= -300 && code >= -399) {
    copy = { kind: 'address', title: 'That is not an address Toji can open', detail: 'Check it, or search for what you meant instead.', retry: false };
  } else {
    copy = { kind: 'generic', title: 'This page cannot be shown', detail: `${host} could not be loaded.`, retry: true };
  }

  if (options.tor && NETWORK_KINDS.includes(copy.kind)) {
    copy = { ...copy, detail: `${copy.detail} This container browses through Tor, and while Tor is not connected every request is cancelled.` };
  }
  return copy;
}
