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
// Also here: the spotlight (tap Option to toggle), the agent's gliding cursor,
// and the mark on a tab the agent is driving.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  TojiAgentServer: "resource:///modules/toji/TojiAgentServer.sys.mjs",
});
// gecko/lib bundles export plain functions, so each of these holds the whole module.
ChromeUtils.defineLazyGetter(lazy, "AgentLib", () =>
  ChromeUtils.importESModule("resource:///modules/toji/lib/agent.sys.mjs")
);

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_FREE_STEPS = 24;
const TAP_MS = 400;

const ICONS = {
  pointer:
    "M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z",
  paperclip:
    "m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551",
  arrowUp: "m5 12 7-7 7 7M12 19V5",
  square: "M5 5h14v14H5z",
  minus: "M5 12h14",
  plus: "M5 12h14M12 5v14",
  x: "M18 6 6 18M6 6l12 12",
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function icon(doc, name, size = 16) {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("toji-icon");
  const path = doc.createElementNS(SVG_NS, "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

function h(doc, tag, attrs = {}, ...children) {
  const el = doc.createElementNS(XHTML_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) {
      continue;
    }
    if (key === "class") {
      el.className = value;
    } else if (key.startsWith("on")) {
      el.addEventListener(key.slice(2), value);
    } else {
      el.setAttribute(key, value === true ? "" : value);
    }
  }
  for (const child of children) {
    if (child != null) {
      el.append(child);
    }
  }
  return el;
}

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

async function serverJSON(path, body) {
  const res = await lazy.TojiAgentServer.fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
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

function drawCursor(run, point, pressed = false) {
  const tab = run.tab;
  const win = tab.ownerDocument.defaultView;
  const cursor = win.document.getElementById("toji-agent-cursor");
  if (!cursor) {
    return;
  }
  if (!point || !tab.selected) {
    cursor.hidden = true;
    return;
  }
  const rect = tab.linkedBrowser.getBoundingClientRect();
  const zoom = tab.linkedBrowser.fullZoom || 1;
  cursor.hidden = false;
  cursor.style.transform = `translate(${rect.left + point.x * zoom}px, ${rect.top + point.y * zoom}px)`;
  if (pressed) {
    cursor.classList.remove("toji-agent-ripple");
    // Restart the ripple animation.
    void cursor.offsetWidth;
    cursor.classList.add("toji-agent-ripple");
  }
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

function logTo(run, role, text) {
  run.log.push({ role, text });
  TojiAgent._render(run.tab.ownerDocument.defaultView);
}

function setMark(run, on) {
  const tab = run.tab;
  tab.toggleAttribute("toji-agent", on);
  let mark = tab.querySelector(".toji-agent-mark");
  if (on && !mark) {
    mark = tab.ownerDocument.createElementNS(XHTML_NS, "span");
    mark.className = "toji-agent-mark";
    mark.append(icon(tab.ownerDocument, "pointer", 13));
    const close = tab.querySelector(".tab-close-button");
    (close?.parentNode ?? tab.querySelector(".tab-content"))?.insertBefore(mark, close ?? null);
  } else if (!on) {
    mark?.remove();
  }
}

async function runAgent(run, goal) {
  const tab = run.tab;
  const browser = tab.linkedBrowser;
  run.cancelled = false;
  run.running = true;
  setMark(run, true);
  logTo(run, "you", goal);
  const lib = lazy.AgentLib;
  const history = [];
  const sessionId = `tab-${tab.linkedPanel || Date.now()}`;

  let memory = "";
  try {
    const l = await serverJSON("/api/agent/librarian", { goal, sessionId });
    memory = [l.pinned, l.digest].filter(s => s && s.trim()).join("\n\n").slice(0, 1400);
  } catch {}
  let references = [];
  try {
    const r = await serverJSON("/api/references");
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
    const url = browser.currentURI?.spec ?? "";
    if (lib.isBlankPage(url)) {
      let nav;
      try {
        nav = await serverJSON("/api/agent/step", {
          goal,
          url: "about:blank",
          title: "New Tab",
          history: [
            ...history.slice(-19),
            { action: "note", reason: 'No website is open yet. Use "navigate" with the URL the goal needs to begin.' },
          ],
        });
      } catch {
        stepFailures++;
        if (stepFailures >= 5) {
          logTo(run, "system", "The model kept failing to respond — stopping.");
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
      action = await serverJSON("/api/agent/step", {
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
    } catch {
      stepFailures++;
      if (stepFailures >= 5) {
        logTo(run, "system", "The model kept failing to respond (rate-limit or network?) — stopping.");
        break;
      }
      logTo(run, "system", `Model didn't respond — retrying (${stepFailures}/5)…`);
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
        answer = (await serverJSON("/api/agent/research", { question: action.query, goal, url })).answer || "";
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
      serverJSON("/api/memory", { text: note, sessionId }).catch(() => {});
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

// --- Spotlight ----------------------------------------------------------------

/** window -> the tab the open spotlight talks to */
const spotlights = new WeakMap();

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

function renderSpotlight(win) {
  const doc = win.document;
  const tab = spotlights.get(win);
  let root = doc.getElementById("toji-spotlight");
  if (!tab) {
    root?.remove();
    return;
  }
  const run = runFor(tab);
  if (!root) {
    root = h(doc, "div", { id: "toji-spotlight" });
    root.addEventListener("mousedown", e => {
      if (e.target === root) {
        TojiAgent.closeSpotlight(win);
      }
    });
    root.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        TojiAgent.closeSpotlight(win);
      }
    });
    doc.body.append(root);
  }
  const previousValue = root.querySelector(".toji-spotlight-input")?.value ?? "";
  const target = tab.linkedBrowser.contentTitle || hostOf(tab.linkedBrowser.currentURI?.spec) || "this page";
  const prefs = Services.prefs;
  const maxSteps = prefs.getIntPref("toji.agent.maxSteps", 40);
  const noLimit = prefs.getBoolPref("toji.agent.noLimit", false);

  const logBox = run.log.length
    ? h(
        doc,
        "div",
        { class: "toji-spotlight-log" },
        ...run.log.map(l =>
          h(
            doc,
            "div",
            { class: `toji-log-row toji-log-${l.role}` },
            l.role === "you" ? null : icon(doc, "pointer", 14),
            h(doc, "div", { class: "toji-log-bubble" }, l.text)
          )
        ),
        run.running && !run.ask ? h(doc, "div", { class: "toji-log-working" }, h(doc, "span", { class: "toji-spinner" }), "Working…") : null,
        run.ask ? h(doc, "div", { class: "toji-log-asking" }, h(doc, "span", { class: "toji-dot" }), "Waiting for your answer…") : null
      )
    : null;

  const files = run.files.length
    ? h(
        doc,
        "div",
        { class: "toji-spotlight-files" },
        ...run.files.map(f =>
          h(
            doc,
            "span",
            { class: "toji-file-chip" },
            icon(doc, "paperclip", 12),
            h(doc, "span", { class: "toji-file-name" }, f.name),
            h(
              doc,
              "button",
              {
                type: "button",
                "aria-label": `Remove ${f.name}`,
                onclick: () => {
                  run.files = run.files.filter(x => x.index !== f.index);
                  renderSpotlight(win);
                },
              },
              icon(doc, "x", 12)
            )
          )
        )
      )
    : null;

  const input = h(doc, "input", {
    class: "toji-spotlight-input",
    placeholder: run.ask ? "Answer the agent…" : `Tell the agent what to do on ${target}…`,
    spellcheck: "false",
  });
  input.value = previousValue;
  const picker = h(doc, "input", { type: "file", multiple: true, hidden: true });
  picker.addEventListener("change", () => {
    if (picker.files.length) {
      addFiles(run, [...picker.files]);
    }
  });
  const form = h(
    doc,
    "form",
    {
      class: "toji-spotlight-form",
      onsubmit: e => {
        e.preventDefault();
        const value = input.value.trim();
        if (!value) {
          return;
        }
        input.value = "";
        if (run.ask && run.askResolve) {
          logTo(run, "you", value);
          run.askResolve(value);
          return;
        }
        TojiAgent.closeSpotlight(win);
        if (!run.running) {
          runAgent(run, value).catch(e => {
            logTo(run, "system", `The agent stopped: ${e.message}`);
            run.running = false;
            setMark(run, false);
          });
        }
      },
    },
    picker,
    h(
      doc,
      "button",
      { type: "button", class: "toji-ghost", "aria-label": "Attach files", title: "Attach files (or drop them here)", onclick: () => picker.click() },
      icon(doc, "paperclip", 17)
    ),
    icon(doc, "pointer", 19),
    input,
    run.running
      ? h(doc, "button", { type: "button", class: "toji-stop", title: "Stop", onclick: () => TojiAgent.stop(tab) }, icon(doc, "square", 14))
      : null,
    !run.running || run.ask
      ? h(doc, "button", { type: "submit", class: "toji-run", "aria-label": run.ask ? "Answer" : "Run" }, icon(doc, "arrowUp", 17))
      : null
  );

  const footer = h(
    doc,
    "div",
    { class: "toji-spotlight-footer" },
    h(doc, "span", {}, "Runs until done."),
    h(doc, "span", { class: "toji-sep" }, "·"),
    h(doc, "span", {}, "Step limit"),
    h(
      doc,
      "div",
      { class: `toji-stepper${noLimit ? " disabled" : ""}` },
      h(doc, "button", { type: "button", "aria-label": "Fewer steps", onclick: () => { prefs.setIntPref("toji.agent.maxSteps", Math.max(1, maxSteps - 5)); renderSpotlight(win); } }, icon(doc, "minus", 12)),
      h(doc, "span", { class: "toji-steps" }, String(maxSteps)),
      h(doc, "button", { type: "button", "aria-label": "More steps", onclick: () => { prefs.setIntPref("toji.agent.maxSteps", maxSteps + 5); renderSpotlight(win); } }, icon(doc, "plus", 12))
    ),
    h(
      doc,
      "button",
      {
        type: "button",
        role: "switch",
        class: "toji-switch",
        "aria-checked": String(noLimit),
        onclick: () => {
          prefs.setBoolPref("toji.agent.noLimit", !noLimit);
          renderSpotlight(win);
        },
      },
      h(doc, "span", { class: "toji-switch-track" }, h(doc, "span", { class: "toji-switch-thumb" })),
      h(doc, "span", {}, "No limit")
    ),
    noLimit ? h(doc, "span", { class: "toji-warn" }, "⚠ may run long — Stop to halt") : null
  );

  const card = h(doc, "div", { class: "toji-spotlight-card" }, logBox, files, form, footer);
  card.addEventListener("mousedown", e => e.stopPropagation());
  card.addEventListener("dragover", e => {
    e.preventDefault();
    card.classList.add("dragover");
  });
  card.addEventListener("dragleave", () => card.classList.remove("dragover"));
  card.addEventListener("drop", e => {
    e.preventDefault();
    card.classList.remove("dragover");
    if (e.dataTransfer.files.length) {
      addFiles(run, [...e.dataTransfer.files]);
    }
  });
  root.replaceChildren(card);
  const log = root.querySelector(".toji-spotlight-log");
  if (log) {
    log.scrollTop = log.scrollHeight;
  }
  input.focus();
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
    const doc = win.document;
    if (!doc.getElementById("toji-agent-cursor")) {
      const cursor = h(doc, "div", { id: "toji-agent-cursor", hidden: true });
      cursor.append(icon(doc, "pointer", 22));
      doc.body.append(cursor);
    }
    watchOptionTap(win);
    win.gBrowser.tabContainer.addEventListener("TabClose", e => {
      const run = runs.get(e.target);
      if (run) {
        this.stop(e.target);
        runs.delete(e.target);
      }
      if (spotlights.get(win) === e.target) {
        this.closeSpotlight(win);
      }
    });
    win.gBrowser.tabContainer.addEventListener("TabSelect", () => {
      for (const tab of win.gBrowser.tabs) {
        const run = runs.get(tab);
        if (run?.running) {
          drawCursor(run, tab.selected ? run.pointer : null);
        }
      }
      if (!runs.get(win.gBrowser.selectedTab)?.running) {
        doc.getElementById("toji-agent-cursor")?.setAttribute("hidden", "true");
      }
    });
  },

  openSpotlight(win, tab = win.gBrowser.selectedTab) {
    if (win.document.documentElement.hasAttribute("toji-picking")) {
      return;
    }
    spotlights.set(win, tab);
    renderSpotlight(win);
  },

  closeSpotlight(win) {
    spotlights.delete(win);
    renderSpotlight(win);
  },

  toggleSpotlight(win) {
    if (spotlights.has(win)) {
      this.closeSpotlight(win);
    } else {
      this.openSpotlight(win);
    }
  },

  /** Starts a run from outside the spotlight (e.g. a new AI tab). */
  run(tab, goal) {
    const run = runFor(tab);
    if (!run.running) {
      runAgent(run, goal);
    }
  },

  stop(tab) {
    const run = runs.get(tab);
    if (!run) {
      return;
    }
    run.cancelled = true;
    run.askResolve?.(null);
    run.ask = null;
    drawCursor(run, null);
    this._render(tab.ownerDocument.defaultView);
  },

  isRunning(tab) {
    return !!runs.get(tab)?.running;
  },

  _render(win) {
    if (win && spotlights.has(win)) {
      renderSpotlight(win);
    }
  },
};
