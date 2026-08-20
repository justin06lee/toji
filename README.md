<div align="center">

<img src="assets/toji.svg" alt="toji" width="420" />

# toji

**A browser that keeps your identities apart.**<br>
*Containers with their own cookies and circuits, Tor that fails closed, and a password manager the UI can't read.*

</div>

---

Toji is a Chromium-based browser built around one idea: the sites you visit should not be
able to join up who you are. Every tab browses inside a **container** — a named identity
with its own cookies, storage, cache and network route. Signing into a site as Work leaves
Personal signed out, and a tracker embedded in both sees two unrelated browsers.

It also carries the agent work it started as: a local model can drive any page directly,
using [byakugan](https://github.com/justin06lee/byakugan) to read what Chromium actually
painted rather than scraping the DOM.

## Containers

A container is an identity. It owns a Chromium session partition, so nothing crosses
between them — not cookies, not localStorage, not IndexedDB, not the HTTP auth cache.

Five ship by default: **Personal**, **Work**, **Shopping**, **Private** (discarded when its
last tab closes) and **Onion** (routed over Tor). You can add your own, recolor them,
switch any of them between a direct connection and Tor, and make any of them ephemeral.

The toolbar shows which identity the current tab is using, and tabs outside the default
container get a colored underline, so you always know who you are. Following a link keeps
you in the container you were already in.

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

`.onion` addresses typed in the omnibox move the tab into a Tor container automatically,
since a hidden service resolves only through Tor's own resolver.

WebRTC never volunteers local interface addresses; Tor containers disable non-proxied UDP
outright.

## Passwords

Logins are encrypted with your operating system's keychain (via Electron's `safeStorage`)
and are **scoped to the container** they were saved in — a Work credential is never offered
in Personal.

Secrets never enter the browser UI. Filling a password goes main process → page directly;
capturing one goes page → main process directly. The renderer only ever learns which
accounts exist and for which site, so neither a compromised renderer nor the AI agent
driving the browser can read a password. Credentials are released only for the exact origin
they were saved against — no subdomain widening, no https→http downgrade — and the origin is
re-checked at fill time so a navigation mid-click cannot redirect one elsewhere.

## Running it

Requires [bun](https://bun.sh) and Node 18+.

```bash
make          # install, build, install to /Applications, launch
make dev      # run from source with hot reload
make update   # stop, rebuild, reinstall, relaunch
make check    # typecheck + smoke + build + e2e
```

## The omnibox

Enter searches DuckDuckGo (or Google, Bing, Brave, Startpage — your pick) or navigates, the
way any browser does. **Shift+Enter** hands the query to the model instead, which builds an
answer page with its sources; the ✨ button does the same thing with the mouse.

## The agent

A local model can drive any page: click, type, scroll, navigate, upload a file, and take a
cropped look when it needs to see something. Perception runs through byakugan, which reads
Chromium's paint output into a compact manifest with stable ids and verifies every action
against fresh geometry before dispatching it.

Inference can come from a local CLI coding agent (Claude Code, Codex, opencode), the
Anthropic or OpenAI APIs with a key you paste, or any OpenAI-compatible endpoint —
Ollama, LM Studio, vLLM, or your own server. Keys live in a local settings file and are
masked whenever they are read back.

The credential vault is deliberately opaque to the agent: it can use a saved login by name
without ever seeing it.

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
  vault.cjs         encrypted credential storage
  guest-preload.cjs runs in every page: login detection and fill
apps/renderer/      React UI (tabs, containers, settings)
apps/agent-server/  local HTTP server: inference, page generation, memory
```

## License

MIT — see [LICENSE](LICENSE).
