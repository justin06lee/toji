# Toji on Gecko — decisions, progress, next steps

This is the working log for moving Toji from Electron to its own browser built on
Firefox's engine. A later session should be able to read this top to bottom and
carry on. Newest progress is at the end of **Progress**.

## Why

Every Electron tab was a `<webview>` inside a React page. On 2026-09-12 sites saw a
Chrome 148 user agent with "Chromium"-only client-hint brands, an empty
`window.chrome`, no Widevine, no Touch ID passkeys, and every permission already
granted (Electron auto-approves). The `<webview>` itself caused reload-on-navigation,
resize and focus bugs, and Toji patched each symptom page by page. On Gecko Toji is a
real browser underneath — Firefox's engine, tabs, session, prompts, downloads, printing —
and on top it is the Electron app's own UI, unchanged (see "The shell" below).

Rules that follow (from the brief, kept here so they aren't lost):

- Present honestly as Firefox (standard Gecko UA, no Chrome impersonation).
- Never auto-grant permissions; Firefox's own prompts stay.
- Don't reimplement what Firefox does *as behaviour* (tabs and session, permission
  prompts, downloads, popups and OAuth windows, printing, default-browser handling).
- **Firefox contributes no UI** (the user's decision, 2026-09-13, overriding the brief's
  "extend Firefox's tab strip and URL bar"): every window draws the Electron app's React
  UI — tab strip, address bar, bookmarks bar, sidebar, picker, spotlight, sheets — in
  place of Firefox's chrome, from the same components the Electron app used. gBrowser
  stays the tab model; only its UI is gone. What Firefox still has to draw (a page's
  alert(), a permission request, an infobar) wears Toji's look; native macOS surfaces
  (menu bar, context menu) keep only the Electron app's items.
- Prefer prefs, enterprise policies and chrome JS/CSS overlays over C++ patches.

## Decisions

### Base: Firefox ESR 153 (153.2.0esr)

The brief says "the current ESR, at least 140". On 2026-09-13 Mozilla's product
details list two supported ESRs: 140.15.0esr (`FIREFOX_ESR`) and 153.2.0esr
(`FIREFOX_ESR_NEXT`). 140 leaves support when the overlap ends (around 153.3), about a
month out, so starting on it would force a rebase almost immediately. 153 has native
vertical tabs and tab groups and a year of security backports ahead. Pinned in
`gecko/version.json` with the tarball's SHA-256 from Mozilla's `SHA256SUMS` and the
hg revision (`92c5bf51…` on `mozilla-esr153`).

### Full builds, not artifact builds

The brief asked for artifact builds while no C++ is patched. They don't give Toji its
identity: the stub binary compiles in `application.ini.h`
(`browser/app/ApplicationData.cpp`), so an artifact build runs Mozilla's prebuilt
executable as **Firefox** by **Mozilla** — profile in `~/Library/Application
Support/Firefox`, executable `Contents/MacOS/firefox`, bundle-id-dependent code
compiled for `org.mozilla.firefox`. That breaks "no Firefox name anywhere" and would
share a profile directory with a real Firefox. So `make` does a full build once
(≈2–3 h on an 8 GB M1, then sccache-assisted), and front-end work iterates with
`bun gecko/build.ts faster` (`./mach build faster`: JS, CSS, prefs, jar files — no
compiling). Artifacts for this revision do exist on Taskcluster
(`gecko.v2.mozilla-esr153.shippable.revision.<rev>.firefox.macosx64-aarch64-opt`,
expiring 2027-08) if a throwaway artifact objdir is ever wanted for experiments.

### Repo layout

```
gecko/
  version.json        pinned ESR version, tarball URL, SHA-256, hg revision
  build.ts            download → verify → unpack → patch → overlay → mach build/package/install
  mozconfig           Toji's build options (read via MOZCONFIG; no machine paths)
  patches/*.patch     applied in order with patch -p1 (build-config only so far, no C++)
  overlay/**          copied over the tree: branding, Toji's chrome code, prefs, policies
  scripts/branding.sh regenerates the branding images from assets/icon.png
  .work/              (git-ignored) tarball cache, unpacked tree, objdir, sccache, logs
```

`build.ts` never re-extracts a tree it already unpacked (that would touch every mtime
and force a full rebuild). Patches it applied are remembered in `.work/applied-patches`
and reversed if they change; overlay files are copied only when their bytes differ, and
files removed from the overlay are removed from the tree. `TOJI_GECKO_WORK` moves
`.work` elsewhere; `TOJI_JOBS` overrides the job count (default: one job per ~1.3 GB of
RAM, so 6 on 8 GB).

### Identity

- Branding directory `browser/branding/toji` (overlay): display name **Toji**, icons
  generated from `assets/icon.png` (the Electron app's icon), about dialog on a neutral
  dark ground, a plain dmg background. No Mozilla artwork or wordmarks are copied —
  only the unofficial branding's `dsstore` layout file.
- `--with-app-name=toji`, `--with-app-basename=Toji` → `Toji.app/Contents/MacOS/toji`,
  profile directory `~/Library/Application Support/Toji`. (The Electron app's userData
  is the same directory; Gecko's files — `profiles.ini`, `installs.ini`, `Profiles/` —
  don't collide with Electron's, and phase 8 migrates from it in place.)
- `--with-distribution-id=com.ezzy` + branding `MOZ_MACBUNDLE_ID=toji` → bundle id
  `com.ezzy.toji`.
- Vendor "Toji": `browser/moz.configure` implies `MOZ_APP_VENDOR=Mozilla` and an
  explicit option would conflict with the implication, so patch 0002 changes the
  implied value.
- `MOZ_APP_ID` stays Firefox's GUID so AMO add-ons still consider Toji compatible.
- `MOZ_APP_UA_NAME=Firefox`: without it the UA's product token would become
  `Toji/153.0` and sites would treat Toji as an unknown browser. The UA is the standard
  Gecko string, nothing spoofed.
- Update channel `esr` (it only feeds Balrog's GMP query now; the updater is compiled
  out).

### Build options (gecko/mozconfig)

Release, optimized, no tests, `--disable-crashreporter`, `--disable-updater`,
`--disable-default-browser-agent`, `--enable-eme=widevine`, `MOZ_REQUIRE_SIGNING=1`
(ESR otherwise lets a pref turn add-on signing off), sccache in `.work/sccache`.

Two compile-time guarantees for Tor containers, as Tor Browser builds use:
`--disable-proxy-direct-failover` (Firefox otherwise lets "conservative" requests fall
back from a dead proxy to DIRECT) and `--enable-proxy-bypass-protection` (nothing can
set `bypassProxy` on a channel). Both are `set_define`s in `mozilla-config.h`, so
changing them later recompiles all C++ — decide such options before a first build.

`MOZ_APP_UA_NAME` and `MOZ_APP_VENDOR` are "project flags" that configure only accepts
as implied values, so patch 0002 sets them in `browser/moz.configure` rather than the
mozconfig.

mach trims its terminal output to warnings and errors when it sees a coding agent's
environment variable (`CLAUDECODE`, `CODEX_SANDBOX`, `GEMINI_CLI`, `OPENCODE`), which
hides configure errors; `build.ts` clears them for mach so build logs are complete.

### Stripping Mozilla's services

Two locks, LibreWolf-style:

1. **`toji.cfg`** (autoconfig, installed at `Toji.app/Contents/Resources/toji.cfg`,
   packaged by patch 0003, enabled by `general.config.filename` in the branding prefs).
   `lockPref` for: telemetry and data reporting; studies, Normandy and Nimbus; crash
   report submission; app and system add-on updates; Firefox Accounts, Sync and
   Firefox View; Pocket, sponsored tiles/stories and Firefox Suggest; onboarding,
   what's-new, UI tour, terms-of-use and in-product messaging (ASRouter providers
   nulled); Mozilla VPN / Relay / Focus promos; default-browser checks; Mozilla's own
   AI features (Toji has its own agent); captive-portal and connectivity checks, region
   lookup, DoH rollout, default handler injection. Google Safe Browsing is off by
   default: non-Mozilla builds carry no Safe Browsing API key, so the list fetches
   would only fail.
