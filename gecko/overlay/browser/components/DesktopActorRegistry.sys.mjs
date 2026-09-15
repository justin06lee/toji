/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Toji's desktop actor registry (gecko/overlay). The actors behind the
// engine's behaviour in pages — prompts, permissions, links and favicons,
// media, crashes, the context menu, PDF.js — without the ones behind Firefox's
// pages and panels, which are deleted from the tree. Toji's own actors (the
// vault, the agent, the page-top edge, the pages' bridge) are registered by
// Toji's modules.

import { ActorManagerParent } from "resource://gre/modules/ActorManagerParent.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
});

let JSPROCESSACTORS = {
  // Miscellaneous stuff that needs to be initialized per process.
  BrowserProcess: {
    child: {
      esModuleURI: "resource:///actors/BrowserProcessChild.sys.mjs",
      observers: [
        // WebRTC related notifications. They are here to avoid loading WebRTC
        // components when not needed.
        "getUserMedia:request",
        "recording-device-stopped",
        "PeerConnection:request",
        "recording-device-events",
        "recording-window-ended",
      ],
    },
  },

  RefreshBlockerObserver: {
    child: {
      esModuleURI: "resource:///actors/RefreshBlockerChild.sys.mjs",
      observers: [
        "webnavigation-create",
        "chrome-webnavigation-create",
        "webnavigation-destroy",
        "chrome-webnavigation-destroy",
      ],
    },

    enablePreference: "accessibility.blockautorefresh",
    onPreferenceChanged: isEnabled => {
      lazy.BrowserWindowTracker.orderedWindows.forEach(win => {
        for (let browser of win.gBrowser.browsers) {
          try {
            browser.sendMessageToActor(
              "PreferenceChanged",
              { isEnabled },
              "RefreshBlocker",
              "all"
            );
          } catch (ex) {}
        }
      });
    },
  },
};

