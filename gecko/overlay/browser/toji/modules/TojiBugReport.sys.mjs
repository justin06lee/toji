/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

// Help › Report a Bug… (⌥⇧I): files a GitHub issue on Toji's repository, directly
// with a token that can write to it, or through GitHub's own new-issue form in a
// tab with the files dropped onto it. See gecko/lib/bugReport.ts for the rules.
// Test against a local fake of GitHub with TOJI_GITHUB_API / _WEB / _RAW.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  TojiShell: "resource:///modules/toji/TojiShell.sys.mjs",
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
});
// gecko/lib bundles export plain functions, so each of these holds the whole module.
ChromeUtils.defineLazyGetter(lazy, "ReportLib", () =>
  ChromeUtils.importESModule("resource:///modules/toji/lib/bugReport.sys.mjs")
);

const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

function env() {
  const out = {};
  for (const name of [
    "TOJI_GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "TOJI_BUG_REPORT_REPO",
    "TOJI_GITHUB_API",
    "TOJI_GITHUB_WEB",
    "TOJI_GITHUB_RAW",
  ]) {
    const value = Services.env.get(name);
    if (value) {
      out[name] = value;
    }
  }
  return out;
}

async function readGhToken() {
  for (const candidate of [...lazy.ReportLib.GH_PATHS]) {
    if (!(await IOUtils.exists(candidate).catch(() => false))) {
      continue;
    }
    try {
      const proc = await lazy.Subprocess.call({
        command: candidate,
        arguments: ["auth", "token", "--hostname", "github.com"],
        stderr: "ignore",
      });
      const timer = setTimeout(() => proc.kill(), 5000);
      let out = "";
      let chunk;
      while ((chunk = await proc.stdout.readString())) {
        out += chunk;
      }
      clearTimeout(timer);
      const { exitCode } = await proc.wait();
      if (exitCode === 0 && out.trim()) {
        return out.trim();
      }
    } catch {}
  }
  return null;
}

function facts() {
  const info = Services.appinfo;
  const os = Services.sysinfo.getProperty("name") + " " + Services.sysinfo.getProperty("version");
  return { app: info.version, os, gecko: info.platformVersion };
}

function reportsDir() {
  return PathUtils.join(PathUtils.tempDir, "toji-bug-reports");
}

class BugReports {
  #reporter = null;
  /** reportId -> { files: [{name,type,path}], at, url, tab } */
  #pending = new Map();

  get target() {
    return lazy.ReportLib.reportTarget(env());
  }

