/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Toji's browser glue (gecko/overlay): the application's startup, shutdown and
// first-window hooks, from Firefox's BrowserGlue with everything that drove
// Firefox's UI or Mozilla's services taken out — onboarding, messaging,
// the default-browser and profile-reset prompts, Sync, telemetry, studies,
// Screenshots, the new tab cache, backups, the update agent. What is left is
// the engine's behaviour: session restore, distribution customizations, the
// profile data upgrader, PDF.js and downloads' handlers, add-on signing,
// Safe Browsing and Remote Settings initialization, containers, the
// protocol-handler registrar, the per-window and idle startup categories.

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  ContentBlockingPrefs:
    "moz-src:///browser/components/protections/ContentBlockingPrefs.sys.mjs",
  ContextualIdentityService:
    "resource://gre/modules/ContextualIdentityService.sys.mjs",
  DesktopActorRegistry:
    "moz-src:///browser/components/DesktopActorRegistry.sys.mjs",
  DistributionManagement: "resource:///modules/distribution.sys.mjs",
  DownloadsViewableInternally:
    "moz-src:///browser/components/downloads/DownloadsViewableInternally.sys.mjs",
  ExtensionsUI: "resource:///modules/ExtensionsUI.sys.mjs",
  PdfJs: "resource://pdf.js/PdfJs.sys.mjs",
  PlacesBrowserStartup:
    "moz-src:///browser/components/places/PlacesBrowserStartup.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  ProfileDataUpgrader:
    "moz-src:///browser/components/ProfileDataUpgrader.sys.mjs",
  RemoteSettings: "resource://services-settings/remote-settings.sys.mjs",
  SafeBrowsing: "resource://gre/modules/SafeBrowsing.sys.mjs",
  Sanitizer: "resource:///modules/Sanitizer.sys.mjs",
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  SessionStartup: "resource:///modules/sessionstore/SessionStartup.sys.mjs",
  WebProtocolHandlerRegistrar:
    "resource:///modules/WebProtocolHandlerRegistrar.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

XPCOMUtils.defineLazyServiceGetters(lazy, {
  PushService: ["@mozilla.org/push/Service;1", Ci.nsIPushService],
});

const PREF_PDFJS_ISDEFAULT_CACHE_STATE = "pdfjs.enabledCache.state";

ChromeUtils.defineLazyGetter(lazy, "gBrandBundle", function () {
  return Services.strings.createBundle(
    "chrome://branding/locale/brand.properties"
  );
});

ChromeUtils.defineLazyGetter(lazy, "gBrowserBundle", function () {
  return Services.strings.createBundle(
    "chrome://browser/locale/browser.properties"
  );
});

// Seconds of idle time before the late idle tasks will be scheduled.
const LATE_TASKS_IDLE_TIME_SEC = 20;
// Time after we stop tracking startup crashes.
const STARTUP_CRASHES_END_DELAY_MS = 30 * 1000;

/*
 * OS X has the concept of zero-window sessions and therefore ignores the
 * browser-lastwindow-close-* topics.
 */
const OBSERVE_LASTWINDOW_CLOSE_TOPICS = AppConstants.platform != "macosx";

export let BrowserInitState = {};
BrowserInitState.startupIdleTaskPromise = new Promise(resolve => {
  BrowserInitState._resolveStartupIdleTask = resolve;
});
BrowserInitState.isLaunchOnLogin = false;
BrowserInitState.isTaskbarTab = false;

export function BrowserGlue() {
  XPCOMUtils.defineLazyServiceGetter(
    this,
    "_userIdleService",
    "@mozilla.org/widget/useridleservice;1",
    Ci.nsIUserIdleService
  );

  this._init();
}

