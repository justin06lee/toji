/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Tells the browser when the pointer reaches the top edge of the page, where the
// unpinned bookmarks bar comes down (the shell's own chrome never sees the pointer once
// it is over a page). Sends only when the answer changes.

const EDGE_PX = 10;

export class TojiEdgeChild extends JSWindowActorChild {
  #inside = false;

  handleEvent(event) {
    if (this.browsingContext !== this.browsingContext.top) {
      return;
    }
    let inside = this.#inside;
    if (event.type === "mousemove") {
      inside = event.clientY >= 0 && event.clientY <= EDGE_PX;
    } else if (event.type === "mouseout" && !event.relatedTarget) {
      inside = false;
    }
    if (inside !== this.#inside) {
      this.#inside = inside;
      this.sendAsyncMessage("edge", { inside });
    }
  }
}
