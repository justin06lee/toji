/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Toji's browser window initialization (gecko/overlay): Firefox's
// browser-init.js without the toolbars, panels, URL bar, sidebar, Sync,
// profiles and the rest of its UI. What is left brings the engine up in the
// window — the tab model, session restore, the progress listeners, the
// window's URI, full screen, gestures, downloads' handlers — and runs the
// startup categories that Toji's own modules hook (Toji.manifest).

var gSerialDeviceObserver = {
  _activePortCounts: new WeakMap(),

  observe(subject, topic, _data) {
    if (topic != "serial-device-state-changed") {
      return;
    }

    let props = subject.QueryInterface(Ci.nsIPropertyBag2);
    const browserId = props.getPropertyAsUint64("browserId");
    let bc = BrowsingContext.getCurrentTopByBrowserId(browserId);
    if (!bc) {
      console.warn("BrowsingContext not found for browser ID:", browserId);
      return;
    }
    let browser = bc.embedderElement;
    if (!browser) {
      console.warn("No embedder element for BrowsingContext");
      return;
    }

    let connected = props.getPropertyAsBool("connected");
    let count = this._activePortCounts.get(browser) || 0;
    count = connected ? count + 1 : Math.max(0, count - 1);
    this._activePortCounts.set(browser, count);

    if (gBrowser) {
      gBrowser.updateBrowserSharing(browser, {
        serial: count > 0 ? "serial" : null,
      });
    }
  },

  resetBrowserCount(browser) {
    this._activePortCounts.delete(browser);
  },
};

let _resolveDelayedStartup;
var delayedStartupPromise = new Promise(resolve => {
  _resolveDelayedStartup = resolve;
});

