/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Toji (gecko/overlay): the handlers of the popups that stay (see
// main-popupset.inc.xhtml). The page context menu's are in browser-context.js.

document.addEventListener(
  "DOMContentLoaded",
  () => {
    let mainPopupSet = document.getElementById("mainPopupSet");
    mainPopupSet.addEventListener("command", event => {
      switch (event.target.id) {
        // == pictureInPictureToggleContextMenu ==
        case "context_HidePictureInPictureToggle":
          PictureInPicture.hideToggle();
          break;
        case "context_MovePictureInPictureToggle":
          PictureInPicture.moveToggle();
          break;

        // == sharing-tabs-warning-panel ==
        case "sharing-warning-proceed-to-tab":
          gSharedTabWarning.allowSharedTabSwitch();
          break;
      }
    });

    document
      .getElementById("webRTC-selectWindow-menulist")
      ?.addEventListener("command", event => {
        webrtcUI.updateWarningLabel(event.currentTarget);
      });

    mainPopupSet.addEventListener("popupshown", event => {
      switch (event.target.id) {
        case "sharing-tabs-warning-panel":
          gSharedTabWarning.sharedTabWarningShown();
          break;
      }
    });
  },
  { once: true }
);
