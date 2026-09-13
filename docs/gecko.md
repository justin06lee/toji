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
real browser: Firefox's own tab strip, URL bar, prompts, context menu, downloads, PiP,
printing and error pages, with Toji's features layered on in chrome JS/CSS.

Rules that follow (from the brief, kept here so they aren't lost):

- Present honestly as Firefox (standard Gecko UA, no Chrome impersonation).
- Never auto-grant permissions; Firefox's own prompts stay.
- Don't reimplement what Firefox does (context menu, find bar, downloads, permission
  prompts, error pages — restyle only —, PiP, tab audio/mute, popups and OAuth windows,
  printing, default-browser handling, vertical tabs, tab groups).
- Extend Firefox's tab strip, URL bar, sidebar and bookmarks toolbar with JS/CSS (as
  Zen does); never replace tabbrowser or the urlbar with React.
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
contextual identities on; search suggestions off by default; SOCKS remote DNS.

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

## Phases

| # | Phase | Branch | State |
|---|---|---|---|
| 0 | Prerequisites and decisions | `chore/gecko-prereqs` | in progress |
| 1 | Stripped, branded browser that `make` builds, installs, launches | | |
| 2 | Containers, one window = one profile, picker, ephemeral wipe, clear | | |
| 3 | Tor per container, kill switch, onion routing, Tor UI, `make tor-check` | | |
| 4 | Styling and extras on native widgets; Settings, Welcome, Plans | | |
| 5 | Agent server as compiled sidecar; AI pages; web agent; spotlight | | |
| 6 | Passwords, imports, uBlock Origin | | |
| 7 | Bug reports, shortcuts, default browser, links from other apps | | |
| 8 | Data migration, retire Electron | | |

## Parity checklist

State per item: — not started · WIP · works · works differently · dropped (with why).

| Area | Item | State |
|---|---|---|
| Profiles | Personal, Work, Shopping, Private, Onion, custom; colours, avatars, ephemeral wipe, clear | — |
| Tor | managed/external tor, bootstrap UI, fail-closed, per-container circuits, NEWNYM, .onion auto-route, hold-to-Tor | — |
| Passwords | encrypted, container-scoped, exact-origin fill, save bubble, autosave, generator, CSV + browser import, agent-safe | — |
| Agent | screenshot loop, spotlight, Option tap, cursor, tab marks, step limit, dropped files, reference docs, memory/librarian, research sub-agent | — |
| Agent backends | yagami CLIs, Cerebras, OpenAI-compatible, Toji plan (billing not wired) | — |
| AI answer pages | Shift+Enter / wand, streamed with sources, cached, follows theme | — |
| Omnibox | engine choice, long-URL fade, star, vault fill, Go/Tor button | — |
| Bookmarks | ⌘D, pinned or hover bar, imports | — |
| Tabs | top/side, groups with colours, drag reorder, long-press new-tab menu, background tabs, audio/mute, agent indicator, open/close animation | — |
| Ad blocking | uBlock Origin, on by default | — |
| Pages | Settings, Welcome, Plans | — |
| System | default browser, cold-start links from other apps | — |
| Theme | toggle drives prefers-color-scheme | — |
| Bug reports | written + images + screenshot; 15 s clip if a Gecko capture path holds up | — |
| Imports | Chrome family incl. Helium, Arc, Dia; Safari; files | — |
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