var gBrowserInit = {
  delayedStartupFinished: false,
  domContentLoaded: false,

  _tabToAdopt: undefined,
  _firstContentWindowPaintDeferred: Promise.withResolvers(),
  idleTasksFinished: Promise.withResolvers(),

  _setupFirstContentWindowPaintPromise() {
    let lastTransactionId = window.windowUtils.lastTransactionId;
    let layerTreeListener = () => {
      if (this.getTabToAdopt()) {
        // Need to wait until we finish adopting the tab, or we might end
        // up focusing the initial browser and then losing focus when it
        // gets swapped out for the tab to adopt.
        return;
      }
      removeEventListener("MozLayerTreeReady", layerTreeListener);
      let listener = e => {
        if (e.transactionId > lastTransactionId) {
          window.removeEventListener("MozAfterPaint", listener);
          this._firstContentWindowPaintDeferred.resolve();
        }
      };
      addEventListener("MozAfterPaint", listener);
    };
    addEventListener("MozLayerTreeReady", layerTreeListener);
  },

  getTabToAdopt() {
    if (this._tabToAdopt !== undefined) {
      return this._tabToAdopt;
    }

    if (window.arguments && window.XULElement.isInstance(window.arguments[0])) {
      this._tabToAdopt = window.arguments[0];

      // Clear the reference of the tab being adopted from the arguments.
      window.arguments[0] = null;
    } else {
      // There was no tab to adopt in the arguments, set _tabToAdopt to null
      // to avoid checking it again.
      this._tabToAdopt = null;
    }

    return this._tabToAdopt;
  },

  _clearTabToAdopt() {
    this._tabToAdopt = null;
  },

  // Used to check if the new window is still adopting an existing tab as its first tab
  // (e.g. from the WebExtensions internals).
  isAdoptingTab() {
    return !!this.getTabToAdopt();
  },

  onBeforeInitialXULLayout() {
    this._setupFirstContentWindowPaintPromise();

    // Set a sane starting width/height for all resolutions on new profiles.
    if (ChromeUtils.shouldResistFingerprinting("RoundWindowSize", null)) {
      // When the fingerprinting resistance is enabled, making sure that we don't
      // have a maximum window to interfere with generating rounded window dimensions.
      document.documentElement.setAttribute("sizemode", "normal");
    } else if (!document.documentElement.hasAttribute("width")) {
      const TARGET_WIDTH = 1280;
      const TARGET_HEIGHT = 1040;
      let width = Math.min(screen.availWidth * 0.9, TARGET_WIDTH);
      let height = Math.min(screen.availHeight * 0.9, TARGET_HEIGHT);

      document.documentElement.setAttribute("width", width);
      document.documentElement.setAttribute("height", height);

      if (width < TARGET_WIDTH && height < TARGET_HEIGHT) {
        document.documentElement.setAttribute("sizemode", "maximized");
      }
    }
    {
      const toolbarMenubar = document.getElementById("toolbar-menubar");
      const nativeMenubar = Services.appinfo.nativeMenubar;
      toolbarMenubar.collapsed = nativeMenubar;
      if (nativeMenubar) {
        toolbarMenubar.removeAttribute("autohide");
      }
    }

    BrowserUtils.callModulesFromCategory(
      {
        categoryName:
          "browser-window-before-initial-xul-layout-document-preparation",
        jsGlobal: globalThis,
      },
      window
    );

    // Update the customtitlebar attribute so the window can be sized
    // correctly.
    window.TabBarVisibility.update();

    // CustomTitlebar and Toji's own before-layout hooks.
    BrowserUtils.callModulesFromCategory(
      {
        categoryName: "browser-window-before-initial-xul-layout",
        jsGlobal: globalThis,
      },
      window
    );
  },

  onDOMContentLoaded() {
    // All of this needs setting up before we create the first remote browser.
    window.docShell.treeOwner
      .QueryInterface(Ci.nsIInterfaceRequestor)
      .getInterface(Ci.nsIAppWindow).XULBrowserWindow = window.XULBrowserWindow;
    BrowserUtils.callModulesFromCategory(
      { categoryName: "browser-window-domcontentloaded-before-tabbrowser" },
      window
    );

    // This adds gBrowser to the global scope.
    BrowserUtils.callModulesFromCategory(
      {
        categoryName: "browser-window-domcontentloaded-tabbrowser",
        jsGlobal: globalThis,
      },
      window
    );

    BrowserUtils.callModulesFromCategory(
      {
        categoryName: "browser-window-domcontentloaded",
        jsGlobal: globalThis,
      },
      window
    );

    updatePrintCommands(gPrintEnabled);

    // Setting the focus will cause a style flush, it's preferable to call anything
    // that will modify the DOM from within this function before this call.
    this._setInitialFocus();

    this.domContentLoaded = true;
  },

  onLoad() {
    // The window's private-browsing mark. PrivateBrowsingUI.sys.mjs, which set it,
    // is deleted with the menus it adjusted; the tab model titles the window by it
    // and the shell reads it.
    if (PrivateBrowsingUtils.isWindowPrivate(window)) {
      document.documentElement.setAttribute(
        "privatebrowsingmode",
        PrivateBrowsingUtils.permanentPrivateBrowsing ? "permanent" : "temporary"
      );
    }

    gBrowser.addEventListener("DOMUpdateBlockedPopups", e =>
      PopupAndRedirectBlockerObserver.handleEvent(e)
    );
    gBrowser.addEventListener("DOMUpdateBlockedRedirect", e =>
      PopupAndRedirectBlockerObserver.handleEvent(e)
    );

    window.addEventListener("AppCommand", HandleAppCommandEvent, true);

    if (!gMultiProcessBrowser) {
      // There is a Content:Click message manually sent from content.
      gBrowser.tabpanels.addEventListener("click", contentAreaClick, {
        capture: true,
        mozSystemGroup: true,
      });
    }

    // hook up UI through progress listener
    gBrowser.addProgressListener(window.XULBrowserWindow);
    gBrowser.addTabsProgressListener(window.TabsProgressListener);

    BrowserUtils.callModulesFromCategory(
      {
        categoryName: "browser-window-load-before-sessionstore-init",
        jsGlobal: globalThis,
      },
      window
    );

    // Certain kinds of automigration rely on this notification to complete
    // their tasks BEFORE the browser window is shown. SessionStore uses it to
    // restore tabs into windows AFTER important parts like gMultiProcessBrowser
    // have been initialized.
    Services.obs.notifyObservers(window, "browser-window-before-show");

    BrowserUtils.callModulesFromCategory(
      { categoryName: "browser-window-load", jsGlobal: globalThis },
      window
    );

    // Update UI if browser is under remote control.
    gRemoteControl.updateVisualCue();

    // If we are given a tab to swap in, take care of it before first paint to
    // avoid an about:blank flash.
    let tabToAdopt = this.getTabToAdopt();
    if (tabToAdopt) {
      let evt = new CustomEvent("before-initial-tab-adopted", {
        bubbles: true,
      });
      gBrowser.tabpanels.dispatchEvent(evt);

      // Stop the about:blank load
      gBrowser.stop();

      let swapBrowsers = () => {
        if (gBrowser.isTabGroupLabel(tabToAdopt)) {
          gBrowser.adoptTabGroup(tabToAdopt.group, { elementIndex: 0 });
          gBrowser.removeTab(gBrowser.selectedTab);
        } else if (gBrowser.isTabGroup(tabToAdopt)) {
          // Via gBrowser.replaceGroupWithWindow
          let tempBlankTab = gBrowser.selectedTab;
          gBrowser.adoptTabGroup(tabToAdopt, { tabIndex: 0, selectTab: true });
          gBrowser.removeTab(tempBlankTab);
        } else if (gBrowser.isSplitViewWrapper(tabToAdopt)) {
          let tempBlankTab = gBrowser.selectedTab;
          let splitview = gBrowser.adoptSplitView(tabToAdopt, {
            elementIndex: 0,
            selectTab: true,
          });
          // If tabs are multiselected, add the newly adopted splitview back into the selection
          if (gBrowser.selectedTabs.length > 1) {
            gBrowser.addRangeToMultiSelectedTabs(
              splitview.tabs[0],
              splitview.tabs[splitview.tabs.length - 1]
            );
          }
          gBrowser.removeTab(tempBlankTab);
        } else {
          gBrowser.swapBrowsersAndCloseOther(gBrowser.selectedTab, tabToAdopt);
        }

        // Clear the reference to the tab once its adoption has been completed.
        this._clearTabToAdopt();
      };
      if (
        gBrowser.isTab(tabToAdopt) &&
        !tabToAdopt.linkedBrowser.isRemoteBrowser
      ) {
        swapBrowsers();
      } else {
        // For remote browsers, wait for the paint event, otherwise the tabs
        // are not yet ready and focus gets confused because the browser swaps
        // out while tabs are switching.
        addEventListener("MozAfterPaint", swapBrowsers, { once: true });
      }
    }

    // Wait until chrome is painted before executing code not critical to making the window visible
    this._boundDelayedStartup = this._delayedStartup.bind(this);
    window.addEventListener("MozAfterPaint", this._boundDelayedStartup);

    if (!PrivateBrowsingUtils.enabled) {
      document.getElementById("Tools:PrivateBrowsing").hidden = true;
      // Setting disabled doesn't disable the shortcut, so we just remove
      // the keybinding.
      document.getElementById("key_privatebrowsing").remove();
    }

    if (BrowserUIUtils.quitShortcutDisabled) {
      document.getElementById("key_quitApplication").remove();
      document.getElementById("menu_FileQuitItem").removeAttribute("key");
    }

    if (window.browsingContext.isDocumentPiP) {
      for (const cmd of ["Browser:AddBookmarkAs", "Browser:Reload"]) {
        document.getElementById(cmd).setAttribute("disabled", "true");
      }
    }

    this._loadHandled = true;
  },

  _cancelDelayedStartup() {
    window.removeEventListener("MozAfterPaint", this._boundDelayedStartup);
    this._boundDelayedStartup = null;
  },

  _delayedStartup() {
    this._cancelDelayedStartup();

    this._handleURIToLoad();

    Services.obs.addObserver(gRemoteControl, "devtools-socket");
    Services.obs.addObserver(gRemoteControl, "marionette-listening");
    Services.obs.addObserver(gRemoteControl, "remote-listening");
    Services.obs.addObserver(
      gSessionHistoryObserver,
      "browser:purge-session-history"
    );
    Services.obs.addObserver(
      gStoragePressureObserver,
      "QuotaManager::StoragePressure"
    );
    Services.obs.addObserver(gXPInstallObserver, "addon-install-disabled");
    Services.obs.addObserver(gXPInstallObserver, "addon-install-started");
    Services.obs.addObserver(gXPInstallObserver, "addon-install-blocked");
    Services.obs.addObserver(
      gXPInstallObserver,
      "addon-install-fullscreen-blocked"
    );
    Services.obs.addObserver(
      gXPInstallObserver,
      "addon-install-origin-blocked"
    );
    Services.obs.addObserver(
      gXPInstallObserver,
      "addon-install-policy-blocked"
    );
    Services.obs.addObserver(
      gXPInstallObserver,
      "addon-install-webapi-blocked"
    );
    Services.obs.addObserver(gXPInstallObserver, "addon-install-failed");
    Services.obs.addObserver(gXPInstallObserver, "addon-install-confirmation");
    Services.obs.addObserver(gKeywordURIFixup, "keyword-uri-fixup");
    Services.obs.addObserver(gLocaleChangeObserver, "intl:app-locales-changed");
    Services.obs.addObserver(
      gSerialDeviceObserver,
      "serial-device-state-changed"
    );

    BrowserOffline.init();

    BrowserUtils.callModulesFromCategory(
      {
        categoryName: "browser-window-delayed-startup",
        profilerMarker: "delayed-startup-task",
      },
      window
    );

    // Initialize the full zoom setting.
    // We do this before the session restore service gets initialized so we can
    // apply full zoom settings to tabs restored by the session restore service.
    FullZoom.init();

    // BiDi UI
    gBidiUI = isBidiEnabled();
    if (gBidiUI) {
      document.getElementById("documentDirection-separator").hidden = false;
      document.getElementById("documentDirection-swap").hidden = false;
      document.getElementById("textfieldDirection-separator").hidden = false;
      document.getElementById("textfieldDirection-swap").hidden = false;
    }

    FullScreen.init();

    let wasMinimized = window.windowState == window.STATE_MINIMIZED;
    window.addEventListener("sizemodechange", () => {
      let isMinimized = window.windowState == window.STATE_MINIMIZED;
      if (wasMinimized != isMinimized) {
        wasMinimized = isMinimized;
        UpdatePopupNotificationsVisibility();
      }
    });

    SessionStore.promiseInitialized.then(() => {
      // Bail out if the window has been closed in the meantime.
      if (window.closed) {
        return;
      }

      // Enable the Restore Last Session command if needed
      gRestoreLastSessionObserver.init();
    });

    if (Services.policies.status === Services.policies.ACTIVE) {
      if (!Services.policies.isAllowed("filepickers")) {
        let savePageCommand = document.getElementById("Browser:SavePage");
        let openFileCommand = document.getElementById("Browser:OpenFile");

        savePageCommand.setAttribute("disabled", "true");
        openFileCommand.setAttribute("disabled", "true");

        document.addEventListener("FilePickerBlocked", function (event) {
          let browser = event.target;

          let notificationBox = browser
            .getTabBrowser()
            ?.getNotificationBox(browser);

          // Prevent duplicate notifications
          if (
            notificationBox &&
            !notificationBox.getNotificationWithValue("filepicker-blocked")
          ) {
            notificationBox.appendNotification("filepicker-blocked", {
              label: {
                "l10n-id": "filepicker-blocked-infobar",
              },
              priority: notificationBox.PRIORITY_INFO_LOW,
            });
          }
        });
      }
    }

    SessionStore.promiseAllWindowsRestored.then(() => {
      this._schedulePerWindowIdleTasks();
      document.documentElement.setAttribute("sessionrestored", "true");
    });

    this.delayedStartupFinished = true;
    _resolveDelayedStartup();
    Services.obs.notifyObservers(window, "browser-delayed-startup-finished");
    // We've announced that delayed startup has finished. Do not add code past this point.
  },

  /**
   * Resolved on the first MozLayerTreeReady and next MozAfterPaint in the
   * parent process.
   */
  get firstContentWindowPaintPromise() {
    return this._firstContentWindowPaintDeferred.promise;
  },

  _setInitialFocus() {
    let initiallyFocusedElement = document.commandDispatcher.focusedElement;

    this._callWithURIToLoad(uriToLoad => {
      if (
        isBlankPageURL(uriToLoad) ||
        uriToLoad == "about:privatebrowsing" ||
        this.getTabToAdopt()?.isEmpty
      ) {
        // The shell's omnibox takes the keys (TojiShell redirects gURLBar.select).
        gURLBar.select();
        return;
      }

      // If the initial browser is remote, in order to optimize for first paint,
      // we'll defer switching focus to that browser until it has painted.
      // Otherwise use a regular promise to guarantee that mutationobserver
      // microtasks that could affect focusability have run.
      let promise = gBrowser.selectedBrowser.isRemoteBrowser
        ? this.firstContentWindowPaintPromise
        : Promise.resolve();

      promise.then(() => {
        // If focus didn't move while we were waiting, we're okay to move to
        // the browser.
        if (
          document.commandDispatcher.focusedElement == initiallyFocusedElement
        ) {
          gBrowser.selectedBrowser.focus();
        }
      });
    });
  },

  _handleURIToLoad() {
    this._callWithURIToLoad(uriToLoad => {
      if (!uriToLoad) {
        // We don't check whether window.arguments[5] (userContextId) is set
        // because tabbrowser.js takes care of that for the initial tab.
        return;
      }

      // We don't check if uriToLoad is a XULElement because this case has
      // already been handled before first paint, and the argument cleared.
      if (Array.isArray(uriToLoad)) {
        // This function throws for certain malformed URIs, so use exception handling
        // so that we don't disrupt startup
        try {
          gBrowser.loadTabs(uriToLoad, {
            inBackground: false,
            replace: true,
            // See below for the semantics of window.arguments. Only the minimum is supported.
            userContextId: window.arguments[5],
            triggeringPrincipal:
              window.arguments[8] ||
              Services.scriptSecurityManager.getSystemPrincipal(),
            allowInheritPrincipal: window.arguments[9],
            policyContainer: window.arguments[10],
            fromExternal: true,
          });
        } catch (e) {}
      } else if (window.arguments.length >= 3) {
        // window.arguments[1]: extraOptions (nsIPropertyBag)
        //                 [2]: referrerInfo (nsIReferrerInfo)
        //                 [3]: postData (nsIInputStream)
        //                 [4]: allowThirdPartyFixup (bool)
        //                 [5]: userContextId (int)
        //                 [6]: originPrincipal (nsIPrincipal)
        //                 [7]: originStoragePrincipal (nsIPrincipal)
        //                 [8]: triggeringPrincipal (nsIPrincipal)
        //                 [9]: allowInheritPrincipal (bool)
        //                 [10]: policyContainer (nsIPolicyContainer)
        //                 [11]: nsOpenWindowInfo
        let userContextId =
          window.arguments[5] != undefined
            ? window.arguments[5]
            : Ci.nsIScriptSecurityManager.DEFAULT_USER_CONTEXT_ID;

        let hasValidUserGestureActivation = undefined;
        let textDirectiveUserActivation = undefined;
        let fromExternal = undefined;
        let globalHistoryOptions = undefined;
        let triggeringRemoteType = undefined;
        let forceAllowDataURI = false;
        let schemelessInput = Ci.nsILoadInfo.SchemelessInputTypeUnset;
        if (window.arguments[1]) {
          if (!(window.arguments[1] instanceof Ci.nsIPropertyBag2)) {
            throw new Error(
              "window.arguments[1] must be null or Ci.nsIPropertyBag2!"
            );
          }

          let extraOptions = window.arguments[1];
          if (extraOptions.hasKey("hasValidUserGestureActivation")) {
            hasValidUserGestureActivation = extraOptions.getPropertyAsBool(
              "hasValidUserGestureActivation"
            );
          }
          if (extraOptions.hasKey("textDirectiveUserActivation")) {
            textDirectiveUserActivation = extraOptions.getPropertyAsBool(
              "textDirectiveUserActivation"
            );
          }
          if (extraOptions.hasKey("fromExternal")) {
            fromExternal = extraOptions.getPropertyAsBool("fromExternal");
          }
          if (extraOptions.hasKey("triggeringSponsoredURL")) {
            globalHistoryOptions = {
              triggeringSponsoredURL: extraOptions.getPropertyAsACString(
                "triggeringSponsoredURL"
              ),
            };
            if (extraOptions.hasKey("triggeringSponsoredURLVisitTimeMS")) {
              globalHistoryOptions.triggeringSponsoredURLVisitTimeMS =
                extraOptions.getPropertyAsUint64(
                  "triggeringSponsoredURLVisitTimeMS"
                );
            }
            if (extraOptions.hasKey("triggeringSource")) {
              globalHistoryOptions.triggeringSource =
                extraOptions.getPropertyAsACString("triggeringSource");
            }
          }
          if (extraOptions.hasKey("triggeringRemoteType")) {
            triggeringRemoteType = extraOptions.getPropertyAsACString(
              "triggeringRemoteType"
            );
          }
          if (extraOptions.hasKey("forceAllowDataURI")) {
            forceAllowDataURI =
              extraOptions.getPropertyAsBool("forceAllowDataURI");
          }
          if (extraOptions.hasKey("schemelessInput")) {
            schemelessInput =
              extraOptions.getPropertyAsUint32("schemelessInput");
          }
        }

        try {
          openLinkIn(uriToLoad, "current", {
            referrerInfo: window.arguments[2] || null,
            postData: window.arguments[3] || null,
            allowThirdPartyFixup: window.arguments[4] || false,
            userContextId,
            // pass the origin principal (if any) and force its use to create
            // an initial about:blank viewer if present:
            originPrincipal: window.arguments[6],
            originStoragePrincipal: window.arguments[7],
            triggeringPrincipal: window.arguments[8],
            // TODO fix allowInheritPrincipal to default to false.
            // Default to true unless explicitly set to false because of bug 1475201.
            allowInheritPrincipal: window.arguments[9] !== false,
            policyContainer: window.arguments[10],
            forceAboutBlankViewerInCurrent: !!window.arguments[6],
            forceAllowDataURI,
            hasValidUserGestureActivation,
            textDirectiveUserActivation,
            fromExternal,
            globalHistoryOptions,
            triggeringRemoteType,
            schemelessInput,
          });
        } catch (e) {
          console.error(e);
        }

        window.focus();
      } else {
        // Note: loadOneOrMoreURIs *must not* be called if window.arguments.length >= 3.
        // Such callers expect that window.arguments[0] is handled as a single URI.
        loadOneOrMoreURIs(uriToLoad, {
          newWindowLoad: true,
        });
      }
    });
  },

  /**
   * Tasks that need to run once per window after startup, from idle callbacks
   * once every window has finished being restored by session restore, after the
   * equivalent only-once tasks (from _scheduleStartupIdleTasks in BrowserGlue.sys.mjs).
   */
  _schedulePerWindowIdleTasks() {
    // Bail out if the window has been closed in the meantime.
    if (window.closed) {
      return;
    }

    function scheduleIdleTask(func, options) {
      requestIdleCallback(function idleTaskRunner() {
        if (!window.closed) {
          func();
        }
      }, options);
    }

    scheduleIdleTask(() => {
      // Read prefers-reduced-motion setting
      let reduceMotionQuery = window.matchMedia(
        "(prefers-reduced-motion: reduce)"
      );
      function readSetting() {
        gReduceMotionSetting = reduceMotionQuery.matches;
      }
      reduceMotionQuery.addListener(readSetting);
      readSetting();
    });

    scheduleIdleTask(() => {
      // setup simple gestures support
      gGestureSupport.init(true);

      // setup history swipe animation
      gHistorySwipeAnimation.init();
    });

    scheduleIdleTask(
      () => {
        // Initialize the download manager some time after the app starts so that
        // auto-resume downloads begin (such as after crashing or quitting with
        // active downloads).
        try {
          DownloadsCommon.initializeAllDataLinks();
          ChromeUtils.importESModule(
            "moz-src:///browser/components/downloads/DownloadsTaskbar.sys.mjs"
          )
            .DownloadsTaskbar.registerIndicator(window)
            .catch(ex => {
              console.error(ex);
            });
          if (AppConstants.platform == "macosx") {
            ChromeUtils.importESModule(
              "moz-src:///browser/components/downloads/DownloadsMacFinderProgress.sys.mjs"
            ).DownloadsMacFinderProgress.register();
          }
        } catch (ex) {
          console.error(ex);
        }
      },
      { timeout: 10000 }
    );

    scheduleIdleTask(() => {
      gGfxUtils.init();
    });

    // This should always go last, since the idle tasks (except for the ones with
    // timeouts) should execute in order. Note that this observer notification is
    // not guaranteed to fire, since the window could close before we get here.
    scheduleIdleTask(() => {
      this.idleTasksFinished.resolve();
      Services.obs.notifyObservers(
        window,
        "browser-idle-startup-tasks-finished"
      );
    });
  },

  // Returns the URI(s) to load at startup if it is immediately known, or a
  // promise resolving to the URI to load.
  get uriToLoadPromise() {
    delete this.uriToLoadPromise;
    return (this.uriToLoadPromise = (function () {
      // window.arguments[0]: URI to load (string), or an nsIArray of
      //                      nsISupportsStrings to load, or a xul:tab of
      //                      a tabbrowser, which will be replaced by this
      //                      window (for this case, all other arguments are
      //                      ignored).
      let uri = window.arguments?.[0];
      if (!uri || window.XULElement.isInstance(uri)) {
        return null;
      }

      let defaultArgs = BrowserHandler.defaultArgs;

      // If the given URI is different from the homepage, we want to load it.
      if (uri != defaultArgs) {
        if (uri instanceof Ci.nsIArray) {
          // Transform the nsIArray of nsISupportsString's into a JS Array of
          // JS strings.
          return Array.from(
            uri.enumerate(Ci.nsISupportsString),
            supportStr => supportStr.data
          );
        } else if (uri instanceof Ci.nsISupportsString) {
          return uri.data;
        }
        return uri;
      }

      // The URI appears to be the the homepage. We want to load it only if
      // session restore isn't about to override the homepage.
      let willOverride = SessionStartup.willOverrideHomepage;
      if (typeof willOverride == "boolean") {
        return willOverride ? null : uri;
      }
      return willOverride.then(willOverrideHomepage =>
        willOverrideHomepage ? null : uri
      );
    })());
  },

  // Calls the given callback with the URI to load at startup.
  // Synchronously if possible, or after uriToLoadPromise resolves otherwise.
  _callWithURIToLoad(callback) {
    let uriToLoad = this.uriToLoadPromise;
    if (uriToLoad && uriToLoad.then) {
      uriToLoad.then(callback);
    } else {
      callback(uriToLoad);
    }
  },

  onUnload() {
    BrowserUtils.callModulesFromCategory(
      { categoryName: "browser-window-unload-begin", jsGlobal: globalThis },
      window
    );

    // In certain scenarios it's possible for unload to be fired before onload,
    // (e.g. if the window is being closed after browser.js loads but before the
    // load completes). In that case, there's nothing to do here.
    if (!this._loadHandled) {
      return;
    }

    gGestureSupport.init(false);

    gHistorySwipeAnimation.uninit();

    FullScreen.uninit();

    try {
      gBrowser.removeProgressListener(window.XULBrowserWindow);
      gBrowser.removeTabsProgressListener(window.TabsProgressListener);
    } catch (ex) {}

    BrowserUtils.callModulesFromCategory(
      { categoryName: "browser-window-unload", jsGlobal: globalThis },
      window
    );

    // Now either cancel delayedStartup, or clean up the services initialized from
    // it.
    if (this._boundDelayedStartup) {
      this._cancelDelayedStartup();
    } else {
      FullZoom.destroy();

      Services.obs.removeObserver(gRemoteControl, "devtools-socket");
      Services.obs.removeObserver(gRemoteControl, "marionette-listening");
      Services.obs.removeObserver(gRemoteControl, "remote-listening");
      Services.obs.removeObserver(
        gSessionHistoryObserver,
        "browser:purge-session-history"
      );
      Services.obs.removeObserver(
        gStoragePressureObserver,
        "QuotaManager::StoragePressure"
      );
      Services.obs.removeObserver(gXPInstallObserver, "addon-install-disabled");
      Services.obs.removeObserver(gXPInstallObserver, "addon-install-started");
      Services.obs.removeObserver(gXPInstallObserver, "addon-install-blocked");
      Services.obs.removeObserver(
        gXPInstallObserver,
        "addon-install-fullscreen-blocked"
      );
      Services.obs.removeObserver(
        gXPInstallObserver,
        "addon-install-origin-blocked"
      );
      Services.obs.removeObserver(
        gXPInstallObserver,
        "addon-install-policy-blocked"
      );
      Services.obs.removeObserver(
        gXPInstallObserver,
        "addon-install-webapi-blocked"
      );
      Services.obs.removeObserver(gXPInstallObserver, "addon-install-failed");
      Services.obs.removeObserver(
        gXPInstallObserver,
        "addon-install-confirmation"
      );
      Services.obs.removeObserver(gKeywordURIFixup, "keyword-uri-fixup");
      Services.obs.removeObserver(
        gLocaleChangeObserver,
        "intl:app-locales-changed"
      );
      Services.obs.removeObserver(
        gSerialDeviceObserver,
        "serial-device-state-changed"
      );

      BrowserOffline.uninit();
    }

    BrowserUtils.callModulesFromCategory(
      {
        categoryName: "browser-window-unload-tabbrowser",
        jsGlobal: globalThis,
      },
      window
    );
    window.XULBrowserWindow = null;
    window.docShell.treeOwner
      .QueryInterface(Ci.nsIInterfaceRequestor)
      .getInterface(Ci.nsIAppWindow).XULBrowserWindow = null;

    BrowserUtils.callModulesFromCategory(
      { categoryName: "browser-window-final-unload", jsGlobal: globalThis },
      window
    );
  },
};