2. **`distribution/policies.json`** (enterprise policies): DisableTelemetry,
   DisableFirefoxStudies, DisablePocket, DisableFirefoxAccounts, DisableAppUpdate,
   DisableFeedbackCommands, DontCheckDefaultBrowser, SkipTermsOfUse, UserMessaging,
   FirefoxHome, FirefoxSuggest, GenerativeAI, NoDefaultBookmarks, the search engines
   (DuckDuckGo default; Google and Bing from Mozilla's config; Brave and Startpage
   added; Amazon, eBay, Perplexity and Wikipedia removed) and a Help menu entry for
   Toji's GitHub. Every policy name was checked against ESR 153's
   `policies-schema.json`.

**Kept on purpose** (security-critical, per the brief): add-on signing (compiled in),
the add-on blocklist, and certificate revocation — CRLite filters and intermediates —
all delivered through Remote Settings (`firefox.settings.services.mozilla.com` and its
attachment CDN); Widevine through GMP (`aus5.mozilla.org` for the update manifest, then
Google's CDN for the CDM). Those are the Mozilla endpoints a clean profile is expected
to contact; phase 1 verifies nothing else is contacted, with a proxy log.

**Toji behaviour set in `toji.cfg`**: WebRTC never exposes local addresses in any
container (`ice.no_host`, `default_address_only`, obfuscated host candidates);
Firefox's container feature off (`privacy.userContext.enabled` — Toji's containers are
its own, see below); search suggestions off by default; SOCKS remote DNS.

### How to rebase to the next ESR

1. Read Mozilla's product details (`https://product-details.mozilla.org/1.0/firefox_versions.json`)
   for the new ESR, and its `SHA256SUMS` / `mac/en-US/firefox-<v>.json` for the checksum
   and `moz_source_stamp`.
2. Update `gecko/version.json`.
3. Move `gecko/.work/src` aside (or delete it) — `build.ts` refuses to reuse a tree of
   another version — and delete `gecko/.work/obj` (new major = clobber).
4. `bun gecko/build.ts prepare`. A patch that no longer applies fails loudly; regenerate
   it against the new tree (they are small build-config edits).
5. Re-check the overlay against upstream changes: the branding files mirror
   `browser/branding/unofficial` (compare its file list and `jar.mn`); `policies.json`
   names against `browser/components/enterprisepolicies/schemas/policies-schema.json`;
   `toji.cfg` pref names against `browser/app/profile/firefox.js` and
   `modules/libpref/init/StaticPrefList.yaml` (a renamed pref silently stops being locked).
   Toji's chrome modules against the categories in
   `browser/components/BrowserComponents.manifest` and the tabbrowser / urlbar DOM they
   hook.
6. `make`, then run the parity checklist below.

## Design of Toji's layer (phases 2–5)

Everything below lives in `gecko/overlay/browser/toji/` (built into `browser/toji`
by patch 0001) plus pure, Vitest-tested logic in `gecko/lib/*.ts` that `build.ts`
bundles into `resource:///modules/toji/lib/*.sys.mjs`. No C++.

