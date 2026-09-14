/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Toji (gecko/overlay): the menubar's handlers (see browser-menubar.inc.xhtml).

document.addEventListener(
  "DOMContentLoaded",
  () => {
    let mainMenuBar = document.getElementById("main-menubar");

    mainMenuBar.addEventListener("command", event => {
      switch (event.target.id) {
        case "menu_preferences":
        case "menu_settings":
          openPreferences(undefined);
          break;
        case "repair-text-encoding":
          BrowserCommands.forceEncodingDetection();
          break;
        case "enterFullScreenItem":
        case "exitFullScreenItem":
          BrowserCommands.fullScreen();
          break;
        case "documentDirection-swap":
          gBrowser.selectedBrowser.sendMessageToActor(
            "SwitchDocumentDirection",
            {},
            "SwitchDocumentDirection",
            "roots"
          );
          break;
        case "helpSafeMode":
          safeModeRestart();
          break;
        case "troubleShooting":
          openTroubleshootingPage();
          break;
        case "aboutName":
          openAboutDialog();
          break;
        case "helpPolicySupport":
          openTrustedLinkIn(Services.policies.getSupportMenu().URL.href, "tab");
          break;
      }
    });

    mainMenuBar.addEventListener("popupshowing", event => {
      switch (event.target.id) {
        case "menu_FilePopup":
          gFileMenu.onPopupShowing(event);
          break;
        case "menu_EditPopup":
          updateEditUIVisibility();
          break;
        case "menu_HelpPopup":
          buildHelpMenu();
          break;
      }
    });

    document
      .getElementById("menu_EditPopup")
      .addEventListener("popuphidden", () => {
        updateEditUIVisibility();
      });
  },
  { once: true }
);
