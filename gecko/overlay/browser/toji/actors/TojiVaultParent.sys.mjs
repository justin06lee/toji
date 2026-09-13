/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  TojiVault: "resource:///modules/toji/TojiVault.sys.mjs",
});

export class TojiVaultParent extends JSWindowActorParent {
  receiveMessage({ name, data }) {
    const browser = this.browsingContext.top.embedderElement;
    if (!browser || this.browsingContext !== this.browsingContext.top) {
      return;
    }
    // Only web pages take part; the page's URL and container come from what
    // the parent knows about this tab, never from the message.
    const scheme = this.manager.documentURI?.scheme;
    if (scheme !== "http" && scheme !== "https") {
      return;
    }
    switch (name) {
      case "form":
        lazy.TojiVault.formReport(browser, {
          hasLogin: !!data?.hasLogin,
          url: this.manager.documentURI.spec,
        });
        break;
      case "captured":
        if (typeof data?.password === "string" && data.password) {
          lazy.TojiVault.captured(browser, {
            username: String(data.username ?? ""),
            password: data.password,
          });
        }
        break;
    }
  }
}
