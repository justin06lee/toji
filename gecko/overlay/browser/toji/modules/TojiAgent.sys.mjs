/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";

// Toji's web agent. Look, act, look, act: each turn it photographs a tab with
// drawSnapshot (a background tab works too), the local agent server's model
// answers with one action in the screenshot's pixels, and the TojiAgent actor
// dispatches real input into the page. The browser drives itself; there is no
// remote protocol.
//
// Its spotlight, gliding cursor and the mark on a driven tab are the shell's
// (TojiShell): this module reports the runs, the pointer and the Option tap.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  TojiAgentServer: "resource:///modules/toji/TojiAgentServer.sys.mjs",
  TojiShell: "resource:///modules/toji/TojiShell.sys.mjs",
});
// gecko/lib bundles export plain functions, so each of these holds the whole module.
ChromeUtils.defineLazyGetter(lazy, "AgentLib", () =>
  ChromeUtils.importESModule("resource:///modules/toji/lib/agent.sys.mjs")
);

const MAX_FREE_STEPS = 24;
const TAP_MS = 400;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function toUrl(input) {
  const text = String(input).trim();
  return /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

async function serverJSON(path, body, signal) {
  const res = await lazy.TojiAgentServer.fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data;
}

/** Per-tab agent state. */
class Run {
  running = false;
  cancelled = false;
  log = [];
  ask = null;
  askResolve = null;
  files = [];
  pointer = null;
  /** Aborts the model call in flight when the run is stopped. */
  abort = null;
  /** Settles when the run has wound down. */
  done = Promise.resolve();
  constructor(tab) {
    this.tab = tab;
  }
}

const runs = new WeakMap();
let bowSign = 1;

function runFor(tab) {
  let run = runs.get(tab);
  if (!run) {
    run = new Run(tab);
    runs.set(tab, run);
  }
  return run;
}

function actorFor(browser) {
  const wgp = browser.browsingContext?.currentWindowGlobal;
  if (!wgp) {
    throw new Error("the page is not ready");
  }
  return wgp.getActor("TojiAgent");
}

// --- Senses and hands -------------------------------------------------------

async function capture(browser) {
  const actor = actorFor(browser);
  const info = await actor.act("info");
  const viewport = { w: info.innerWidth, h: info.innerHeight };
  const scale = lazy.AgentLib.captureScale(viewport, info.devicePixelRatio, 1400);
  const bitmap = await browser.browsingContext.currentWindowGlobal.drawSnapshot(
    null,
    scale,
    "rgb(255,255,255)"
  );
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  const width = bitmap.width;
  const height = bitmap.height;
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return {
    dataUri: `data:image/png;base64,${bytes.toBase64()}`,
    width,
    height,
    viewport,
  };
}

async function waitForLoad(browser, run) {
  for (let i = 0; i < 25; i++) {
    if (run.cancelled || !browser.webProgress?.isLoadingDocument) {
      return;
    }
    await delay(100);
  }
}

/** Where the agent's pointer is, in the window, for the shell's cursor; none off-screen. */
function drawCursor(run, point, pressed = false) {
  const tab = run.tab;
  const win = tab.ownerDocument.defaultView;
  if (!point || !tab.selected) {
    lazy.TojiShell.agentPointer(win, null);
    return;
  }
  const rect = tab.linkedBrowser.getBoundingClientRect();
  const zoom = tab.linkedBrowser.fullZoom || 1;
  lazy.TojiShell.agentPointer(win, { x: rect.left + point.x * zoom, y: rect.top + point.y * zoom, pressed });
}

async function glide(run, actor, to, buttons = 0) {
  const from = run.pointer ?? { x: to.x, y: to.y };
  bowSign = bowSign === 1 ? -1 : 1;
  const path = lazy.AgentLib.glidePath(from, to, bowSign);
  let elapsed = 0;
  for (const p of path) {
    if (run.cancelled) {
      return;
    }
    await delay(Math.max(0, p.at - elapsed));
    elapsed = p.at;
    await actor.act("move", { x: p.x, y: p.y, buttons });
    run.pointer = { x: p.x, y: p.y };
    drawCursor(run, run.pointer);
  }
}

async function clickAt(run, actor, point) {
  await glide(run, actor, point);
  await delay(120);
  await actor.act("move", point);
  await actor.act("down", point);
  await actor.act("up", point);
  drawCursor(run, point, true);
}

async function dragFromTo(run, actor, from, to) {
  await glide(run, actor, from);
  await actor.act("down", from);
  await delay(140);
  await glide(run, actor, to, 1);
  await actor.act("move", { ...to, buttons: 1 });
  await delay(120);
  await actor.act("up", to);
}

async function typeText(run, actor, text) {
  for (const ch of text) {
    if (run.cancelled) {
      return;
    }
    await actor.act("char", { char: ch });
    await delay(12);
  }
}

// --- The loop ---------------------------------------------------------------

/**
 * A driven tab behind another stays awake — its page keeps painting, animating and
 * running its timers — as the Electron app's hidden webview did. Firefox puts a
 * background tab to sleep (and does again after each tab switch), so every step
 * wakes it; the run's end hands it back.
 */
function keepAwake(run, on) {
  const { tab } = run;
  if (tab.selected || tab.closing || !tab.linkedBrowser) {
    return;
  }
  try {
    tab.linkedBrowser.docShellIsActive = on;
  } catch {}
}

const LOG_LIMIT = 200;

function logTo(run, role, text) {
  run.log.push({ role, text });
  // The spotlight copies the log on every render; an unlimited run keeps the tail.
  if (run.log.length > LOG_LIMIT) {
    run.log.splice(0, run.log.length - LOG_LIMIT);
  }
  TojiAgent._render(run.tab.ownerDocument.defaultView);
}

/** The tab's mark comes from the run's state; the shell redraws it. */
function setMark(run, _on) {
  TojiAgent._render(run.tab.ownerDocument.defaultView);
}

async function runAgent(run, goal) {
  const tab = run.tab;
  const browser = tab.linkedBrowser;
  run.cancelled = false;
  run.running = true;
  run.abort = new AbortController();
  const signal = run.abort.signal;
  const server = (path, body) => serverJSON(path, body, signal);
  setMark(run, true);
  logTo(run, "you", goal);
  const lib = lazy.AgentLib;
  const history = [];
  const sessionId = `tab-${tab.linkedPanel || Date.now()}`;

  let memory = "";
  try {
    const l = await server("/api/agent/librarian", { goal, sessionId });
    memory = [l.pinned, l.digest].filter(s => s && s.trim()).join("\n\n").slice(0, 1400);
  } catch {}
  let references = [];
  try {
    const r = await server("/api/references");
    references = (r.references ?? []).map((d, i) => ({
      index: 100000 + i,
      name: d.name,
      mime: d.mime,
      path: d.path,
    }));
  } catch {}
  const allFiles = () => [...run.files, ...references];

  const prefs = Services.prefs;
  const maxSteps = lib.stepBudget(
    prefs.getIntPref("toji.agent.maxSteps", 40),
    prefs.getBoolPref("toji.agent.noLimit", false)
  );
  let waits = 0;
  let shotFailures = 0;
  let stepFailures = 0;
  let refusals = 0;
  let acted = 0;
  let doneOverrides = 0;
  let completed = false;
  const tooMany = text => {
    if (++waits > MAX_FREE_STEPS) {
      logTo(run, "system", text);
      return true;
    }
    return false;
  };

  let step = 0;
  for (; step < maxSteps; step++) {
    if (run.cancelled) {
      break;
    }
    keepAwake(run, true);
    const url = browser.currentURI?.spec ?? "";
    if (lib.isBlankPage(url)) {
      let nav;
      try {
        nav = await server("/api/agent/step", {
          goal,
          url: "about:blank",
          title: "New Tab",
          history: [
            ...history.slice(-19),
            { action: "note", reason: 'No website is open yet. Use "navigate" with the URL the goal needs to begin.' },
          ],
        });
      } catch (e) {
        if (run.cancelled) {
          break;
        }
        stepFailures++;
        if (stepFailures >= 5) {
          logTo(run, "system", `The model kept failing to respond (${e.message}) — stopping.`);
          break;
        }
        await delay(1000 * stepFailures);
        step--;
        continue;
      }
      if (run.cancelled) {
        break;
      }
      if (nav.reason) {
        logTo(run, "agent", nav.reason);
      }
      if (nav.action === "done") {
        completed = true;
        break;
      }
      if (nav.action !== "navigate" || !nav.url) {
        logTo(run, "system", 'No page is open — tell me a site to go to (e.g. "go to lichess.org and play a game").');
        break;
      }
      const dest = toUrl(nav.url);
      logTo(run, "agent", `Opening ${dest}`);
      browser.fixupAndLoadURIString(dest, {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
      history.push({ action: "navigate", reason: nav.reason });
      await delay(1200);
      step--;
      continue;
    }

    await waitForLoad(browser, run);
    if (run.cancelled) {
      break;
    }
    let actor;
    let shot;
    try {
      actor = actorFor(browser);
      shot = await capture(browser);
    } catch (e) {
      shotFailures++;
      if (shotFailures >= 5) {
        logTo(run, "system", `Could not see this page (${e.message}) — stopping.`);
        break;
      }
      await delay(600 * shotFailures);
      step--;
      continue;
    }
    shotFailures = 0;
    if (run.cancelled) {
      break;
    }

    let action;
    try {
      action = await server("/api/agent/step", {
        goal,
        url,
        title: browser.contentTitle,
        history: history.slice(-20),
        image: shot.dataUri,
        image_size: { w: shot.width, h: shot.height },
        credentialAccess: !!TojiAgent.vault,
        files: allFiles().map(f => ({ index: f.index, name: f.name, mime: f.mime })),
        memory,
      });
      stepFailures = 0;
    } catch (e) {
      if (run.cancelled) {
        break;
      }
      stepFailures++;
      if (stepFailures >= 5) {
        logTo(run, "system", `The model kept failing to respond (${e.message}) — stopping.`);
        break;
      }
      logTo(run, "system", `Model didn't respond (${e.message}) — retrying (${stepFailures}/5)…`);
      await delay(1000 * stepFailures);
      step--;
      continue;
    }
    if (run.cancelled) {
      break;
    }
    if (action.error) {
      refusals++;
      if (refusals >= 3) {
        logTo(run, "system", "The agent kept replying with text instead of taking an action — it may be declining the task. Stopping.");
        break;
      }
      history.push({ action: "note", reason: "you replied with prose, not a JSON action — you DO control this browser; return one JSON action" });
      await delay(500);
      step--;
      continue;
    }
    refusals = 0;
    if (action.reason) {
      logTo(run, "agent", action.reason);
    }
    if (action.action === "done" || action.done) {
      if (acted === 0 && doneOverrides < 1) {
        doneOverrides++;
        history.push({ action: "note", reason: "don't say done before doing anything — actually perform the task first" });
        step--;
        continue;
      }
      completed = true;
      break;
    }

    if (action.action === "research" && typeof action.query === "string") {
      logTo(run, "agent", `Researching: ${action.query}`);
      let answer = "";
      try {
        answer = (await server("/api/agent/research", { question: action.query, goal, url })).answer || "";
      } catch {}
      const text = answer || "No useful guidance found.";
      history.push({ action: "researched", reason: `${action.query} → ${text}` });
      logTo(run, "agent", `Guidance → ${text.slice(0, 240)}`);
      step--;
      if (tooMany("Too many non-acting steps — stopping.")) {
        break;
      }
      continue;
    }

    if (action.action === "findCredentials") {
      const matches = (await TojiAgent.vault?.matches(browser).catch(() => [])) ?? [];
      const summary = matches.map(e => ({ credentialId: e.id, name: e.name, username: e.username }));
      history.push({
        action: "findCredentials",
        reason: summary.length ? `matches: ${JSON.stringify(summary)}` : "no saved login matches this exact website and profile",
      });
      logTo(
        run,
        "agent",
        summary.length
          ? `Found ${summary.length} saved login${summary.length === 1 ? "" : "s"} for ${hostOf(url)}.`
          : `No saved login for ${hostOf(url) || "this site"}.`
      );
      step--;
      if (tooMany("Too many non-acting steps — stopping.")) {
        break;
      }
      continue;
    }

    if (action.action === "fillCredential" && typeof action.credentialId === "string") {
      const ok = (await TojiAgent.vault?.fill(browser, action.credentialId).catch(() => false)) ?? false;
      history.push({
        action: "fillCredential",
        reason: ok ? "saved login filled securely" : "fill refused: credential, origin, or profile did not match",
      });
      logTo(run, ok ? "agent" : "system", ok ? "Filled the saved login." : "Could not fill that login on this website/profile.");
      if (ok) {
        acted++;
        await delay(700);
      } else {
        step--;
        if (tooMany("Too many non-acting steps — stopping.")) {
          break;
        }
      }
      continue;
    }

    if (action.action === "ask" && typeof action.question === "string" && action.question.trim()) {
      const question = action.question.trim();
      logTo(run, "agent", question);
      run.ask = question;
      // Bring the chat up so the user sees the question.
      TojiAgent.openSpotlight(tab.ownerDocument.defaultView, tab);
      const answer = await new Promise(resolve => (run.askResolve = resolve));
      run.askResolve = null;
      run.ask = null;
      TojiAgent._render(tab.ownerDocument.defaultView);
      if (answer === null || run.cancelled) {
        break;
      }
      history.push({ action: "asked user", reason: `${question} → ${answer}`.slice(0, 400) });
      step--;
      continue;
    }

    if (action.action === "remember" && typeof action.text === "string" && action.text.trim()) {
      const note = action.text.trim().slice(0, 500);
      server("/api/memory", { text: note, sessionId }).catch(() => {});
      memory = `${memory}\n- ${note}`.slice(-1400);
      logTo(run, "agent", `Remembered: ${note.slice(0, 120)}`);
      history.push({ action: "remembered", reason: note.slice(0, 80) });
      step--;
      if (tooMany("Too many non-acting steps — stopping.")) {
        break;
      }
      continue;
    }

    if (action.action === "uploadFile") {
      const files = allFiles();
      const file = files.find(f => f.index === action.fileIndex) ?? files[0];
      let ok = false;
      if (file) {
        const data = PathUtils.join(PathUtils.profileDir, "agent-server");
        const res = await actor
          .upload(file.path, 0, [PathUtils.join(data, "uploads"), PathUtils.join(data, "references")])
          .catch(() => null);
        ok = !!res?.ok;
      }
      logTo(run, ok ? "agent" : "system", ok ? `Uploaded ${file?.name}` : "Could not upload the file (no file-input found).");
      history.push({ action: "uploadFile", reason: ok ? `uploaded ${file?.name}` : "upload failed" });
      await delay(900);
      acted++;
      continue;
    }

    if (action.action === "wait") {
      waits++;
      const ms = lib.waitMs(action.ms);
      let base = "";
      try {
        base = await actor.act("signature");
      } catch {}
      const start = Date.now();
      while (Date.now() - start < ms) {
        if (run.cancelled) {
          break;
        }
        await delay(1000);
        let now = base;
        try {
          now = await actorFor(browser).act("signature");
        } catch {}
        if (now !== base) {
          break;
        }
      }
      history.push({ action: "wait", reason: action.reason });
      step--;
      if (waits > MAX_FREE_STEPS) {
        logTo(run, "system", "Waited a long time without progress — stopping.");
        break;
      }
      continue;
    }

    const point = (x, y) =>
      typeof x === "number" && typeof y === "number" ? lib.toPagePoint(x, y, shot) : undefined;
    const target = point(action.x, action.y);
    if ((action.action === "click" || action.action === "hover") && !target) {
      history.push({
        action: "note",
        reason: `${action.action} needs x and y in screenshot pixels — look again and give the centre of the target`,
      });
      step--;
      if (tooMany("Too many non-acting steps — stopping.")) {
        break;
      }
      continue;
    }

    try {
      if (action.action === "navigate" && action.url) {
        browser.fixupAndLoadURIString(toUrl(action.url), {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        });
        await delay(2000);
      } else if (action.action === "click" && target) {
        await clickAt(run, actor, target);
        await delay(1100);
      } else if (action.action === "hover" && target) {
        await glide(run, actor, target);
        await delay(700);
      } else if (action.action === "type") {
        if (target) {
          await clickAt(run, actor, target);
          await delay(350);
        }
        await typeText(run, actor, String(action.text ?? ""));
        await delay(600);
      } else if (action.action === "drag") {
        const from = point(action.fromX, action.fromY);
        const to = point(action.toX, action.toY);
        if (from && to) {
          await dragFromTo(run, actor, from, to);
          await delay(1100);
        }
      } else if (action.action === "press" || action.action === "scroll") {
        const verb = action.action;
        let failure = null;
        if (verb === "press") {
          const key = lib.pressKey(action.key);
          if (key) {
            await actor.act("key", key);
          } else {
            failure = `unknown key "${action.key}"`;
          }
        } else {
          const info = await actor.act("info");
          const dy = Math.round(info.innerHeight * 0.8) * (action.direction === "up" ? -1 : 1);
          await actor.act("wheel", {
            x: Math.round(info.innerWidth / 2),
            y: Math.round(info.innerHeight / 2),
            deltaY: dy,
          });
        }
        if (failure) {
          logTo(run, "system", `Couldn't ${verb}: ${failure}`);
          history.push({ action: `${verb} FAILED`, reason: failure.slice(0, 200) });
          step--;
          if (tooMany("Too many blocked/non-acting steps — stopping.")) {
            break;
          }
          continue;
        }
        await delay(verb === "scroll" ? 700 : 500);
      } else {
        history.push({
          action: "note",
          reason: `your "${action.action}" action was missing its required field (research needs query, ask needs question, remember needs text, fillCredential needs credentialId) — resend it complete`,
        });
        step--;
        if (tooMany("Too many non-acting steps — stopping.")) {
          break;
        }
        continue;
      }
    } catch (e) {
      // Say why nothing happened: to the user in the log, and to the model, which
      // otherwise sees an unchanged page after what it was told was a click.
      const why = String(e?.message ?? e).slice(0, 200);
      console.error(`[toji:agent] ${action.action} failed`, e);
      logTo(run, "system", `Couldn't ${action.action}: ${why}`);
      history.push({ action: `${action.action} FAILED`, reason: why });
      continue;
    }
    acted++;
    const at = target ? ` ${target.x},${target.y}` : "";
    const label =
      action.action === "drag"
        ? `drag ${Math.round(action.fromX ?? 0)},${Math.round(action.fromY ?? 0)}→${Math.round(action.toX ?? 0)},${Math.round(action.toY ?? 0)}`
        : `${action.action}${at}${action.key ? ` ${action.key}` : ""}`;
    history.push({ action: label, reason: action.reason });
  }

  run.pointer = null;
  drawCursor(run, null);
  keepAwake(run, false);
  if (!run.cancelled) {
    if (completed) {
      logTo(run, "system", "Done.");
    } else if (Number.isFinite(maxSteps) && step >= maxSteps) {
      logTo(run, "system", "Hit the step limit — raise it or turn off the limit to keep going.");
    }
  }
  run.running = false;
  setMark(run, false);
  TojiAgent._render(tab.ownerDocument.defaultView);
}

// --- Files dropped on the spotlight ------------------------------------------------

async function addFiles(run, fileList) {
  for (const file of fileList) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const saved = await serverJSON("/api/files", {
        name: file.name,
        mime: file.type || "application/octet-stream",
        dataBase64: bytes.toBase64(),
      });
      const index = run.files.reduce((m, f) => Math.max(m, f.index + 1), 0);
      run.files.push({ index, name: saved.name, mime: saved.mime, path: saved.path });
    } catch (e) {
      logTo(run, "system", `Could not attach ${file.name}: ${e.message}`);
    }
  }
  TojiAgent._render(run.tab.ownerDocument.defaultView);
}

// --- Option tap -----------------------------------------------------------------

function watchOptionTap(win) {
  let down = false;
  let at = 0;
  let used = false;
  const opts = { capture: true, mozSystemGroup: true };
  win.addEventListener(
    "keydown",
    e => {
      if (e.key === "Alt") {
        if (!down) {
          down = true;
          at = Date.now();
          used = false;
        }
      } else if (down) {
        used = true;
      }
    },
    opts
  );
  win.addEventListener(
    "keyup",
    e => {
      if (e.key !== "Alt") {
        return;
      }
      const tap = down && !used && Date.now() - at < TAP_MS;
      down = false;
      if (tap) {
        TojiAgent.toggleSpotlight(win);
      }
    },
    opts
  );
  win.addEventListener("mousedown", () => (used = true), opts);
}

let registered = false;

export const TojiAgent = {
  /** Set by the vault (phase 6): { matches(browser), fill(browser, id) }. */
  vault: null,

  init() {
    if (registered) {
      return;
    }
    registered = true;
    ChromeUtils.registerWindowActor("TojiAgent", {
      parent: { esModuleURI: "resource:///modules/toji/actors/TojiAgentParent.sys.mjs" },
      child: { esModuleURI: "resource:///modules/toji/actors/TojiAgentChild.sys.mjs" },
      messageManagerGroups: ["browsers"],
    });
  },

  initWindow(win) {
    watchOptionTap(win);
    win.gBrowser.tabContainer.addEventListener("TabClose", e => {
      if (runs.get(e.target)) {
        this.stop(e.target);
        runs.delete(e.target);
      }
    });
    win.gBrowser.tabContainer.addEventListener("TabSelect", () => {
      // The cursor shows over the tab in front only.
      const run = runs.get(win.gBrowser.selectedTab);
      drawCursor(run ?? { tab: win.gBrowser.selectedTab }, run?.running ? run.pointer : null);
      this._render(win);
    });
  },

  /** The spotlight is the shell's; these open it on a tab, close it, or toggle it (Option). */
  openSpotlight(win, tab = win.gBrowser.selectedTab) {
    if (win.document.documentElement.hasAttribute("toji-picking")) {
      return;
    }
    lazy.TojiShell.spotlight(win, tab);
  },

  closeSpotlight(win) {
    lazy.TojiShell.spotlight(win, null);
  },

  toggleSpotlight(win) {
    if (win.document.documentElement.hasAttribute("toji-picking")) {
      return;
    }
    lazy.TojiShell.spotlight(win, "toggle");
  },

  /** Starts a run from outside the spotlight (e.g. a new AI tab). */
  run(tab, goal) {
    this.submit(tab, goal);
  },

  /**
   * What was typed into the spotlight for a tab: the answer to the agent's question
   * if it is waiting on one, otherwise a new run (unless one is already going).
   */
  submit(tab, text) {
    const run = runFor(tab);
    if (run.ask && run.askResolve) {
      logTo(run, "you", text);
      run.askResolve(text);
      return "answered";
    }
    if (run.running) {
      if (!run.cancelled) {
        return "busy";
      }
      // Stopped, and still winding down (its model call being aborted): the new goal
      // starts the moment it has.
      run.done.then(() => this.submit(tab, text));
      return "started";
    }
    run.done = runAgent(run, text).catch(e => {
      logTo(run, "system", `The agent stopped: ${e.message}`);
      run.running = false;
      keepAwake(run, false);
      setMark(run, false);
    });
    return "started";
  },

  stop(tab) {
    const run = runs.get(tab);
    if (!run) {
      return;
    }
    run.cancelled = true;
    run.abort?.abort();
    run.askResolve?.(null);
    run.ask = null;
    drawCursor(run, null);
    this._render(tab.ownerDocument.defaultView);
  },

  isRunning(tab) {
    return !!runs.get(tab)?.running;
  },

  /** A tab's run as the shell shows it: no paths, no internals. A stopped run is over at once. */
  stateOf(tab) {
    const run = tab ? runs.get(tab) : null;
    return {
      running: !!run?.running && !run.cancelled,
      log: run ? run.log.map(l => ({ role: l.role, text: l.text })) : [],
      ask: run?.ask ?? null,
      files: run ? run.files.map(f => ({ index: f.index, name: f.name })) : [],
    };
  },

  addFiles(tab, files) {
    return addFiles(runFor(tab), files);
  },

  removeFile(tab, index) {
    const run = runs.get(tab);
    if (run) {
      run.files = run.files.filter(f => f.index !== index);
      this._render(tab.ownerDocument.defaultView);
    }
  },

  /** Something about a run in this window changed: the shell redraws. */
  _render(win) {
    if (win) {
      lazy.TojiShell.agentChanged(win);
    }
  },
};
