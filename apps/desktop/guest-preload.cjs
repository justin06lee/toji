// Runs inside every <webview> guest page, in an isolated world.
//
// Its only job is the password manager's page-side half: notice login forms, fill
// credentials the main process sends down, and offer to save what the user typed.
// It deliberately holds no secrets of its own — a password arrives on the fill
// channel, goes straight into the field, and is never retained.

const { ipcRenderer } = require('electron');

const PASSWORD_SELECTOR = 'input[type="password"]:not([disabled]):not([readonly])';

/** Only fields the user could actually type into are worth filling. */
function isVisible(el) {
  if (!el || !el.isConnected) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  const style = window.getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

function passwordFields() {
  return Array.from(document.querySelectorAll(PASSWORD_SELECTOR)).filter(isVisible);
}

/**
 * The username field for a password field: the nearest preceding text-ish input in the
 * same form (falling back to the document), which is how login forms are almost always
 * laid out.
 */
function usernameFor(passwordField) {
  const scope = passwordField.form || document;
  const candidates = Array.from(scope.querySelectorAll('input')).filter((input) => {
    const type = (input.getAttribute('type') || 'text').toLowerCase();
    return ['text', 'email', 'tel', 'username', ''].includes(type) && isVisible(input);
  });
  const before = candidates.filter((input) => passwordField.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_PRECEDING);
  return before.length ? before[before.length - 1] : candidates[0] || null;
}

/**
 * Set a value the way a user would. React and friends install their own value setter on
 * the element, so assigning `.value` directly updates the DOM but leaves component state
 * stale; going through the prototype's native setter and then dispatching input/change
 * is what makes frameworks observe the change.
 */
function setValue(field, value) {
  if (!field) return;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
  if (setter) setter.call(field, value);
  else field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Tell the host whether this page currently has somewhere to put a password. */
function reportLoginForm() {
  try {
    ipcRenderer.sendToHost('toji-vault:form', { hasLogin: passwordFields().length > 0, url: location.href });
  } catch {
    /* host went away */
  }
}

ipcRenderer.on('toji-vault:fill', (_event, { username, password }) => {
  const field = passwordFields()[0];
  if (!field) return;
  const userField = usernameFor(field);
  if (username && userField) setValue(userField, username);
  setValue(field, password);
  field.focus();
});

// Offer to save on submit.
//
// The submitted password goes straight to the MAIN process (invoke), not to the host
// renderer via sendToHost — the renderer only ever learns that there is something to
// save, and for which account. Nothing is stored without an explicit confirmation.
let lastCaptureAt = 0;
let lastCapturedAccount = '';
function captureSubmission() {
  const field = passwordFields()[0];
  if (!field || !field.value) return;
  const userField = usernameFor(field);
  const username = userField ? userField.value : '';
  const account = `${location.origin}|${username}`;
  const now = Date.now();
  if (account === lastCapturedAccount && now - lastCaptureAt < 2000) return; // submit + click often fire for one sign-in
  lastCapturedAccount = account;
  lastCaptureAt = now;
  try {
    ipcRenderer.invoke('toji:vault-captured', { url: location.href, username, password: field.value });
  } catch {
    /* main went away */
  }
}

window.addEventListener('submit', captureSubmission, true);
// Many sign-in forms never fire submit (they post via fetch on a button click), so also
// capture on a click that lands on a plausible submit control while a password is filled.
window.addEventListener(
  'click',
  (event) => {
    const target = event.target instanceof Element ? event.target.closest('button, input[type="submit"], [role="button"]') : null;
    if (target) setTimeout(captureSubmission, 0);
  },
  true
);

document.addEventListener('DOMContentLoaded', reportLoginForm);
window.addEventListener('load', reportLoginForm);
// Single-page apps swap the login form in long after load, so keep watching.
const observer = new MutationObserver(() => reportLoginForm());
if (document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true });
