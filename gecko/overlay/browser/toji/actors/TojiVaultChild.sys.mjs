/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The page half of Toji's vault: notices login forms, fills a credential the
// parent sends, and hands a submitted login to the parent. It keeps no secret:
// a password arrives for one fill, goes into the field, and is dropped.

const PASSWORD_SELECTOR =
  'input[type="password"]:not([disabled]):not([readonly])';
const USERNAME_TYPES = new Set(["text", "email", "tel", "username", ""]);

function isVisible(el) {
  if (!el?.isConnected) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) {
    return false;
  }
  const style = el.ownerDocument.defaultView.getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none";
}

export class TojiVaultChild extends JSWindowActorChild {
  #observer = null;
  #lastReport = null;
  #lastCapture = { account: "", at: 0 };

  #passwordFields() {
    return Array.from(this.document.querySelectorAll(PASSWORD_SELECTOR)).filter(
      isVisible
    );
  }

  #usernameFor(passwordField) {
    const scope = passwordField.form || this.document;
    const candidates = Array.from(scope.querySelectorAll("input")).filter(
      input =>
        USERNAME_TYPES.has((input.getAttribute("type") || "text").toLowerCase()) &&
        isVisible(input)
    );
    const before = candidates.filter(
      input =>
        passwordField.compareDocumentPosition(input) &
        this.contentWindow.Node.DOCUMENT_POSITION_PRECEDING
    );
    return before.length ? before[before.length - 1] : candidates[0] || null;
  }

  // Frameworks install their own value setters; setUserInput goes through the
  // same path as typing, so React and friends see the change.
  #setValue(field, value) {
    if (!field) {
      return;
    }
    field.setUserInput(value);
  }

  #report() {
    const hasLogin = this.#passwordFields().length > 0;
    const url = this.document.documentURI;
    const key = `${hasLogin}|${url}`;
    if (key === this.#lastReport) {
      return;
    }
    this.#lastReport = key;
    this.sendAsyncMessage("form", { hasLogin, url });
  }

  #capture() {
    const field = this.#passwordFields()[0];
    if (!field?.value) {
      return;
    }
    const userField = this.#usernameFor(field);
    const username = userField ? userField.value : "";
    const account = `${this.document.nodePrincipal.originNoSuffix}|${username}`;
    const now = Date.now();
    if (
      account === this.#lastCapture.account &&
      now - this.#lastCapture.at < 2000
    ) {
      return; // submit and a click often fire for one sign-in
    }
    this.#lastCapture = { account, at: now };
    // The parent takes the origin from the page it knows, not from us.
    this.sendAsyncMessage("captured", { username, password: field.value });
  }

  handleEvent(event) {
    switch (event.type) {
      case "DOMContentLoaded":
      case "pageshow":
        this.#report();
        if (!this.#observer && this.document.documentElement) {
          this.#observer = new this.contentWindow.MutationObserver(() =>
            this.#report()
          );
          this.#observer.observe(this.document.documentElement, {
            childList: true,
            subtree: true,
          });
        }
        break;
      case "submit":
        this.#capture();
        break;
      case "click": {
        const target = event.target?.closest?.(
          'button, input[type="submit"], [role="button"]'
        );
        if (target) {
          this.contentWindow.setTimeout(() => this.#capture(), 0);
        }
        break;
      }
    }
  }

  receiveMessage({ name, data }) {
    if (name !== "fill") {
      return false;
    }
    // Refuse if the page moved to another origin since the parent decided.
    // originNoSuffix: in a container the principal's origin ends in
    // "^userContextId=N", which would never equal the site's origin.
    if (this.document.nodePrincipal.originNoSuffix !== data.origin) {
      return false;
    }
    const field = this.#passwordFields()[0];
    if (!field) {
      return false;
    }
    const userField = this.#usernameFor(field);
    if (data.username && userField) {
      this.#setValue(userField, data.username);
    }
    this.#setValue(field, data.password);
    field.focus();
    return true;
  }

  didDestroy() {
    this.#observer?.disconnect();
  }
}
