<div align="center">

<img src="assets/toji.png" alt="toji" width="420" />

# toji

**A browser that keeps your identities apart.**<br>
*Containers with their own cookies and circuits, Tor that fails closed, and a password manager the UI can't read.*

</div>

---

Toji is a browser built around one idea: the sites you visit should not be able to join up
who you are. (It is moving from Electron to its own Firefox-engine browser; see
[Running it](#running-it).) Each window uses a **profile** (internally, a container) — a
named identity with its own cookies, storage, cache and network route. Signing into a site
as Work leaves Personal signed out, and a tracker embedded in both sees two unrelated
browsers.

It also carries the agent work it started as: a local model can drive any page directly,
working from screenshots of what Chromium actually painted rather than scraping the DOM.

## Profiles and containers

A container is an identity. It owns a Chromium session partition, so nothing crosses
between them — not cookies, not localStorage, not IndexedDB, not the HTTP auth cache.

Five ship by default: **Personal**, **Work**, **Shopping**, **Private** (discarded when its
last tab closes) and **Onion** (routed over Tor). You can add your own, recolor them,
switch any of them between a direct connection and Tor, and make any of them ephemeral.

Opening a normal window shows a Chrome-style profile chooser, and the window keeps that
identity for its whole life — one window, one profile. **Cmd/Ctrl+N** opens another
profile window and **Cmd/Ctrl+Shift+N** opens Private directly. Profiles have editable
names, colors and avatars.

Each container's egress is encoded in its partition name:

```
[persist:]toji-c-<id>-<direct|tor>
```

The main process reads the policy back out of that name and applies the proxy when
Chromium creates the session — before the guest exists, so there is no window in which a
container can issue a request before its policy is in place. It also means switching a
container between direct and Tor moves it to a different partition, so no cookie survives
the change.

## Tor

Toji drives the real Tor client; it does not implement onion routing itself. It looks for a
`tor` binary in the app bundle and the usual install locations, then for a Tor already
running on port 9050 or 9150.

```bash
brew install tor          # macOS; starting Tor Browser also works
```

Tor starts on demand — the first time you use a container that wants it — and containers
using it stay **offline until it connects**. While Tor is unavailable their traffic is
cancelled outright rather than falling back to the direct connection, and the UI says so
instead of showing a broken page.

**Per-container circuits.** Tor keeps streams arriving on different SocksPorts on separate
circuits, so Toji's managed instance opens a pool of them and assigns one per container.
Two containers therefore cannot be correlated by sharing an exit. If you point Toji at a Tor
you were already running, it only offers one port — Chromium cannot send SOCKS credentials,
so per-container isolation is unavailable in that mode, and Toji tells you rather than
implying protection it isn't providing.

`.onion` addresses typed in the omnibox enable Tor for the window automatically, since a
hidden service resolves only through Tor's own resolver. You can also hold the circular Go
button until its outline completes; it becomes an onion and all tabs in that window use a
fresh ephemeral Tor partition. Hold it again to return to the profile's normal route.

WebRTC never volunteers local interface addresses; Tor containers disable non-proxied UDP
outright.

## Passwords

Logins are encrypted with your operating system's keychain (via Electron's `safeStorage`)
and are **scoped to the container** they were saved in — a Work credential is never offered
in Personal.

Filling a password goes main process → page directly; capturing one goes page → main
process directly. There is no IPC method that returns a secret, and the agent has only two
credential tools: find accounts matching the current site/profile, then ask the vault to
fill one by opaque id. Credentials are released only for the exact origin they were saved
against — no subdomain widening, no https→http downgrade — and both origin and owning
window are re-checked at fill time. A filled password stays secret from the model for the
same reason it does from anyone watching your screen: the agent sees a screenshot, and the
page renders the field as dots. Everything else that is *visible* on the page, though, is
visible to the model — so treat an agent run as showing that screen to your model provider.

## Running it

Toji is moving from Electron to its own browser built on Firefox's engine (Gecko): a
Firefox ESR fork with Mozilla's branding and services stripped out. Firefox is only the
engine: every window draws Toji's own interface — the same React tab strip, address bar,
sidebar and overlays as the Electron app — in place of Firefox's. `docs/gecko.md` has the
decisions, the progress of each phase and how to rebase onto the next ESR.

Requires [bun](https://bun.sh), Xcode with the macOS SDK, and about 40 GB of free disk for
the Firefox source and build (kept in the git-ignored `gecko/.work`).

```bash
make            # build Toji's browser from Firefox ESR source, install to /Applications, launch
make update     # stop, rebuild, reinstall (resetting the old bundle's macOS permissions), relaunch
make faster     # rebuild only Toji's JS/CSS/prefs into the objdir
make dev        # that, then run the unpackaged build with a scratch profile
make check      # typecheck, unit tests, and the built browser's phase checks
make tor-check  # start a real Tor and prove two containers exit from different relays
make test       # unit tests (Vitest)
```

The first build is long (about three hours on an 8 GB M1); later ones reuse the objdir and
sccache. `gecko/build.ts` downloads and verifies the pinned source release, applies
`gecko/patches`, copies `gecko/overlay` into the tree and drives `./mach`.

The Electron app still builds while the migration finishes: `make electron`,
`make electron-dev`, `make electron-install`.

`make tor-check` is the one that proves the isolation claim rather than asserting it: it
boots an actual Tor, sends traffic for two containers through their assigned SocksPorts, and
fails unless they come out of **different relays**.

## The omnibox

Enter searches DuckDuckGo (or Google, Bing, Brave, Startpage — your pick) or navigates, the
way any browser does. **Shift+Enter** hands the query to the model instead, which builds an
answer page with its sources; the wand beside the Go button does the same thing with the
mouse.

## The agent

A local model can drive any page: click, type, scroll, drag, navigate, and upload a file.

It works from screenshots. Each turn Toji captures the tab, the model looks at that image
and answers with one action in the screenshot's own pixel coordinates, Toji scales those to
the page and dispatches a real mouse or key event, then captures again — look, act, look,
act. There is no text rendering of the page and no element ids: the agent acts on what it
can see, which means it must scroll to reach anything below the fold, and native `<select>`
popups are drawn by the OS outside the page so it picks from those with the keyboard.

This needs a model that accepts images. Claude Code and Codex through Yagami both do;
a text-only backend will say so rather than click blind.

Toji does not ship a model. Who runs one for you is a setting, and there are four answers.

**Yagami** is the zero-config one: Toji embeds
[yagami](https://github.com/justin06lee/yagami), which drives whichever coding-agent CLIs
you are already signed into (Claude Code, Codex, opencode, Gemini CLI, any ACP agent) — no
API keys, nothing to paste, and no second bill, since your existing subscription answers
the calls. Settings lists every model each signed-in CLI reports, grouped by harness, and
each one runs on the harness that owns it — not just the Claude ones. Controls a harness
doesn't have (reasoning effort on ACP agents, for instance) are shown as unavailable rather
than silently ignored.

**Cerebras** reads its key from `CEREBRAS_API_KEY` in your `.env.local` (or one you paste
into Settings) and lists the models that key can reach. Any **OpenAI-compatible endpoint**
works too, if you'd rather use your own hardware — Ollama, LM Studio, vLLM, or a home
server.

The fourth is **Toji** itself — see Plans below.

The credential vault is deliberately opaque to the agent: it can use a saved login by name
without ever seeing it.

## Plans

A new install starts on the **Toji** plan, and the first thing it asks for opens the plans
page rather than an answer. That page exists to be honest about a trade: Toji can run
inference for you (managed Cerebras access, nothing to install or paste) for $20/month on
Pro or $60/month on Max — or you can pay nothing and point Toji at a coding agent you
already have.

So the free route is not buried. Directly under the tiers, the same page explains what
yagami is, shows which CLIs it found on your machine, and switches the backend in place —
and the question that sent you there is still on screen, with a button to carry on. Nobody
has to guess what "yagami" means or retype what they were asking.

Only the choice of plan is a default; nothing is a trial. On Free, every part of the
browser works — profiles, Tor, the vault, the agent — for as long as you like.

> **Billing is not connected yet.** The paid tiers show as unavailable, no payment
> processor is wired up, and `subscriptionStatus()` in `apps/agent-server/src/lib/billing.ts`
> reports the free tier unconditionally. Because there is no Toji service to check against,
> an unsubscribed Toji plan simply runs whatever CLI you are signed into, so choosing it
> never takes away a setup that already worked.

## Bug reports

**Help › Report a Bug…** (⌥⇧I on macOS, Alt+Shift+I elsewhere, or the button in Settings)
files an issue on this repository, in one of two forms:

- **The last 15 seconds.** Each window keeps a rolling recording of itself in memory. It is
  Chromium's own capture of the window, so it needs no screen-recording permission, and it
  is encoded as it goes (hardware H.264 where the machine has it) and trimmed to what a
  15-second clip needs. Opening the report freezes it, and the sheet plays back exactly
  what would be sent. Nothing is written to disk or sent anywhere unless you submit it.
  Private and Tor windows are never recorded: while a window is private or on Tor it is not
  captured at all, and what it held before is dropped. Settings can switch the recording off.
- **A written report**: a title, what happened, and images, whether pasted, dropped,
  picked, or a screenshot of the window taken just before the sheet opened.

Issues are public, so the page's address stays out unless you include it. Every report
carries Toji's version, the OS and the window size.

How a report reaches GitHub depends on the login on the machine. With a token that can
write to the repository (`TOJI_GITHUB_TOKEN`, `GH_TOKEN` or `GITHUB_TOKEN` in the
environment or `.env.local`, or else the GitHub CLI's own login), Toji files the issue
itself. GitHub's API has no way to attach a file to an issue, so the recording and images
are committed to the repository under `refs/bug-reports/<id>`, a ref no branch or tag
points at and that `git clone` never downloads, and the issue links them from
raw.githubusercontent.com, where images show inline.

Everyone else finishes on GitHub's own new-issue form. It opens in a tab with the title and
text filled in, and Toji drops the files onto it, so GitHub uploads them itself and the
video plays in the issue. If the drop doesn't take, the files wait in a small tray over the
tab, ready to drag in by hand.

## What this does not do

Worth being clear, because privacy tools invite assumptions:

- **Toji is not the Tor Browser.** Tor protects what the network can see about you. It does
  not make this browser indistinguishable from other browsers, and Toji does not implement
  the Tor Browser's fingerprint-uniformity work. If your threat model includes an adversary
  correlating you by browser fingerprint, use the Tor Browser.
- **It does not generate accounts, personas, or fake identities.** Containers separate the
  identities you actually have.
- **It sends no cover traffic.** Naive decoy requests do not defeat traffic correlation, and
  spending volunteers' Tor bandwidth to imply otherwise would be worse than not doing it.
- **Search is DuckDuckGo** (Google, Bing, Brave and Startpage are also selectable). Toji does
  not run its own index.

## Layout

```
apps/desktop/       Electron main process
  policy.cjs        per-container egress, applied from the partition name
  tor.cjs           Tor lifecycle, SocksPort pool, control port
  vault.cjs         OS-keychain-backed encrypted credential storage
  page-redaction.cjs strips form values from agent observations
  context-menu.cjs  the page right-click menu (View Page Source gets its own
                    window — a <webview> refuses to navigate to view-source:)
  guest-preload.cjs runs in every page: login detection and fill
  browser-promos.cjs removes "switch to our browser" promos (Web Store, search engines)
  browser-import.cjs bookmarks, passwords and profiles from other browsers
  bug-report.cjs    files bug reports as GitHub issues; the token stays in main
apps/renderer/      React UI (tabs, containers, settings)
apps/agent-server/  local HTTP server: inference, page generation, memory
```

## License

MIT — see [LICENSE](LICENSE).
