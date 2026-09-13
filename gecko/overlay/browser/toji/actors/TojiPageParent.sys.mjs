/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  TojiPageAPI: "resource:///modules/toji/TojiPages.sys.mjs",
  TojiPageEvents: "resource:///modules/toji/TojiPages.sys.mjs",
});

const TOPICS = new Set(["containers", "settings", "tor"]);

export class TojiPageParent extends JSWindowActorParent {
  receiveMessage({ name, data }) {
    // Only Toji's own pages (system principal, about:<page>) may call in.
    const principal = this.manager.documentPrincipal;
    if (!principal?.isSystemPrincipal) {
      throw new Error("TojiPage: refused a call from an unprivileged page");
    }
    switch (name) {
      case "call":
        return lazy.TojiPageAPI.call(data.name, data.args, this);
      case "subscribe":
        if (TOPICS.has(data.topic)) {
          lazy.TojiPageEvents.subscribe(data.topic, this);
        }
        return null;
      default:
        return null;
    }
  }

  didDestroy() {
    lazy.TojiPageEvents.unsubscribeAll(this);
  }
}