- **Hooks.** `Toji.manifest` registers `TojiStartup.init` on `browser-before-ui-startup`
  and three per-window categories: `browser-window-domcontentloaded-before-tabbrowser`
  (the only point where the first tab's container can still be chosen),
  `browser-window-domcontentloaded` (gBrowser exists) and `browser-window-unload-begin`.
- **Containers** (`TojiContainers`, `gecko/lib/containers.ts`) are Toji's own. The list
  lives in `<profile>/toji-containers.json` with the `userContextId` each container's
  data is kept under — the origin attribute Gecko partitions cookies, storage, caches and
  auth by, which needs no Firefox feature switched on. Toji numbers them itself
  (`assignUserContextIds`: new ones from 10,000, a persisted counter so an id is never
  reused; throwaway identities from 1,000,000) and never touches Firefox's
  `ContextualIdentityService`. Firefox's container feature is locked off
  (`privacy.userContext.enabled` false): its per-tab menus, its containers settings pane
  and the add-on `contextualIdentities` API have nothing to show or change. (Until
  2026-09-13 the list was mirrored onto Firefox identities; containers made then keep
  their ids 1–6, so their data stays put, and the old records are left alone — removing
  one through Firefox would wipe its data.) Loaded synchronously on first use, because
  the proxy filter and the first window need answers before async startup work could
  finish.
- **One window = one container** (`TojiWindows`). A window's container comes from
  `window.arguments[1]` (`toji-container` in the property bag, Toji-opened windows), an
  adopted tab, a popup's opener, `arguments[5]`, the opening window ("Open Link in New
  Window" keeps its container; ⌘N does not), or — for a private window nobody assigned
  (⌘⇧N) — the Private container. Otherwise the window shows the **"Who's browsing?"**
  picker drawn in its own chrome, and loads nothing until a profile is chosen (URLs it
  was asked to open are held and opened after). `gBrowser.addTab` is wrapped per window
  so every tab gets the window's `userContextId`; cross-container tab drags show no-drop
  and `adoptTab` refuses. A window opened with only a URL string gets the full argument
  form (with a system triggering principal), or `openLinkIn` would silently load nothing.
- **Ephemeral containers are private windows** with their `userContextId`
  (`{privateBrowsingId:1, userContextId:N}` is supported by the platform, just not
  exposed in Firefox's UI). That keeps their history, session and storage off disk
  entirely; on top of that the container is wiped with
  `Services.clearData.deleteDataFromOriginAttributesPattern({userContextId})` when its
  last window closes and at every startup. Clear container does the same on demand and
  reloads the container's tabs. A window whose profile is deleted stops its pages and
  asks "Who's browsing?" again, as the Electron app did.
- **Tor** (`TojiTor`, `TojiProxy`, `TojiTorUI`, `gecko/lib/tor.ts`). One managed tor
  (`SocksPort auto IsolateSOCKSAuth`, `ControlPort auto` + `ControlPortWriteToFile`,
  cookie auth, `__OwningControllerProcess` + `TAKEOWNERSHIP` so it dies with the browser)
  or an external tor on 9050/9150 when no binary exists. A channel filter (registered
  first, before any add-on's) keys on `loadInfo.originAttributes.userContextId`: Tor
  containers get SOCKS5 with remote DNS and per-container credentials
  (`toji:<container>` / `<launch nonce>:<generation>`), so tor isolates their circuits —
  on an external tor too. Fail-closed: the filter never throws (a throwing filter keeps
  "direct"), a Tor request waits up to 60 s while tor bootstraps, and otherwise gets a
  SOCKS proxy on 127.0.0.1:1 with no failover. Compile-time and locked-pref guarantees
  are listed under Build options and in `toji.cfg`. **WebRTC** is refused outright in
  Tor containers (a `webrtcUI` peer-connection blocker; tor carries no UDP and Firefox
  can't send ICE through a per-container SOCKS proxy); local IPs are never exposed in any
  container. **Hold-to-Tor** (900 ms on the Go button, in the address bar or on the
  start page) moves the window to a fresh in-memory Tor identity (`userContextId` ≥
  1,000,000, wiped on release); holding again goes back. The Electron app reloaded the
  window's tabs in place; Gecko decides private browsing per window, never per tab
  (`nsFrameLoader.cpp` takes it from the window), and a Tor identity must stay off disk,
  so the window is replaced — opened at the old one's place and size (window features,
  so it never shows elsewhere first), every tab in its place with the one in front still
  in front and the rest lazy until chosen, groups kept, and the old window closed only
  once the new one is up. The shell shows Tor mode from the window's own container
  (`state().container`), since the saved list holds only the profiles. A **.onion**
  address the user went to (typed, or a link they clicked) in a direct window does the
  same; a page can't send the window to Tor by itself, and leaving Tor leaves .onion
  tabs behind as start pages (they would send it straight back). An ephemeral profile
  is wiped only when neither its window nor the Tor window standing in for it is left,
  so Private → Tor → back keeps Private's pages. The status bar under the toolbar shows
  bootstrap progress, or "offline" with Retry, in Tor windows only.
- **Toji's pages** (`TojiPages`, `TojiPage` actor). React builds shipped at
  `chrome://toji/content/pages/*.html`, registered at runtime as `about:settings`,
  `about:welcome`, `about:plans`, `about:start` (the new tab page, set through
  `AboutNewTab.newTabURL`, which private windows honour too). They load in the parent
  process like about:preferences; `window.toji` is a JSWindowActor whose parent refuses
  non-system principals and whose API is an explicit allow-list (`TojiPageAPI`).
  The contract is `apps/renderer/src/lib/bridge.ts`.
- **Agent server** (`TojiAgentServer`). A `bun build --compile` binary in the bundle,
  spawned with `PORT=0`, a per-launch token, `TOJI_DATA_DIR=<profile>/agent-server`,
  `TOJI_PARENT_PID`, and the user's login-shell PATH (so the coding-agent CLIs are found);
  it prints `TOJI_SERVER_READY {"port":N}`, is restarted with backoff, and stops at
  shutdown.
- **Web agent** (`TojiAgent`, `TojiAgent` actor, `gecko/lib/agent.ts`). The Electron
  loop, ported step for step (same notes to the model, timings, retry and free-step
  caps). Screenshots with `WindowGlobalParent.drawSnapshot` — works for background tabs —
  scaled so the long edge is ≤ 1400 px. Input through the privileged primitives Marionette
  and BiDi use (`window.synthesizeMouseEvent`, `windowUtils.sendWheelEvent`,
  `nsITextInputProcessor`): trusted events that count as user activation. File upload with
  `File.createFromFileName` + `mozSetFileArray`, only from the agent server's uploads and
  references folders. The spotlight, the gliding cursor (with click ripple) and the
  breathing tab mark are drawn in the window's chrome; a system-group key listener catches
  the Option tap even while focus is in a page.

- **Vault** (`TojiVault`, `TojiVault` actor, `gecko/lib/vault.ts`). Firefox's password
  manager is locked off (it has no containers). `<profile>/toji-vault.json` holds only
  ciphertext from `OSKeyStore.encrypt` (key in the macOS Keychain as "Toji Encrypted
  Storage"); an undecryptable vault is never overwritten. Fills are exact-origin and
  container-scoped, re-checked in the page (`nodePrincipal.origin`) before the password is
  set with `setUserInput`. Captures arrive from the page's submit/click; the parent takes
  the origin and container from the tab it knows. Autosave waits for the page's next
  login-form report (the Electron rules); a Toji-generated password is stored at once.
  The key button and the save bubble hang off the address bar. The agent gets
  `matches`/`fill` only.
- **Imports** (`TojiImport`, `gecko/lib/imports.ts`). Bookmarks go to Firefox's
  bookmarks: Firefox's migrator where it has one (Chrome, Brave, Edge, Vivaldi, Opera,
  Chromium, Safari), else Toji reads the Chromium `Bookmarks` file (Arc, Dia, Helium) into
  a "From <browser>" folder. Passwords never touch Firefox's password manager (its
  `logins.json` and backups would keep copies): Toji reads `Login Data` with
  `MigrationUtils.getRowsFromDBWithoutLocks`, decrypts with Firefox's
  `ChromeMacOSLoginCrypto` (the Keychain asks only if there is something to decrypt), and
  saves into the vault under the chosen container. HTML bookmarks use
  `BookmarkHTMLUtils.importFromFile`; CSV passwords go into the vault.
- **uBlock Origin** is pinned in `gecko/addons.json` (AMO-signed XPI, version + SHA-256),
  downloaded and verified by `build.ts`, shipped in `distribution/extensions` (installed
  into every new profile) and allowed in private windows by policy. The Settings switch
  enables or disables the add-on.
- **Bug reports** (`TojiBugReport`, `gecko/lib/bugReport.ts`). Same two routes as the
  Electron app (direct with a token or `gh auth token`; GitHub's form otherwise), same
  refs/bug-reports storage, the tray over the form's tab, and attaching by a synthetic drop
  of real `File`s onto GitHub's editor with the file input as fallback. The window still is
  `drawSnapshot` of the chrome window's own WindowGlobal, which stitches in the page:
  no Screen Recording permission. Help › Report a Bug… and ⌥⇧I open `about:report`.
- **AI answer pages** (`TojiAsk`). A `toji:` protocol handler, registered at runtime in
  the parent and (by a process script) in every content process, `DANGEROUS_TO_LOAD` so
  web pages can't link to it; its channel is an HTTP channel to the agent server's stream
  (token included, parent side only) with `originalURI` = `toji://ask?q=…`. The tab is an
  ordinary content process in the window's container and the address bar shows the
  question. Answers are real history entries: Back and a restored session show the saved
  answer. A reload — the shell's button, the tab menu, or ⌘R — asks the model again: a
  one-shot per-browser "fresh" flag the channel reads, never a `fresh=1` in the address
  (which would regenerate on every Back or restore). Sources are the shell's
  (`PageSources`), looked up again on a reload. Plan gating (the Toji plan without a
  subscription → `about:plans?q=`) happens before loading; a "no" is kept a minute. An
  address typed with Shift+Enter or the wand opens, as in the Electron app.

## The shell: Toji's UI in every window

`TojiShell.sys.mjs` (per window, from `TojiWindows.init`) mounts the shell — a React
bundle, `apps/renderer/gecko/shell.tsx` → `GeckoShell.tsx`, built by
`vite.shell.config.ts` into `chrome://toji/content/shell/` — in a shadow root
(`#toji-shell`) covering `browser.xhtml`. The shadow root keeps Tailwind's preflight away
from Firefox's own popups and panels, which live in the same document.

- **Same components.** `App.tsx`'s header, tab strip, address row, tab menu, drag notch,
  agent cursor and layout were split out (`BrowserFrame`, `TopTabStrip`, `AddressRow`,
  `TabContextMenu`, `WindowDragHandle`, `AgentCursor`, `useBookmarksPeek`, `PageSources`);
  the Electron app and the shell both render them, so the two cannot drift apart.
- **The page is a hole.** The shell's viewport reports its box (`setViewport`), and
  `#browser` is laid out exactly there, *under* the shell (toji.css). The shell's frame is
  `pointer-events: none` and transparent; the header, sidebar and overlays take the
  pointer, so the page gets everything the shell doesn't draw. Overlays over a page (the
  loading bar, Toji's error page in place of Firefox's, the bookmarks peek, the vault
  bubble) are the shell's, like the Electron app's were over its `<webview>`.
- **Tabs are gBrowser's.** `window.tojiShell` (contract: `apps/renderer/gecko/shellHost.ts`)
  pushes a snapshot of the tabs on every tab event and top-level location/state change;
  `shellTabs.ts` maps them onto the Electron app's `BrowserTab`, cached per tab so Motion's
  reordering keeps object identity while `moveTabTo` moves the real tabs. A tab with no
  browser yet (restored, or moved by hold-to-Tor, and not chosen since) is described from
  the session without being woken. **Groups** are the window's own, as in the Electron
  app, and kept with the session: the list as a SessionStore window value, each tab's
  group as a tab value, so a duplicated, reopened (⌘⇧T) or restored tab keeps its group,
  a tab a page opens joins its opener's, and a group left empty goes. **Reset context**
  reloads a tab in a throwaway identity of its own (the window's route; a Tor window's
  gets its own circuit), wiped when the tab or window closes. A **popup** a page opens
  (`window.open` with a size, `toolbar.visible` false) is just the page, as the
  Electron app's popups were; a login submitted in it still asks to be saved. `window.toji` is the pages' bridge
  (`TojiPageAPI`), so the shared components that call `bridge()` work unchanged.
- **Firefox's paths into its hidden UI** are redirected: `gURLBar.select/focus` (⌘L, new
  windows) and `_adjustFocusAfterTabSwitch` (a new tab) focus the shell's omnibox;
  `PlacesCommandHook.bookmarkPage` (⌘D) toggles the page on the bookmarks toolbar, which
  the shell's bar shows flattened; `openPreferences` (⌘,) opens about:settings.
- **Modules that drew UI in chrome now tell the shell**: TojiAgent (runs, the pointer,
  the Option tap), TojiVault (key-button matches, the save bubble), TojiBugReport (the
  report sheet and its tray), TojiWindows (the picker is the shell's while the window has
  no container). The Go/Tor button, wand, status bar and profile widget are gone.
- **Window chrome.** `#toji-window-buttons` carries `-moz-window-button-box`, so macOS puts
  the traffic lights where the Electron app had them (checked headed: centres ≈ 20/44/67 pt,
  29 pt down). The header is a `-moz-window-dragging` region (double-click zooms natively);
  the notch is a drag region too (Gecko has no JS window-move API).
- **What Firefox still draws**, in Toji's look (toji.css, `prompts.css` as a user sheet for
  the prompt's own document): tab-modal prompts, infobars (their toolbox stays, floated
  over the page top with its toolbars hidden, since `tab-notification-deck` lives in it),
  and the permission panel, hung from a XUL anchor under the omnibox (`popupnotificationanchor`
  must be a XUL element property — an id string throws in 153). `TojiFirefoxUI` trims the
  menu bar (File/Edit/View/Window/Help as in Electron), the page context menu (Electron's
  items; uBlock's entry hidden; Print… added), and shortcuts that open Firefox panels
  (emptied, not removed — Firefox code looks some up), and sets prefs that keep Firefox's
  panels shut (downloads → Save dialog, no status bubble, no close-tab warnings, system
  print dialog).
- **Gotchas.** In the chrome document `rem` is the system UI font (11px), so the build
  converts rem to px; `@property` and `@font-face` only work in document sheets, so the
  build hoists `@property` into `shell-global.css` and toji.css declares Poppins; the start
  page no longer autofocuses its search box (content focus would take the keys from the
  omnibox); Firefox's default bookmarks-bar pref is `newtab`, read as pinned.

`gecko/test/shell.ts` drives it headless with real input — `win.synthesizeMouseEvent`
through the window's own hit testing and `nsITextInputProcessor` keys (Marionette's
element commands are content-only) — 32 checks. `gecko/test/experience.ts` checks the
Electron app's experience on top: containers, the zero-Firefox-UI audit, hold-to-Tor,
groups, Reset context, the agent's limits, the start page, the sidebar peek, popups.