BrowserGlue.prototype = {
  _saveSession: false,
  _isNewProfile: undefined,

  _setPrefToSaveSession: function BG__setPrefToSaveSession(aForce) {
    if (!this._saveSession && !aForce) {
      return;
    }

    if (!lazy.PrivateBrowsingUtils.permanentPrivateBrowsing) {
      Services.prefs.setBoolPref(
        "browser.sessionstore.resume_session_once",
        true
      );
    }

    // This method can be called via [NSApplication terminate:] on Mac, which
    // ends up causing prefs not to be flushed to disk, so we need to do that
    // explicitly here. See bug 497652.
    Services.prefs.savePrefFile(null);
  },

  // nsIObserver implementation
  observe: async function BG_observe(subject, topic, data) {
    switch (topic) {
      case "notifications-open-settings":
        this._openPreferences("privacy-permissions");
        break;
      case "final-ui-startup":
        this._beforeUIStartup();
        break;
      case "browser-delayed-startup-finished":
        this._onFirstWindowLoaded(subject);
        Services.obs.removeObserver(this, "browser-delayed-startup-finished");
        break;
      case "sessionstore-windows-restored":
        this._onWindowsRestored();
        break;
      case "browser:purge-session-history":
        // reset the console service's error buffer
        Services.console.logStringMessage(null); // clear the console (in case it's open)
        Services.console.reset();
        break;
      case "restart-in-safe-mode":
        this._onSafeModeRestart(subject);
        break;
      case "quit-application-granted":
        this._onQuitApplicationGranted();
        break;
      case "browser-lastwindow-close-granted":
        if (OBSERVE_LASTWINDOW_CLOSE_TOPICS) {
          this._setPrefToSaveSession();
        }
        break;
      case "session-save":
        this._setPrefToSaveSession(true);
        subject.QueryInterface(Ci.nsISupportsPRBool);
        subject.data = true;
        break;
      case "places-init-complete":
        Services.obs.removeObserver(this, "places-init-complete");
        lazy.PlacesBrowserStartup.backendInitComplete();
        break;
      case "handle-xul-text-link": {
        let linkHandled = subject.QueryInterface(Ci.nsISupportsPRBool);
        if (!linkHandled.data) {
          let win =
            lazy.BrowserWindowTracker.getTopWindow() ??
            (await lazy.BrowserWindowTracker.promiseOpenWindow());
          if (win) {
            data = JSON.parse(data);
            let where = lazy.BrowserUtils.whereToOpenLink(data);
            // Preserve legacy behavior of non-modifier left-clicks
            // opening in a new selected tab.
            if (where == "current") {
              where = "tab";
            }
            win.openTrustedLinkIn(data.href, where);
            linkHandled.data = true;
          }
        }
        break;
      }
      case "profile-before-change":
        // Any component that doesn't need to act after
        // the UI has gone should be finalized in _onQuitApplicationGranted.
        this._dispose();
        break;
      case "xpi-signature-changed": {
        let disabledAddons = JSON.parse(data).disabled;
        let addons = await lazy.AddonManager.getAddonsByIDs(disabledAddons);
        if (addons.some(addon => addon)) {
          this._notifyUnsignedAddonsDisabled();
        }
        break;
      }
      case "handlersvc-store-initialized":
        // Initialize PdfJs when running in-process and remote. This only
        // happens once since PdfJs registers global hooks. If the PdfJs
        // extension is installed the init method below will be overridden
        // leaving initialization to the extension.
        lazy.PdfJs.init(this._isNewProfile);

        // Allow certain viewable internally types to be opened from downloads.
        lazy.DownloadsViewableInternally.register();

        break;
    }
  },

  // initialization (called on application startup)
  _init: function BG__init() {
    let os = Services.obs;
    [
      "notifications-open-settings",
      "final-ui-startup",
      "browser-delayed-startup-finished",
      "sessionstore-windows-restored",
      "browser:purge-session-history",
      "quit-application-granted",
      "session-save",
      "places-init-complete",
      "handle-xul-text-link",
      "profile-before-change",
      "restart-in-safe-mode",
      "xpi-signature-changed",
      "handlersvc-store-initialized",
    ].forEach(topic => os.addObserver(this, topic, true));
    if (OBSERVE_LASTWINDOW_CLOSE_TOPICS) {
      os.addObserver(this, "browser-lastwindow-close-granted", true);
    }

    lazy.DesktopActorRegistry.init();
  },

  // cleanup (called on application shutdown)
  _dispose: function BG__dispose() {
    if (this._lateTasksIdleObserver) {
      this._userIdleService.removeIdleObserver(
        this._lateTasksIdleObserver,
        LATE_TASKS_IDLE_TIME_SEC
      );
      delete this._lateTasksIdleObserver;
    }
    if (this._gmpInstallManager) {
      this._gmpInstallManager.uninit();
      delete this._gmpInstallManager;
    }

    lazy.ContentBlockingPrefs.uninit();
  },

  // runs on startup, before the first command line handler is invoked
  // (i.e. before the first window is opened)
  _beforeUIStartup: function BG__beforeUIStartup() {
    lazy.SessionStartup.init();

    // check if we're in safe mode
    if (Services.appinfo.inSafeMode) {
      Services.ww.openWindow(
        null,
        "chrome://browser/content/safeMode.xhtml",
        "_blank",
        "chrome,centerscreen,modal,resizable=no",
        null
      );
    }

    // apply distribution customizations
    lazy.DistributionManagement.applyCustomizations();

    // handle any UI migration
    this._migrateUI();

    if (!Services.prefs.prefHasUserValue(PREF_PDFJS_ISDEFAULT_CACHE_STATE)) {
      lazy.PdfJs.checkIsDefault(this._isNewProfile);
    }

    lazy.BrowserUtils.callModulesFromCategory({
      categoryName: "browser-before-ui-startup",
    });

    Services.obs.notifyObservers(null, "browser-ui-startup-complete");
  },

  async _onSafeModeRestart(window) {
    // prompt the user to confirm
    let productName = lazy.gBrandBundle.GetStringFromName("brandShortName");
    let strings = lazy.gBrowserBundle;
    let promptTitle = strings.formatStringFromName(
      "troubleshootModeRestartPromptTitle",
      [productName]
    );
    let promptMessage = strings.GetStringFromName(
      "troubleshootModeRestartPromptMessage"
    );
    let restartText = strings.GetStringFromName(
      "troubleshootModeRestartButton"
    );
    let buttonFlags =
      Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING +
      Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_CANCEL +
      Services.prompt.BUTTON_POS_0_DEFAULT;

    let rv = await Services.prompt.asyncConfirmEx(
      window.browsingContext,
      Ci.nsIPrompt.MODAL_TYPE_INTERNAL_WINDOW,
      promptTitle,
      promptMessage,
      buttonFlags,
      restartText,
      null,
      null,
      null,
      {}
    );
    if (rv.get("buttonNumClicked") != 0) {
      return;
    }

    let cancelQuit = Cc["@mozilla.org/supports-PRBool;1"].createInstance(
      Ci.nsISupportsPRBool
    );
    Services.obs.notifyObservers(
      cancelQuit,
      "quit-application-requested",
      "restart"
    );

    if (!cancelQuit.data) {
      Services.startup.restartInSafeMode(Ci.nsIAppStartup.eAttemptQuit);
    }
  },

  _notifyUnsignedAddonsDisabled() {
    let win = lazy.BrowserWindowTracker.getTopWindow({
      allowFromInactiveWorkspace: true,
    });
    if (!win) {
      return;
    }

    let message = win.gNavigatorBundle.getString(
      "unsignedAddonsDisabled.message"
    );
    let buttons = [
      {
        label: win.gNavigatorBundle.getString(
          "unsignedAddonsDisabled.learnMore.label"
        ),
        accessKey: win.gNavigatorBundle.getString(
          "unsignedAddonsDisabled.learnMore.accesskey"
        ),
        callback() {
          win.BrowserAddonUI.openAddonsMgr(
            "addons://list/extension?unsigned=true"
          );
        },
      },
    ];

    win.gNotificationBox.appendNotification(
      "unsigned-addons-disabled",
      {
        label: message,
        priority: win.gNotificationBox.PRIORITY_WARNING_MEDIUM,
      },
      buttons
    );
  },

  // the first browser window has finished initializing
  _onFirstWindowLoaded: function BG__onFirstWindowLoaded(aWindow) {
    lazy.BrowserUtils.callModulesFromCategory(
      {
        categoryName: "browser-first-window-ready",
        profilerMarker: "browserFirstWindowReady",
      },
      aWindow
    );
  },

  /**
   * Application shutdown handler.
   */
  _onQuitApplicationGranted() {
    function failureHandler(ex) {
      if (Cu.isInAutomation) {
        Cc["@mozilla.org/xpcom/debug;1"]
          .getService(Ci.nsIDebug2)
          .abort(ex.filename || ex.fileName, ex.lineNumber);
      }
    }

    lazy.BrowserUtils.callModulesFromCategory({
      categoryName: "browser-quit-application-granted",
      failureHandler,
    });

    let tasks = [
      // This pref must be set here because SessionStore will use its value
      // on quit-application.
      () => this._setPrefToSaveSession(),

      // Call trackStartupCrashEnd here in case the delayed call on startup hasn't
      // yet occurred (see trackStartupCrashEnd caller in browser.js).
      () => Services.startup.trackStartupCrashEnd(),

      () => {
        // bug 1839426 - The FOG service needs to be instantiated reliably so it
        // can perform at-shutdown tasks later in shutdown.
        Services.fog;
      },
    ];

    for (let task of tasks) {
      try {
        task();
      } catch (ex) {
        console.error(`Error during quit-application-granted: ${ex}`);
        failureHandler(ex);
      }
    }
  },

  // All initial windows have opened.
  _onWindowsRestored: function BG__onWindowsRestored() {
    if (this._windowsWereRestored) {
      return;
    }
    this._windowsWereRestored = true;

    lazy.ExtensionsUI.init();

    let signingRequired;
    if (AppConstants.MOZ_REQUIRE_SIGNING) {
      signingRequired = true;
    } else {
      signingRequired = Services.prefs.getBoolPref(
        "xpinstall.signatures.required"
      );
    }

    if (signingRequired) {
      let disabledAddons = lazy.AddonManager.getStartupChanges(
        lazy.AddonManager.STARTUP_CHANGE_DISABLED
      );
      lazy.AddonManager.getAddonsByIDs(disabledAddons).then(addons => {
        for (let addon of addons) {
          if (addon.signedState <= lazy.AddonManager.SIGNEDSTATE_MISSING) {
            this._notifyUnsignedAddonsDisabled();
            break;
          }
        }
      });
    }

    lazy.Sanitizer.onStartup();
    this._scheduleStartupIdleTasks();
    this._lateTasksIdleObserver = (idleService, topic) => {
      if (topic == "idle") {
        idleService.removeIdleObserver(
          this._lateTasksIdleObserver,
          LATE_TASKS_IDLE_TIME_SEC
        );
        delete this._lateTasksIdleObserver;
        this._scheduleBestEffortUserIdleTasks();
      }
    };
    this._userIdleService.addIdleObserver(
      this._lateTasksIdleObserver,
      LATE_TASKS_IDLE_TIME_SEC
    );
  },

  /**
   * Tasks that need to run only once after startup, from idle callbacks once
   * every window has finished being restored by session restore, before the
   * per-window idle tasks (_schedulePerWindowIdleTasks in browser-init.js).
   */
  _scheduleStartupIdleTasks() {
    function runIdleTasks(idleTasks) {
      for (let task of idleTasks) {
        if ("condition" in task && !task.condition) {
          continue;
        }

        ChromeUtils.idleDispatch(
          async () => {
            if (!Services.startup.shuttingDown) {
              let startTime = ChromeUtils.now();
              try {
                await task.task();
              } catch (ex) {
                console.error(ex);
              } finally {
                ChromeUtils.addProfilerMarker(
                  "startupIdleTask",
                  startTime,
                  task.name
                );
              }
            }
          },
          task.timeout ? { timeout: task.timeout } : undefined
        );
      }
    }

    const earlyTasks = [
      // It's important that SafeBrowsing is initialized reasonably
      // early, so we use a maximum timeout for it.
      {
        name: "SafeBrowsing.init",
        task: () => {
          lazy.SafeBrowsing.init();
        },
        timeout: 5000,
      },

      {
        name: "ContextualIdentityService.load",
        task: async () => {
          await lazy.ContextualIdentityService.load();
        },
      },
    ];

    runIdleTasks(earlyTasks);

    lazy.BrowserUtils.callModulesFromCategory({
      categoryName: "browser-idle-startup",
      profilerMarker: "startupIdleTask",
      idleDispatch: true,
    });

    const lateTasks = [
      // Begin listening for incoming push messages.
      {
        name: "PushService.ensureReady",
        task: () => {
          try {
            lazy.PushService.wrappedJSObject.ensureReady();
          } catch (ex) {
            // NS_ERROR_NOT_AVAILABLE will get thrown for the PushService
            // getter if the PushService is disabled.
            if (ex.result != Cr.NS_ERROR_NOT_AVAILABLE) {
              throw ex;
            }
          }
        },
      },

      {
        name: "trackStartupCrashEndSetTimeout",
        task: () => {
          lazy.setTimeout(function () {
            Services.tm.idleDispatchToMainThread(
              Services.startup.trackStartupCrashEnd
            );
          }, STARTUP_CRASHES_END_DELAY_MS);
        },
      },

      {
        name: "handlerService.asyncInit",
        task: () => {
          let handlerService = Cc[
            "@mozilla.org/uriloader/handler-service;1"
          ].getService(Ci.nsIHandlerService);
          handlerService.asyncInit();
        },
      },

      {
        name: "webProtocolHandlerService.asyncInit",
        task: () => {
          lazy.WebProtocolHandlerRegistrar.prototype.init(true);
        },
      },

      // Login detection service is used in fission to identify high value sites.
      {
        name: "LoginDetection.init",
        task: () => {
          let loginDetection = Cc[
            "@mozilla.org/login-detection-service;1"
          ].createInstance(Ci.nsILoginDetectionService);
          loginDetection.init();
        },
      },

      {
        // Starts the JSOracle process for ORB JavaScript validation, if it hasn't started already.
        name: "start-orb-javascript-oracle",
        task: () => {
          ChromeUtils.ensureJSOracleStarted();
        },
      },

      {
        name: "browser-startup-idle-tasks-finished",
        task: () => {
          // Use idleDispatch a second time to run this after the per-window
          // idle tasks.
          ChromeUtils.idleDispatch(() => {
            Services.obs.notifyObservers(
              null,
              "browser-startup-idle-tasks-finished"
            );
            BrowserInitState._resolveStartupIdleTask();
          });
        },
      },
      // Do NOT add anything after idle tasks finished.
    ];

    runIdleTasks(lateTasks);
  },

  /**
   * Tasks we hope to run once per session, at any arbitrary point in time,
   * and which we are okay with sometimes not running at all.
   */
  _scheduleBestEffortUserIdleTasks() {
    const idleTasks = [
      function GMPInstallManagerSimpleCheckAndInstall() {
        let { GMPInstallManager } = ChromeUtils.importESModule(
          "resource://gre/modules/GMPInstallManager.sys.mjs"
        );
        this._gmpInstallManager = new GMPInstallManager();
        // We don't really care about the results, if someone is interested they
        // can check the log.
        this._gmpInstallManager.simpleCheckAndInstall().catch(() => {});
      }.bind(this),

      function RemoteSettingsInit() {
        lazy.RemoteSettings.init();
      },

      function searchBackgroundChecks() {
        lazy.SearchService.runBackgroundChecks();
      },
    ];

    for (let task of idleTasks) {
      ChromeUtils.idleDispatch(async () => {
        if (!Services.startup.shuttingDown) {
          let startTime = ChromeUtils.now();
          try {
            await task();
          } catch (ex) {
            console.error(ex);
          } finally {
            ChromeUtils.addProfilerMarker(
              "startupLateIdleTask",
              startTime,
              task.name
            );
          }
        }
      });
    }

    lazy.BrowserUtils.callModulesFromCategory({
      categoryName: "browser-best-effort-idle-startup",
      idleDispatch: true,
      profilerMarker: "startupLateIdleTask",
    });
  },

  _quitSource: "unknown",
  _registerQuitSource(source) {
    this._quitSource = source;
  },

  _migrateUI() {
    // Use an increasing number to keep track of the current state of the user's
    // profile, so we can move data around as needed as the browser evolves.
    // Completely unrelated to the current Firefox release number.
    const APP_DATA_VERSION = 175;
    const PREF = "browser.migration.version";

    let profileDataVersion = Services.prefs.getIntPref(PREF, -1);
    this._isNewProfile = profileDataVersion == -1;

    if (this._isNewProfile) {
      // This is a new profile, nothing to upgrade.
      Services.prefs.setIntPref(PREF, APP_DATA_VERSION);
    } else if (profileDataVersion < APP_DATA_VERSION) {
      lazy.ProfileDataUpgrader.upgrade(profileDataVersion, APP_DATA_VERSION);
    }
  },

  /**
   * Open Toji's settings (a window's openPreferences is the shell's).
   */
  _openPreferences(...args) {
    let chromeWindow = lazy.BrowserWindowTracker.getTopWindow({
      allowFromInactiveWorkspace: true,
    });
    if (chromeWindow) {
      chromeWindow.openPreferences(...args);
    }
  },

  QueryInterface: ChromeUtils.generateQI([
    "nsIObserver",
    "nsISupportsWeakReference",
  ]),
};