let JSWINDOWACTORS = {
  AboutTabCrashed: {
    parent: {
      esModuleURI: "resource:///actors/AboutTabCrashedParent.sys.mjs",
    },
    child: {
      esModuleURI: "resource:///actors/AboutTabCrashedChild.sys.mjs",
      events: {
        DOMDocElementInserted: { capture: true },
      },
    },

    matches: ["about:tabcrashed*"],
    remoteTypes: ["parent"],
  },

  BlockedSite: {
    parent: {
      esModuleURI: "resource:///actors/BlockedSiteParent.sys.mjs",
    },
    child: {
      esModuleURI: "resource:///actors/BlockedSiteChild.sys.mjs",
      events: {
        AboutBlockedLoaded: { wantUntrusted: true },
        click: {},
      },
    },
    matches: ["about:blocked?*"],
    allFrames: true,
  },

  BrowserTab: {
    child: {
      esModuleURI: "resource:///actors/BrowserTabChild.sys.mjs",
    },

    messageManagerGroups: ["browsers"],
  },

  ClickHandler: {
    parent: {
      esModuleURI: "resource:///actors/ClickHandlerParent.sys.mjs",
    },
    child: {
      esModuleURI: "resource:///actors/ClickHandlerChild.sys.mjs",
      events: {
        chromelinkclick: { capture: true, mozSystemGroup: true },
      },
    },

    allFrames: true,
  },

  /* Note: this uses the same JSMs as ClickHandler, but because it
   * relies on "normal" click events anywhere on the page (not just
   * links) and is expensive, and only does something for the
   * small group of people who have the feature enabled, it is its
   * own actor which is only registered if the pref is enabled.
   */
  MiddleMousePasteHandler: {
    parent: {
      esModuleURI: "resource:///actors/ClickHandlerParent.sys.mjs",
    },
    child: {
      esModuleURI: "resource:///actors/ClickHandlerChild.sys.mjs",
      events: {
        auxclick: { capture: true, mozSystemGroup: true },
      },
    },
    enablePreference: "middlemouse.contentLoadURL",

    allFrames: true,
  },

  ContextMenu: {
    parent: {
      esModuleURI: "resource:///actors/ContextMenuParent.sys.mjs",
    },

    child: {
      esModuleURI: "resource:///actors/ContextMenuChild.sys.mjs",
      events: {
        contextmenu: { mozSystemGroup: true },
      },
    },

    allFrames: true,
  },

  DecoderDoctor: {
    parent: {
      esModuleURI: "resource:///actors/DecoderDoctorParent.sys.mjs",
    },

    child: {
      esModuleURI: "resource:///actors/DecoderDoctorChild.sys.mjs",
      observers: ["decoder-doctor-notification"],
    },

    messageManagerGroups: ["browsers"],
    allFrames: true,
  },

  DOMFullscreen: {
    parent: {
      esModuleURI: "resource:///actors/DOMFullscreenParent.sys.mjs",
    },

    child: {
      esModuleURI: "resource:///actors/DOMFullscreenChild.sys.mjs",
      events: {
        "MozDOMFullscreen:Request": {},
        "MozDOMFullscreen:Entered": {},
        "MozDOMFullscreen:NewOrigin": {},
        "MozDOMFullscreen:Exit": {},
        "MozDOMFullscreen:Exited": {},
        "MozDOMFullscreen:WarnAboutKeyboardLock": {},
        "MozDOMFullscreen:UpdateKeyboardLock": {},
      },
    },

    messageManagerGroups: ["browsers"],
    allFrames: true,
  },

  EncryptedMedia: {
    parent: {
      esModuleURI: "resource:///actors/EncryptedMediaParent.sys.mjs",
    },

    child: {
      esModuleURI: "resource:///actors/EncryptedMediaChild.sys.mjs",
      observers: ["mediakeys-request"],
    },

    messageManagerGroups: ["browsers"],
    allFrames: true,
  },

  FormValidation: {
    parent: {
      esModuleURI: "resource:///actors/FormValidationParent.sys.mjs",
    },

    child: {
      esModuleURI: "resource:///actors/FormValidationChild.sys.mjs",
      events: {
        MozInvalidForm: {},
        // Listening to ‘pageshow’ event is only relevant if an invalid form
        // popup was open, so don't create the actor when fired.
        pageshow: { createActor: false },
      },
    },

    allFrames: true,
  },

  LinkHandler: {
    parent: {
      esModuleURI: "resource:///actors/LinkHandlerParent.sys.mjs",
    },
    child: {
      esModuleURI: "resource:///actors/LinkHandlerChild.sys.mjs",
      events: {
        DOMHeadElementParsed: {},
        DOMLinkAdded: {},
        DOMLinkChanged: {},
        pageshow: {},
        // The `pagehide` event is only used to clean up state which will not be
        // present if the actor hasn't been created.
        pagehide: { createActor: false },
      },
    },

    messageManagerGroups: ["browsers"],
  },

  Pdfjs: {
    parent: {
      esModuleURI: "resource://pdf.js/PdfjsParent.sys.mjs",
    },
    child: {
      esModuleURI: "resource://pdf.js/PdfjsChild.sys.mjs",
    },
    allFrames: true,
  },

  // GMP crash reporting
  Plugin: {
    parent: {
      esModuleURI: "resource:///actors/PluginParent.sys.mjs",
    },
    child: {
      esModuleURI: "resource:///actors/PluginChild.sys.mjs",
      events: {
        PluginCrashed: { capture: true },
      },
    },

    allFrames: true,
  },

  PointerLock: {
    parent: {
      esModuleURI: "resource:///actors/PointerLockParent.sys.mjs",
    },
    child: {
      esModuleURI: "resource:///actors/PointerLockChild.sys.mjs",
      events: {
        "MozDOMPointerLock:Entered": {},
        "MozDOMPointerLock:Exited": {},
      },
    },

    messageManagerGroups: ["browsers"],
    allFrames: true,
  },

  Prompt: {
    parent: {
      esModuleURI: "resource:///actors/PromptParent.sys.mjs",
    },
    includeChrome: true,
    allFrames: true,
  },

  RefreshBlocker: {
    parent: {
      esModuleURI: "resource:///actors/RefreshBlockerParent.sys.mjs",
    },
    child: {
      esModuleURI: "resource:///actors/RefreshBlockerChild.sys.mjs",
    },

    messageManagerGroups: ["browsers"],
    enablePreference: "accessibility.blockautorefresh",
  },

  SpeechDispatcher: {
    parent: {
      esModuleURI: "resource:///actors/SpeechDispatcherParent.sys.mjs",
    },

    child: {
      esModuleURI: "resource:///actors/SpeechDispatcherChild.sys.mjs",
      observers: ["chrome-synth-voices-error"],
    },

    messageManagerGroups: ["browsers"],
    allFrames: true,
  },

  SwitchDocumentDirection: {
    child: {
      esModuleURI: "resource:///actors/SwitchDocumentDirectionChild.sys.mjs",
    },

    allFrames: true,
  },

  WebRTC: {
    parent: {
      esModuleURI: "resource:///actors/WebRTCParent.sys.mjs",
    },
    child: {
      esModuleURI: "resource:///actors/WebRTCChild.sys.mjs",
    },

    allFrames: true,
  },
};

export let DesktopActorRegistry = {
  init() {
    ActorManagerParent.addJSProcessActors(JSPROCESSACTORS);
    ActorManagerParent.addJSWindowActors(JSWINDOWACTORS);
  },
};
