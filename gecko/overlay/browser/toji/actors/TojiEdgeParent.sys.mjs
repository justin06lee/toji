/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  TojiShell: "resource:///modules/toji/TojiShell.sys.mjs",
});

export class TojiEdgeParent extends JSWindowActorParent {
  receiveMessage({ name, data }) {
    if (name === "edge") {
      lazy.TojiShell.pageTopEdge(this.browsingContext.top.embedderElement, !!data?.inside);
    }
  }
}