  get reporter() {
    this.#reporter ??= new lazy.ReportLib.GitHubReporter({
      target: this.target,
      fetch: (url, init) => fetch(url, init),
      token: () => lazy.ReportLib.resolveToken(env(), readGhToken),
      log: message => console.log("[toji:bug-report]", message),
    });
    return this.#reporter;
  }

  account(options = {}) {
    return this.reporter.account(options);
  }

  /** A PNG of the whole window — toolbars and page — without Screen Recording. */
  async captureWindow(win) {
    const wgp = win.browsingContext?.currentWindowGlobal;
    if (!wgp) {
      return null;
    }
    const scale = win.devicePixelRatio || 1;
    const bitmap = await wgp.drawSnapshot(null, scale, "rgb(255,255,255)");
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close();
    let blob = await canvas.convertToBlob({ type: "image/png" });
    let type = "image/png";
    if (blob.size >= 9.5 * 1024 * 1024) {
      blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.88 });
      type = "image/jpeg";
    }
    return { type, data: new Uint8Array(await blob.arrayBuffer()) };
  }

  async submit(win, draftIn) {
    const checked = lazy.ReportLib.checkDraft(draftIn);
    if ("error" in checked) {
      return { ok: false, error: checked.error };
    }
    const draft = checked.draft;
    const reportId = lazy.ReportLib.newReportId();
    const account = await this.account();
    if (account.mode === "direct" && draft.via !== "form") {
      try {
        const issue = await this.reporter.fileIssue(draft, facts(), reportId);
        return { ok: true, mode: "direct", number: issue.number, url: issue.url };
      } catch (e) {
        return { ok: false, error: e.message, canUseForm: true };
      }
    }
    // The form route: files wait on disk for the drop; the text goes in the URL,
    // or on the clipboard when it's too long for one.
    const dir = PathUtils.join(reportsDir(), reportId);
    await IOUtils.makeDirectory(dir, { permissions: 0o700 });
    const files = [];
    for (const f of draft.files) {
      const path = PathUtils.join(dir, f.name);
      await IOUtils.write(path, f.bytes);
      files.push({ name: f.name, type: f.type, path });
    }
    const body = lazy.ReportLib.issueBody(draft, facts());
    const { url, overflow } = lazy.ReportLib.newIssueUrl(this.target, draft.title, body);
    if (overflow) {
      Cc["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Ci.nsIClipboardHelper)
        .copyString(body);
    }
    const tab = win.gBrowser.addTrustedTab(url, { relatedToCurrent: true });
    win.gBrowser.selectedTab = tab;
    this.#pending.set(reportId, { files, at: Date.now(), url, tab, bodyOnClipboard: overflow });
    this.#watch(win, reportId);
    return {
      ok: true,
      mode: "form",
      reportId,
      url,
      files: files.map(f => f.name),
      bodyOnClipboard: overflow,
    };
  }

  /** Drops a waiting report's files onto the issue form in its tab. */
  async attach(reportId) {
    const pending = this.#pending.get(reportId);
    if (!pending?.tab?.linkedBrowser) {
      return { ok: false, error: "That report is no longer waiting." };
    }
    const browser = pending.tab.linkedBrowser;
    if (!lazy.ReportLib.isIssueForm(this.target, browser.currentURI?.spec ?? "")) {
      return { ok: false, error: "The tab is not on GitHub's issue form." };
    }
    const actor = browser.browsingContext?.currentWindowGlobal?.getActor("TojiAgent");
    if (!actor) {
      return { ok: false, error: "The form isn't ready yet." };
    }
    return actor.act("attachReport", {
      paths: pending.files.map(f => f.path),
      marker: lazy.ReportLib.ATTACHMENTS_MARKER,
    });
  }

  reveal(reportId) {
    const first = this.#pending.get(reportId)?.files[0];
    if (!first) {
      return false;
    }
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(first.path);
    file.reveal();
    return true;
  }

  // The report tray is the shell's (bottom-right over the form's tab, while the
  // report is finished there): this attaches once the form has loaded and tells the
  // shell how it is going, and when it's filed.
  #watch(win, reportId) {
    const pending = this.#pending.get(reportId);
    const tell = (status, extra = {}) => {
      const state = lazy.ReportLib.issuePageState(this.target, pending.tab.linkedBrowser?.currentURI?.spec ?? "");
      lazy.TojiShell.reportTray(win, {
        reportId,
        tab: pending.tab,
        url: pending.url,
        files: pending.files.map(f => f.name),
        bodyOnClipboard: !!pending.bodyOnClipboard,
        status,
        onForm: state === "form",
        ...extra,
      });
    };
    const update = async () => {
      const spec = pending.tab.linkedBrowser?.currentURI?.spec ?? "";
      const state = lazy.ReportLib.issuePageState(this.target, spec);
      if (state === "filed") {
        const number = Number(/\/issues\/(\d+)/.exec(spec)?.[1]) || undefined;
        tell("filed", { number });
        setTimeout(() => this.#closeTray(win, reportId), 6000);
        return;
      }
      if (state !== "form" || !pending.files.length) {
        tell(pending.attached ? "attached" : "waiting");
        return;
      }
      if (pending.attached || pending.attaching || pending.tab.linkedBrowser?.webProgress?.isLoadingDocument) {
        tell(pending.attached ? "attached" : pending.attaching ? "attaching" : "waiting");
        return;
      }
      pending.attaching = true;
      tell("attaching");
      const result = await this.attach(reportId).catch(e => ({ ok: false, error: e.message }));
      pending.attaching = false;
      if (result?.ok) {
        pending.attached = true;
        tell("attached");
      } else {
        tell("failed", { error: result?.error || "The files didn't attach." });
      }
    };
    const listener = {
      onLocationChange: browser => browser === pending.tab.linkedBrowser && update(),
      onStateChange: (browser, _wp, _req, flags) => {
        if (browser === pending.tab.linkedBrowser && flags & Ci.nsIWebProgressListener.STATE_STOP) {
          update();
        }
      },
    };
    win.gBrowser.addTabsProgressListener(listener);
    const onClose = e => {
      if (e.target === pending.tab) {
        this.#closeTray(win, reportId);
      }
    };
    win.gBrowser.tabContainer.addEventListener("TabClose", onClose);
    const onUnload = () => this.#closeTray(win, reportId);
    win.addEventListener("unload", onUnload, { once: true });
    pending.cleanup = () => {
      win.gBrowser.removeTabsProgressListener(listener);
      win.gBrowser.tabContainer.removeEventListener("TabClose", onClose);
      win.removeEventListener("unload", onUnload);
    };
    update();
  }

  /** The tray's "Try again". */
  retryTray(win, reportId) {
    const pending = this.#pending.get(reportId);
    if (!pending) {
      return;
    }
    pending.attached = false;
    pending.cleanup?.();
    this.#watch(win, reportId);
  }

  /** The tray's close button: the report stops waiting. */
  dismissTray(win, reportId) {
    this.#closeTray(win, reportId);
  }

  #closeTray(win, reportId, keepPending = false) {
    const pending = this.#pending.get(reportId);
    pending?.cleanup?.();
    lazy.TojiShell.reportTray(win, null);
    if (!keepPending) {
      this.#pending.delete(reportId);
      IOUtils.remove(PathUtils.join(reportsDir(), reportId), { recursive: true, ignoreAbsent: true }).catch(() => {});
    }
  }

  /** Startup: drop report folders older than a day. */
  async prune() {
    const base = reportsDir();
    let children = [];
    try {
      children = await IOUtils.getChildren(base);
    } catch {
      return;
    }
    const now = Date.now();
    for (const dir of children) {
      try {
        const info = await IOUtils.stat(dir);
        if (now - info.lastModified >= PENDING_TTL_MS) {
          await IOUtils.remove(dir, { recursive: true });
        }
      } catch {}
    }
  }

  /** Help › Report a Bug… and ⌥⇧I in every window. */
  initWindow(win, open) {
    const doc = win.document;
    if (doc.getElementById("toji-report-bug")) {
      return;
    }
    const keyset = doc.getElementById("mainKeyset");
    if (keyset) {
      const key = doc.createXULElement("key");
      key.id = "key_tojiReportBug";
      key.setAttribute("key", "I");
      key.setAttribute("modifiers", "alt,shift");
      key.addEventListener("command", () => open(win));
      keyset.append(key);
    }
    const help = doc.getElementById("menu_HelpPopup");
    if (help) {
      const item = doc.createXULElement("menuitem");
      item.id = "toji-report-bug";
      item.setAttribute("label", "Report a Bug…");
      item.setAttribute("key", "key_tojiReportBug");
      item.addEventListener("command", () => open(win));
      help.insertBefore(item, help.firstChild);
    }
  }
}

export const TojiBugReport = new BugReports();
