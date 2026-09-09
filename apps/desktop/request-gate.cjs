'use strict';

// Electron keeps ONE onBeforeRequest listener per session: registering a second one
// silently replaces the first. Toji has two things that must be asked about every
// request — the Tor kill switch (policy.cjs) and the ad blocker (adblock.cjs) — so they
// share this single listener and are asked in priority order. The first to answer with a
// cancel or a redirect ends the request; it only goes out when every check let it through.

/** The composed listener for a session, installed on first use. */
function requestGate(sess) {
  if (!sess.__tojiGate) {
    const gate = { checks: [] };
    sess.__tojiGate = gate;
    sess.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => decide(gate.checks, details, callback));
  }
  return sess.__tojiGate;
}

/**
 * Add a check to a session (replacing any earlier one of the same name).
 *
 * A check has the shape of an Electron onBeforeRequest listener, `(details, callback)`.
 * Answering `{ cancel: true }` or `{ redirectURL }` is final; anything else hands the
 * request to the next check. Lower `priority` runs first — the kill switch is 0, so an
 * offline Tor container is refused before anything else gets a say.
 */
function addRequestCheck(sess, name, check, priority = 10) {
  const gate = requestGate(sess);
  gate.checks = [...gate.checks.filter((entry) => entry.name !== name), { name, check, priority }].sort((a, b) => a.priority - b.priority);
}

function removeRequestCheck(sess, name) {
  if (!sess.__tojiGate) return;
  sess.__tojiGate.checks = sess.__tojiGate.checks.filter((entry) => entry.name !== name);
}

/** Ask the checks in order; the first cancel or redirect is the answer. */
function decide(checks, details, callback, index = 0) {
  if (index >= checks.length) return callback({});
  let answered = false;
  const next = (decision) => {
    if (answered) return;
    answered = true;
    if (decision && (decision.cancel || decision.redirectURL)) return callback(decision);
    decide(checks, details, callback, index + 1);
  };
  try {
    checks[index].check(details, next);
  } catch {
    next({}); // a broken check must never hang a request
  }
}

module.exports = { requestGate, addRequestCheck, removeRequestCheck, decide };