## Firefox contributes nothing: how its UI is stripped

The goal (the user's, 2026-09-13): a Firefox with no UI of its own at all — only the
engine and what the open pages need. Two ways were weighed, with the ESR 153 source:

1. **A window of Toji's own instead of `browser.xhtml`** (no `browser.js`, no tabbrowser).
   The chrome URL is compiled in (`BROWSER_CHROME_URL`, `browser/moz.configure:20`; no
   pref), and Firefox assumes every `navigator:browser` window has a tabbrowser
   `gBrowser`: 111 references in 58 files under `browser/`, 1,267 uses of `gBrowser`
   outside tabbrowser. SessionStore, prompts (`getTabDialogBox`), printing, permission
   prompts (`PopupNotifications` throws without a tabbrowser), `window.open`
   (`ContentParent` forces a new window without a `browserDOMWindow`), crash handling,
   Picture-in-Picture and the WebExtension tab/window trackers — which uBlock Origin's
   `webRequest` needs for tab ids — all run through it. Estimated 5,000–10,000 lines to
   reimplement, each a place for the Electron era's bugs to come back, and a rebase
   hazard every ESR. **Not taken.**
2. **Keep `browser.xhtml` and gBrowser as the engine's tab model; make sure nothing of
   Firefox's is ever drawn.** Taken. Its toolbars, tab strip, sidebar and panels are
   `display: none` (toji.css) — no frames, no layout, no painting; deleting the markup
   would change nothing on screen and would need stubs for every script that touches it.
   What could still *appear* is handled one by one:
   - **Features with a UI of their own are off** (`TojiFirefoxUI`, default prefs):
     screenshots, reader view, Firefox's AI chat and link preview, its tab groups and
     smart window, translations, the DRM bar, the WebRTC indicator window, form history
     and address/card autofill, find-as-you-type and quick find ("/"), the full-screen and
     pointer-lock toasts and the fade, the crash "Restore Session" page (the session
     comes back by itself), downloads panel, status bubble, close/quit warnings, hover
     previews, the sidebar.
   - **Firefox's pages for what Toji does itself are Toji's**: about:preferences,
     about:logins and about:protections serve Settings; about:home, about:newtab,
     about:privatebrowsing, about:firefoxview and about:welcomeback serve the start page —
     under Firefox's names, registered like Toji's own pages (`TojiPages`), so no load is
     redirected. (A redirect on load was tried first: stopping a new private window's
     first page could stop whatever the user had started loading meanwhile — `phase2.ts`
     caught it.)
   - **What a page needs stays, in Toji's look**: a page's alert/confirm/prompt and
     leave-page prompts, permission requests (hung from the shell's address bar — a
     doorhanger with no visible anchor would open at the window's corner), `<select>`
     and date pickers, the blocked-popup and slow-script bars, the right-click menu
     (trimmed to the Electron app's items), macOS's own print, save and file dialogs.
   - **Still Firefox's**: Picture-in-Picture's hover toggle and player window (kept: it
     is the Electron app's hover PiP button's counterpart), about:addons (Welcome's
     "Browse add-ons"; Toji's Settings has no extensions page yet), and the developer
     tools and developer pages (about:config, about:support, devtools), which no Toji UI
     leads to.
   `experience.ts` walks the whole window after a page loads and fails if any element
   outside the shell and the pages paints anything with a box on screen.

## Phases

| # | Phase | Branch | State |
|---|---|---|---|
| 0 | Prerequisites and decisions | `chore/gecko-prereqs` | done (tag `chore-gecko-prereqs`) |
| 1 | Stripped, branded browser that `make` builds, installs, launches | `feat/gecko-browser` | done (tag `feat-gecko-browser`) |
| 2 | Containers, one window = one profile, picker, ephemeral wipe, clear | `feat/gecko-containers` | done (`gecko/test/phase2.ts`; tag `feat-gecko-containers`) |
| 3 | Tor per container, kill switch, onion routing, Tor UI, `make tor-check` | `feat/gecko-containers` | done in the browser (`gecko/test/tor-browser.ts`; tag `feat-gecko-containers`); Tor UI not yet checked |
| 4 | Styling and extras on native widgets; Settings, Welcome, Plans | `feat/gecko-containers` | pages done (`gecko/test/phase4.ts`; tag `feat-gecko-containers`); toolbar styling and extras not yet checked |
| 5 | Agent server as compiled sidecar; AI pages; web agent; spotlight | `feat/gecko-agent` | done (`gecko/test/phase5.ts`, `--live` for the model-backed checks; tag `feat-gecko-agent`) |
| 6 | Passwords, imports, uBlock Origin | `feat/gecko-vault`, `test/gecko-vault` | done — uBlock Origin and imports (`gecko/test/phase6.ts`); the vault (`gecko/test/phase8.ts`) |
| 7 | Bug reports, shortcuts, default browser, links from other apps | `feat/gecko-vault` | done (`gecko/test/phase7.ts`; tag `feat-gecko-reports`) — filing a real issue and setting the system default browser not exercised |
| 8 | Data migration, retire Electron | `test/gecko-vault` | migration done (`gecko/test/phase8.ts`; tag `feat-gecko-migration`); the Electron build targets still to retire |

## Parity checklist

State per item: — not started · WIP · works · works differently · dropped (with why).

| Area | Item | State |
|---|---|---|
| Profiles | Personal, Work, Shopping, Private, Onion, custom; colours, avatars, ephemeral wipe, clear | works — Toji-numbered containers with Firefox's container feature off (`experience.ts`); picker, one window = one container, Private window, isolation, wipe on close and Clear (`phase2.ts`); a deleted profile's windows go back to the picker. Custom colours and avatars not separately checked |
| Tor | managed/external tor, bootstrap UI, fail-closed, per-container circuits, NEWNYM, .onion auto-route, hold-to-Tor | works differently — hold-to-Tor replaces the window in place (Gecko is private per window) with its tabs, tab in front and groups, and shows Tor mode; holding again comes back and wipes the identity (`experience.ts`); the start page's Go button holds too; only a user's .onion navigation switches. Managed tor, fail-closed, per-container circuits and .onion verified (`tor-browser.ts`); external tor, bootstrap UI and NEWNYM not yet checked |
| Passwords | encrypted, container-scoped, exact-origin fill, save bubble, autosave, generator, CSV + browser import, agent-safe | WIP — encrypted (OSKeyStore; only ciphertext on disk), container-scoped, exact-origin fill (`phase8.ts`); the Electron vault moves in; save bubble, autosave, generator and CSV import not yet checked |
| Agent | screenshot loop, spotlight, Option tap, cursor, tab marks, step limit, dropped files, reference docs, memory/librarian, research sub-agent | WIP — a run presses a button on a page end to end (`phase5.ts --live`); the agent never drives Toji's own pages (`experience.ts`); Stop aborts the model call at once and a goal typed meanwhile starts after; a driven background tab stays awake. Dropped files, reference docs, memory/librarian and the step limit not yet checked |
| Agent backends | yagami CLIs, Cerebras, OpenAI-compatible, Toji plan (billing not wired) | — |
| AI answer pages | Shift+Enter / wand, streamed with sources, cached, follows theme | works — a question streams back with its sources under `toji://ask?q=…` (`phase5.ts --live`); reload (button, menu, ⌘R) asks again without a `fresh` in the address; an address with Shift+Enter opens (`experience.ts`); the question stays in the omnibox on the plans page |
| Omnibox | engine choice, long-URL fade, star, vault fill, Go/Tor button | works — the Electron app's AddressRow in the shell; typing and Enter load, Shift+Enter/wand ask, ⌘L focuses it, a new tab focuses it (`shell.ts`) |
| Bookmarks | ⌘D, pinned or hover bar, imports | works — the shell's bar over the bookmarks toolbar (flattened); star and ⌘D toggle; hover mode comes down from the page's top edge (`TojiEdge` actor) |
| Tabs | top/side, groups with colours, drag reorder, long-press new-tab menu, background tabs, audio/mute, agent indicator, open/close animation | works — the Electron app's strip and sidebar over gBrowser; drag reorder moves the real tabs (and keeps the pointer over the page); groups kept with the session (a duplicate keeps its group, `experience.ts`); Reset context in a throwaway identity (`experience.ts`); the sidebar peek (`experience.ts`); popups are just the page (`experience.ts`) |
| Ad blocking | uBlock Origin, on by default | works — the pinned 1.74.0, active in new profiles and private windows; blocks a tracker a page requests; the Settings switch turns it off and on (`phase6.ts`) |
| Pages | Settings, Welcome, Plans | WIP — Settings, Welcome, Plans, start page and bug report render with `window.toji`; web pages get no bridge; ⌘T opens about:start. Plans shows no tiers yet (they come from the agent server, phase 5) |
| System | default browser, cold-start links from other apps | WIP — a link handed over at launch waits for "Who's browsing?" and opens in the container chosen; an external link lands in its window's container; `isDefaultBrowser()` answers (it reads true while the Electron app shares the bundle id). Setting the default browser not exercised |
| Theme | toggle drives prefers-color-scheme | works — the shell's toggle; pages and Firefox's prompts follow |
| Bug reports | written + images + screenshot; 15 s clip if a Gecko capture path holds up | WIP — ⌥⇧I and Help › Report a Bug… open the sheet beside the tab with the page and window size; the window still is a PNG (no Screen Recording needed). Filing to GitHub and the 15 s clip not exercised |
| Imports | Chrome family incl. Helium, Arc, Dia; Safari; files | WIP — Helium bookmarks (Toji's own Chromium reader, also used for Arc and Dia) import into a "From Helium (<profile>)" folder, tested from a fake home (`TOJI_IMPORT_HOME`); Firefox's migrators (Chrome, Brave, Edge…), Safari, password import and the file pickers not yet checked |
| Extensions | Firefox add-ons (not the Chrome Web Store) | — |
| Linux | packages | — |

## Findings from reading the Electron app (inputs to later phases)

- The Electron main process never wiped ephemeral containers; it relied on in-memory
  partitions dying. Gecko must wipe explicitly (`Services.clearData` by
  `userContextId`) when the last window of an ephemeral container closes, and at
  startup.
- The Tor kill switch in `request-gate.cjs` failed open if a check threw. The Gecko
  proxy filter must fail closed.
- Several vault/tor/import IPC handlers had no sender checks. In Gecko they sit behind
  a JSWindowActor that only Toji's own privileged pages can reach.
- Only `press` and `scroll` agent actions went through main (byakugan over CDP);
  click/drag/type were `<webview>.sendInputEvent` from the renderer. All of it moves to
  a chrome module + actors.
- The agent server's research path (Playwright) is not reachable from today's UI; only
  the demo route uses it. Its text extraction reads `innerText` of a detached clone,
  i.e. effectively `textContent` — fetch + a parser reproduces it.
- The agent server's CORS allows only `http(s)://localhost|127.0.0.1` origins and has no
  auth token; Toji's chrome pages will need an allowed origin plus a per-launch token.
- Agent-server bugs noticed on the way (fix when porting): error pages are cached for
  72 h (`index.ts:439`); the 12 MB JSON limit caps uploads at ~9 MB despite a 40 M
  base64 limit.

## Progress

### 2026-09-13 — phase 0

- Machine: Apple M1, 8 cores, 8 GB RAM, macOS 26.6.2, Xcode 26.5 (SDK 26.5 — the same
  SDK Mozilla's CI used for 153.2), Rust 1.97.1, Python 3.14. T7 is APFS with 742 GB
  free; the internal disk has 36 GB free (`~/.mozbuild` toolchains ≈ 3 GB live there).
- `./mach bootstrap` for desktop Firefox succeeded.
- Wrote `gecko/` (version pin, build script, mozconfig, three build-config patches,
  branding overlay, `toji.cfg`, `policies.json`) and started the first full build.
- Phase 0 merged and pushed (tag `chore-gecko-prereqs`).

### 2026-09-13 — phase 1 under way, phases 2–7 written ahead of the build

- First full build (run 3, log `gecko/.work/logs/build-3.log`) started 02:05 with the
  phase-1 overlay only (branding, `toji.cfg`, `policies.json`). About 60 min in it was
  compiling `gfx/`; the machine swaps up to ~5 GB but keeps going at 6 jobs.
- While it builds, the Toji layer for phases 2–7 was written in
  `gecko/overlay/browser/toji/` (modules, actors, `toji.css`, `jar.mn`, `Toji.manifest`,
  `moz.build`) and `gecko/lib/*.ts` (tested). **None of the chrome modules has run in a
  real build yet**; they only pass `node --check`. They are deliberately still
  uncommitted on `feat/gecko-browser` (a backup tarball is in `gecko/.work/backups/`)
  so phase 1 can be verified and merged on the clean build first; the next commit series
  moves them onto per-phase branches as each one verifies.
- Merged into `feat/gecko-browser` from worktree agents:
  - agent server as a compiled sidecar (fetch + Readability research, no Playwright;
    `TOJI_SERVER_READY {"port":N}`; `TOJI_SERVER_TOKEN`; Host check; `TOJI_PARENT_PID`;
    64 MB binary without the Agent SDK's platform binary);
  - Toji's pages as a multi-page Vite build (`bun run build:pages`,
    `vite.gecko.config.ts`, `apps/renderer/gecko/`) on the `window.toji` bridge.
- In flight: a worktree agent porting the bug report sheet as `report.html` and adapting
  Welcome's import to Gecko's count-based results.
- `make tor-check`'s daemon half (`scripts/tor-live-check.ts`) passes against a real tor:
  two containers on different circuits and different exit relays, per-container new
  circuits, `.onion`, NEWNYM. The in-browser half is `gecko/test/tor-browser.ts`.

**Phase 1 results (build 3, packaged 05:21):**
- Full build: 3 h 14 min on the 8 GB M1 at 6 jobs (swap peaked ~6 GB); `mach package`
  20 s. `Toji.app` 283 MB: `CFBundleName` Toji, `CFBundleIdentifier` com.ezzy.toji,
  executable `toji`, `application.ini` Vendor/Name Toji, `RemotingName=toji-esr`.
- The packager only ships `distribution/*` for `BUILT_BY_MOZILLA` builds, so
  `policies.json` was missing from the first package. Patch 0003 now packages
  `distribution/*` unconditionally (patch 0004, phase 5, adds the agent server).
- Probe (`gecko/test/probe.html`): UA `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15;
  rv:153.0) Gecko/20100101 Firefox/153.0`, `navigator.userAgentData` absent,
  `window.chrome` undefined; geolocation, notifications, camera, microphone,
  persistent-storage and push all `prompt`; Widevine and ClearKey available (the GMP
  service serves Widevine to a non-Mozilla build; the CDM came through Google's component
  updater).
- Clean-profile network, 180 s idle: Remote Settings (+ attachments CDN, content-signature
  chain), aus5 (GMP), Google's updater (Widevine), OpenH264 — all intended. Also seen and
  fixed: the policy-added Brave/Startpage engines fetched their favicons (now inline
  data: icons) and Web Push opened a socket to push.services.mozilla.com (now
  `dom.push.connection.enabled` false by default; the Electron app had no web push).
- Firefox 153's Marionette refuses chrome-context scripts unless the browser starts with
  `-remote-allow-system-access`; the test scripts pass it and run headless unless
  `HEADED=1`.

- Sites that broke under Electron, loaded in the built browser with screenshots: Google
  sign-in (the identifier page, no "browser not supported" wall), Instagram Reels (video
  playing), Zoho Mail, Netflix; and a Widevine-encrypted DASH stream plays (keys
  negotiated, `currentTime` advancing). The geolocation request opens Firefox's own
  prompt.
- `gecko/test/phase1.ts` exits non-zero on any of: an unexpected host at idle, exposed
  client hints or `window.chrome`, a pre-granted permission, no prompt, a non-Toji
  identity, unlocked prefs, inactive policies, an unsupported-browser wall, or Widevine
  not playing. `make check` runs it with a 60 s idle log.

**Phase 1 is done** (merged to master, tag `feat-gecko-browser`).

### 2026-09-13 — phase 2 verified

- Build 4 (the phase 2–7 layer on the phase-1 objdir): 42 s, nothing recompiled;
  `bun gecko/build.ts faster` + `package` (≈30 s together) after each chrome-JS fix.
- First run of Toji's chrome code. Two bugs:
  - The `gecko/lib` bundles export plain functions, but the chrome modules imported
    them with `defineESModuleGetters`, which binds one export *by name* — so
    `lazy.ContainersLib`, `lazy.TorLib` … were undefined and startup threw. They now
    use `defineLazyGetter` + `importESModule`, which holds the whole module.
  - The picker window still loaded about:home. `updateBookmarkToolbarVisibility()`
    reads and caches `gBrowserInit.uriToLoadPromise` in `onBeforeInitialXULLayout`,
    before the before-tabbrowser hook nulls `window.arguments[0]`; the hook now
    resets the cached value to null too.
- `gecko/test/phase2.ts`: all 12 checks pass — picker shown, nothing loaded until a
  profile is chosen, Work binds the window and every tab (⌘T included), ⌘⇧N gives
  Private, cookies stay per container, closing Private's last window wipes it, Clear
  container empties Work, the five built-ins are stored with Gecko identities.
- Test harness: `Marionette.execAsync` runs an async body (`await` works, a throw
  fails the call); the Clear check moves Work's tab off the cookie page first, since
  a container's tabs reload after a clear.
- The whole Toji layer is now committed on `feat/gecko-containers`. The modules are
  too interlinked to split by phase (TojiStartup and TojiWindows wire up Tor, the
  vault, the agent), so phases 3–7 ride along unverified; the branch merges to master
  once Tor (phase 3) verifies too.

### 2026-09-13 — phases 3 and 4 under way

- **Phase 3 verified** — `gecko/test/tor-browser.ts`, all 7 checks, against a real
  tor: with tor stopped a Tor container's request ends on
  `about:neterror?e=proxyConnectFailure`, never direct; the managed tor bootstraps in
  the browser (~35 s from a cached consensus); two Tor containers exit through tor from
  different relays (204.8.96.103 / 5.255.118.218); a direct container does not use tor;
  DuckDuckGo's .onion loads in the Onion container; each container window holds just
  its one tab. With tor in an error state (an earlier run), every Tor-container load
  still ended on `proxyConnectFailure`.
- Bugs found running the Tor and page code for the first time:
  - **No timers in system modules.** Firefox's shared module global (`SystemGlobal`)
    has `fetch`, `Headers`, `crypto`, `OffscreenCanvas`, `WebSocket`, `URL` … but not
    `setTimeout`/`clearTimeout`/`setInterval`, `createImageBitmap`, `queueMicrotask` or
    `performance` (checked in the running build). Seven Toji modules called timers bare;
    they now import them from `resource://gre/modules/Timer.sys.mjs`, as Firefox's own
    modules do. Code that runs against a window keeps using `win.setTimeout`.
  - **The control connection hung itself up.** It wrote a bare `\r\n` to find out it
    was connected; before authentication tor answers anything but
    PROTOCOLINFO/AUTHENTICATE with `514 Authentication required` and closes the
    connection (and a SOCKS port hangs up on stray bytes, so `probePort` could never
    find an external tor either). Connecting now waits for the transport's
    `STATUS_CONNECTED_TO` (a refused or timed-out connect surfaces as the input
    stream failing); nothing is sent. `isAlive()` is no substitute: right after
    connecting it can report a live socket as dead.
  - **Cookie race.** tor logs "Opened Control listener" before it writes
    `control_auth_cookie`, so reading the cookie at that moment failed; Toji now waits
    for it as it does for the port file. Both listener lines matched the trigger, so
    two attaches raced; it is now once per tor process.
  - **A failed attach left Tor "bootstrapping" forever** (tor at 100 %, Toji waiting for
    a SOCKS port no one would report). Now it stops that tor and reports the reason, so
    `whenReady` answers false and the status bar can say why.
  - **`window.toji.saveContainers(list)`** handed `[list]` to `replaceAll`: every page
    API method receives its arguments as an array. `saveContainers` and
    `clearContainer` now destructure like the rest.
- **Toji's pages were blank.** Their HTML named its assets `./assets/…`, and a
  relative URL can't resolve against the `about:settings` address they are shown
  under. `vite.gecko.config.ts` now writes the HTML's asset URLs as
  `chrome://toji/content/pages/assets/…` (imports and CSS `url()`s inside the bundle
  stay relative, resolving against their own chrome: files).
- **Pages verified** — `gecko/test/phase4.ts`: about:settings, about:welcome,
  about:plans, about:start and about:report render and get `window.toji`;
  `saveContainers(containers())` round-trips; ⌘T opens about:start; an ordinary web
  page has no `window.toji`. Screenshots in `gecko/.work/phase4/`. Two things seen
  there: Plans shows no plan tiers (they come from the agent server, phase 5's to
  verify), and Welcome reports Toji as the default browser because the Electron app
  still shares the bundle id `com.ezzy.toji` (phase 8).
- Test harness: window handles come from Marionette's `NavigableManager` (UUIDs, not
  browserIds); `execAsync` errors carry the message as well as the stack;
  `gecko/test/phase4.ts` (new) covers Toji's pages; `tor-browser.ts` also checks that
  each container window holds exactly its one tab (an earlier run saw extra tabs appear
  after tor started).
- More page fixes, found by new `phase4.ts` checks (now 16):
  - **`Services.search` doesn't exist in Firefox 153** (checked in the running build: of
    every `Services.<name>` Toji uses, it was the only one missing). The search service
    is `SearchService` from `moz-src:///toolkit/components/search/SearchService.sys.mjs`,
    with `SearchService.CHANGE_REASON.USER`. Settings' engine list and engine choice
    were failing on it.
  - **`engine.getIconURL()` is async** in 153; the settings reply carried Promises and
    couldn't be cloned to the page. The icons are awaited first.
  - **Plans and Welcome came up empty** when opened soon after launch: `window.toji
    .server()` waited only 5 s for the sidecar, then the page fell back to no server.
    It now waits up to 30 s (and starts the server if it isn't running). The sidecar
    itself was fine — ready, `/health` 200, plans served.
- Phases 2–4 merged to master (tag `feat-gecko-containers`). The phase 5–7 code is in
  the same layer and loads without startup errors, but none of it is verified yet.

### 2026-09-13 — phase 5 under way

- The agent server sidecar works in the built browser: ready within the page wait,
  `/health` 200, `/api/*` answers 401 without this launch's token, `/api/agents` finds
  Claude Code, Codex, OpenCode and Gemini on this machine. It exits within its 2 s
  parent check after the browser quits.
- **toji: pages never loaded.** A runtime-registered protocol handler
  (`Services.io.registerProtocolHandler`) exists only in the process that registered it
  — nothing passes it to content processes. A content process that doesn't know
  `toji:` gives it the unknown-scheme flags, which include `URI_DOES_NOT_RETURN_DATA`,
  so `nsContentUtils::IsExternalProtocol` says "another app's protocol" and the tab's
  docshell sets the navigation up as an external hand-off. The load started and then
  stalled with no error, no console message and no dialog; the tab stayed
  `about:blank`. (Parent-initiated loads go through the content docshell too, so
  loading from chrome didn't help.)
  Fix, in two parts: `TojiAsk.init` loads a process script
  (`chrome://toji/content/ask-process.js`, via `Services.ppmm.loadProcessScript`) into
  every content process, present and future, which registers `toji:` there with the
  same flags. And that content-side handler has to build channels: with the document
  channel, the parent opens the real channel (`AskProtocol`), then the tab's process
  makes a matching *child* channel for the same address and attaches it to the
  parent's — for the error pages and for the agent server's HTTP stream alike (probed:
  both asked the content handler for a top-level document channel). `channelFor()`
  builds both sides; the content side gets the server's address through
  `Services.ppmm.sharedData` (set and flushed by the parent just before), never the
  token — its child sends no request of its own, and one that did would get a 401.
- **Phase 5's no-model checks pass** — `gecko/test/phase5.ts`, all 7: the server
  starts and answers `/health`, refuses the API without the token, `/api/agents`
  answers; `toji://nothing` shows Toji's error page under its own address;
  `toji://ask?q=` (an empty question — the server answers with its blank page, no
  model call) reaches the agent server and keeps its `toji://ask` address; a web page
  can't navigate to `toji:`; the agent spotlight opens.
- Test harness: every Marionette command now has a deadline (2 min, or an async
  script's own timeout plus 30 s), so a hang fails the check and names the command.
  `gecko/test/phase5.ts` (new) covers the server, `toji:`, and the spotlight; the live
  answer page runs only with `--live`, since it sends a question to the configured
  model. The default agent choice is still "toji" (the Toji plan, billing not wired),
  which sends answers to about:plans; a live check needs a CLI backend chosen.

- **Live answer page verified** (`phase5.ts --live`, a throwaway profile switched to
  the coding CLIs through `PATCH /api/settings`): the question streams back ("The
  capital of France is Paris…") under `toji://ask?q=…`, no token in the address.
- **The web agent's clicks never reached the page.** The run log showed nothing wrong;
  the page's own event log showed not a single mouse event. Two defects:
  - **`ownerGlobal` is gone in Firefox 153** — `Node.webidl` has
    `[ChromeOnly] documentGlobal` instead, and Firefox's own code uses that. Toji read
    `ownerGlobal` in 13 places, all `undefined`: the agent's cursor (every click threw
    before its press), the spotlight's live log (`_render` skips a missing window, so it
    silently never updated), the vault's save bubble and key button, the vault's
    visibility check in pages, a startup handler, and an opener fallback. All now use the
    standard `ownerDocument.defaultView`.
  - **The loop swallowed action errors** (`catch {}`, "the next screenshot shows what
    happened"), so the model was told a click happened and kept retrying. A failed action
    now goes to the run log and the model's history, and its stack to the console.
  The actor's own input was fine throughout: a direct press/release clicked, and Enter
  and Space activate a focused button.

- **Agent run verified** (`phase5.ts --live`): goal "Click the button labeled 'Press
  me'" on a local page; the page logged `mousedown`, `mouseup` and `click` on the
  button and its title turned "Pressed". Phases 2 and 4 rechecked after the
  `ownerGlobal` change: all pass.
- Phase 5 merged to master (tag `feat-gecko-agent`).

### 2026-09-13 — phase 6: uBlock Origin and imports

- `gecko/test/phase6.ts`, all 9 checks, touching neither the user's data nor their
  Keychain: uBlock Origin is the pinned 1.74.0, active in a new profile and allowed in
  private windows; a page's request to a tracker beacon is blocked while one to
  example.com goes through; Settings' switch turns uBlock off (the same request then
  goes out) and back on (blocked again); Helium bookmarks import from a fake home
  (`TOJI_IMPORT_HOME`) into "From Helium (Personal)"; a profile with no `Login Data`
  returns before any Keychain access.
- Two test lessons: uBlock swaps ad *scripts* such as `adsbygoogle.js` for a harmless
  stand-in bundled in the extension, so a request for one "succeeds"; and EasyList
  exempts DoubleClick click-through links, or ads' links would break. The check uses a
  tracker beacon that is blocked outright.
- **Not exercised: the vault.** `OSKeyStore` keeps the vault key in the macOS login
  Keychain ("Toji Encrypted Storage"), and every rebuilt, ad-hoc-signed test app would
  raise a Keychain prompt on the user's screen. Waiting for the user's go-ahead; the
  vault's logic is covered by `gecko/lib/vault.test.ts`.

### 2026-09-13 — phase 7 verified

- `gecko/test/phase7.ts`, all 8 checks, filing nothing and changing no system
  setting: a link given on the command line (as another app hands one over) waits
  while "Who's browsing?" shows and opens in Work once Work is chosen; an external open
  (`browserDOMWindow.openURI(…, OPEN_EXTERNAL)`) into a Work window gets Work's
  userContextId, not the default container; ⌥⇧I and Help › Report a Bug… exist, and the
  shortcut opens `about:report` beside the tab with the page and window size filled
  in; `captureWindow` returns a PNG of the whole window; `isDefaultBrowser()` answers;
  tapping Option opens the agent spotlight.
- Phases 6 (uBlock Origin and imports) and 7 merged to master (tag
  `feat-gecko-reports`).

### 2026-09-13 — phase 8: moving the Electron app's data in

The user gave the go-ahead for the vault test (Keychain prompts included) and for
phase 8. What the Electron app kept, in `~/Library/Application Support/Toji` (the
folder the Gecko profiles now live in too):

- `Local Storage/leveldb/` — the renderer's localStorage: `toji.containers`,
  `toji-theme`, `toji-layout`, `toji-sidebar`, `toji-bookmarks-bar`,
  `toji-search-engine`, `toji-vault-autosave`, `toji.replay`, `toji-onboarded`,
  `toji.agentMaxSteps`, `toji.agentNoLimit`, under the `http://127.0.0.1:8788`
  origin. Small enough that it all sits in the LevelDB write-ahead log.
- `data/` — the agent server's data: `settings.json` (agent choice, models, keys),
  `page-cache.json` (saved answer pages), `bookmarks.json`, `sessions/`.
- `vault.bin` — the vault, Electron `safeStorage` ciphertext (`v10…`) under the
  Keychain item "Toji Safe Storage" / "Toji Key".
- `Partitions/` (site data per container), `Cookies`, caches, `tor/`, `adblock/`.

**`TojiMigrate`** runs once (pref `toji.migration.electron`) at the first start of a
profile in Toji's own Profiles folder — never for test or scratch profiles, unless
`TOJI_MIGRATE_FROM` points one at a copy. It only reads the Electron files:
1. copies the agent server's data (not `bookmarks.json`) into `<profile>/agent-server`
   before the sidecar starts;
2. replays the localStorage log (`gecko/lib/migrate.ts`: a LevelDB log reader with
   CRC-32C checks, and Chromium's localStorage string encodings) and applies the
   containers (`TojiContainers.replaceAll`) and settings (through Settings' own
   `setSetting`, plus the onboarding and agent step-limit prefs);
3. puts the bookmarks on the bookmarks toolbar, skipping addresses already there;
4. once the first window has started, reads the Electron app's safeStorage passphrase
   with macOS's `security find-generic-password` (one Keychain prompt, `security`'s own,
   while the browser keeps running) and decrypts `vault.bin` in `gecko/lib/migrate.ts`
   (Chromium's os_crypt: `v10`, AES-128-CBC, PBKDF2-SHA1 over "saltysalt"), saving the
   entries into Toji's vault. Firefox's `ChromeMacOSLoginCrypto` was the first try: its
   Keychain lookup is synchronous — it runs even when handed a passphrase — so its
   prompt froze the whole browser during startup (`phase8.ts` caught it: Marionette
   couldn't even open its session);
5. writes `<profile>/toji-migration.json` with counts and errors.

**The vault never filled a password.** `TojiVaultChild` refused a fill unless
`document.nodePrincipal.origin` equalled the entry's origin — but in a container that
origin ends in `^userContextId=N`, and every Toji window is a container. It compares
`originNoSuffix` now (still the exact site). `phase8.ts` found it: the login was offered
in its container, and the fill came back refused.

It does not move site data — cookies, sign-ins, site storage: Chromium's and Gecko's
formats don't convert — so sites need signing into again. Compacted LevelDB table files
(`.ldb`) aren't read; the report counts any it skipped. `gecko/test/phase8.ts` runs the
move against a copy of the Electron data in a throwaway profile, checks a second start
moves nothing twice, and checks the vault: offered and filled only on its own site in
its own container, and no username or password in the clear in `toji-vault.json`.

**Verified** — `phase8.ts`, all 11 checks, on a copy of the user's Electron data: 5
containers, 8 settings, 9 bookmarks, the agent server's settings and saved pages, and 9
vault entries moved; a second start moved nothing twice; a saved login was offered and
filled only in its own container (page principal `http://127.0.0.1:…^userContextId=2`),
never in another; `toji-vault.json` holds no username or password in the clear.

**Next:** install over the Electron app (a zip of it is kept in
`~/Library/Application Support/Toji-electron-backup/`), let the first real start move
the data, then retire the Electron build targets.

### 2026-09-13 — Toji's shell replaces Firefox's UI

The user asked for the Electron app's UI, identical, with Firefox contributing no UI at
all. Built as described in "The shell" above, on `feat/gecko-shell`.

- Verified: `gecko/test/shell.ts` 32/32 (headless, real input); phases 2, 4, 5, 6 and 7
  rechecked on the same build (their picker/spotlight/report checks now read the shell);
  headed window captures for the traffic lights. Unit tests 645, typecheck and the
  Electron production build pass.
- Not verified visually: the permission panel (a native popup; a hidden test window
  doesn't paint and macOS has no occlusion pref to turn off) — its anchoring is checked.
  Phase 8 not rerun (it prompts the Keychain); its layout check now reads `toji.layout`.
- Known gaps: ⌘F does nothing (the Electron app had no find bar; Firefox's is hidden);
  Firefox's own Picture-in-Picture toggle and player remain; about:addons (from Welcome's
  "Browse add-ons") is Firefox's page; Reset context is not offered (offered since, see
  the next entry).

### 2026-09-13 — the Electron app's experience, and Firefox stripped of its UI

The user found the experience not yet the Electron app's — AI, hold-to-Tor, containers,
the sidebar — and asked for a Firefox with no UI of its own at all. Four read-only audits
(AI, Tor and containers, tabs and sidebar, the ESR source for stripping) and a headless
walk-through of the built app found, and this round fixed:

- Hold-to-Tor opened a new window elsewhere, dropped start pages and groups, reordered
  the tabs, and the Tor window didn't look like one (the shell looked the temporary
  identity up in the profiles list). A .onion tab bounced the window back into Tor; any
  page could force the switch; Private → Tor wiped Private. See "Tor" above.
- Containers were mirrored onto Firefox identities, visible in about:preferences and to
  add-ons. Now Toji's alone (see "Containers").
- The agent could screenshot and drive Settings (system principal). Stop waited out a
  whole model call and lost a goal typed meanwhile. A background tab it drove was asleep.
- Answer reloads put `fresh=1` into history (paid regeneration on every Back), ⌘R served
  the cached answer, Shift+Enter on an address asked the AI, the start page couldn't
  hold for Tor, and asking right after launch showed nothing for seconds.
- Groups lived in React state: lost on duplicate, ⌘⇧T, restore and hold-to-Tor. Every
  restored tab was woken by the shell reading its history. Reset context was missing;
  popups got the whole tab strip; the tab picked after a close differed; tab drags could
  lose the pointer over the page; the drag notch could stay stuck after a native drag.
- Typing about:settings (or any about: address) searched for it.

`experience.ts` (new, in `make check`) checks it; `shell.ts` still passes 32/32.
