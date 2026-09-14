/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The web agent's hands, in the page's process: real (trusted) mouse, wheel and
// keyboard events through the same privileged primitives Marionette and
// WebDriver BiDi use, plus the few page facts the loop needs. No remote protocol.

const TIP = Ci.nsITextInputProcessor;

export class TojiAgentChild extends JSWindowActorChild {
  #tip = null;

  #textInput(win) {
    if (!this.#tip) {
      this.#tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(TIP);
    }
    if (!this.#tip.beginInputTransactionForTests(win)) {
      throw new Error("could not start keyboard input");
    }
    return this.#tip;
  }

  #mouse(win, type, x, y, buttons, clickCount = 0) {
    win.synthesizeMouseEvent(
      type,
      x,
      y,
      { button: 0, buttons, clickCount, modifiers: 0 },
      { isDOMEventSynthesized: true }
    );
  }

  #signature() {
    const doc = this.document;
    const parts = Array.from(
      doc.querySelectorAll("a,button,input,[role=button]")
    )
      .slice(0, 40)
      .map(e => {
        const secret = e.localName === "input" && e.type === "password";
        return (e.innerText || (secret ? "[password]" : e.value) || "")
          .trim()
          .slice(0, 24);
      });
    return `${doc.location?.href}||${doc.title}||${parts.join("~")}`;
  }

  async receiveMessage({ name, data }) {
    const win = this.contentWindow;
    if (!win) {
      throw new Error("the page is gone");
    }
    // Toji's own pages (Settings, Plans…) run with the browser's privileges: the agent
    // never reads or drives them, whatever the loop above decides.
    if (this.document.nodePrincipal.isSystemPrincipal) {
      throw new Error("the browser's own pages can't be driven");
    }
    switch (name) {
      case "info":
        return {
          url: this.document.documentURI,
          title: this.document.title,
          readyState: this.document.readyState,
          innerWidth: win.innerWidth,
          innerHeight: win.innerHeight,
          devicePixelRatio: win.devicePixelRatio,
        };
      case "signature":
        return this.#signature();
      case "move":
        this.#mouse(win, "mousemove", data.x, data.y, data.buttons ?? 0);
        return true;
      case "down":
        this.#mouse(win, "mousedown", data.x, data.y, 1, 1);
        return true;
      case "up":
        this.#mouse(win, "mouseup", data.x, data.y, 0, 1);
        return true;
      case "wheel": {
        const dpr = win.devicePixelRatio || 1;
        win.windowUtils.sendWheelEvent(
          data.x,
          data.y,
          0,
          data.deltaY * dpr,
          0,
          win.WheelEvent.DOM_DELTA_PIXEL,
          0,
          0,
          0,
          0
        );
        return true;
      }
      case "key": {
        const tip = this.#textInput(win);
        const event = new win.KeyboardEvent("", {
          key: data.key,
          code: data.code || undefined,
          keyCode: data.keyCode || 0,
        });
        const flags = data.key.length === 1 ? 0 : TIP.KEY_NON_PRINTABLE_KEY;
        tip.keydown(event, flags);
        tip.keyup(event, flags);
        return true;
      }
      case "char": {
        const tip = this.#textInput(win);
        const event = new win.KeyboardEvent("", { key: data.char });
        tip.keydown(event);
        tip.keyup(event);
        return true;
      }
      case "commitText": {
        // Fallback when key events can't reach an editor (e.g. an inactive tab).
        const tip = this.#textInput(win);
        tip.commitCompositionWith(data.text);
        return true;
      }
      case "upload": {
        const inputs = Array.from(
          this.document.querySelectorAll('input[type="file"]')
        );
        if (!inputs.length) {
          return { ok: false, error: "The page has no file input." };
        }
        const input = inputs[Math.max(0, Math.min(inputs.length - 1, data.index ?? 0))];
        const file = await File.createFromFileName(data.path);
        input.mozSetFileArray([file]);
        input.dispatchEvent(new win.Event("input", { bubbles: true }));
        input.dispatchEvent(new win.Event("change", { bubbles: true }));
        return { ok: true, name: file.name };
      }
      case "attachReport":
        return this.#attachReport(win, data);
      default:
        return null;
    }
  }

  // GitHub's issue form: find the description editor, drop the report's files on
  // it as a person would (GitHub uploads them and writes their markdown in at the
  // caret), or set the editor's file input if the drop isn't taken.
  async #attachReport(win, { paths, marker }) {
    const doc = this.document;
    const shown = el => {
      const r = el.getBoundingClientRect();
      const s = win.getComputedStyle(el);
      return r.width > 80 && r.height > 30 && s.visibility !== "hidden" && s.display !== "none";
    };
    let area = null;
    for (let i = 0; i < 66 && !area; i++) {
      const areas = Array.from(doc.querySelectorAll("textarea")).filter(shown);
      const words = el =>
        [el.name, el.id, el.getAttribute("aria-label"), el.getAttribute("placeholder")].join(" ");
      area =
        areas.find(el => /body|description|comment|markdown/i.test(words(el))) ??
        areas.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0] ??
        null;
      if (!area) {
        await new Promise(r => win.setTimeout(r, 300));
      }
    }
    if (!area) {
      return { ok: false, error: "The issue form never showed its description box." };
    }
    area.scrollIntoView({ block: "center" });
    area.focus();
    const at = area.value.indexOf(marker);
    const caret = at >= 0 ? at + marker.length : area.value.length;
    try {
      area.setSelectionRange(caret, caret);
    } catch {}
    const before = area.value;
    const files = [];
    for (const path of paths) {
      files.push(await File.createFromFileName(path));
    }
    const changed = async () => {
      for (let i = 0; i < 20; i++) {
        if (area.value !== before) {
          return true;
        }
        await new Promise(r => win.setTimeout(r, 200));
      }
      return false;
    };
    const transfer = new win.DataTransfer();
    for (const f of files) {
      transfer.items.add(f);
    }
    for (const type of ["dragenter", "dragover", "drop"]) {
      area.dispatchEvent(
        new win.DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer })
      );
    }
    if (await changed()) {
      return { ok: true, method: "drop" };
    }
    let input = null;
    for (let node = area.parentElement; node && !input; node = node.parentElement) {
      input = node.querySelector('input[type="file"]');
    }
    if (input) {
      input.mozSetFileArray(files);
      input.dispatchEvent(new win.Event("input", { bubbles: true }));
      input.dispatchEvent(new win.Event("change", { bubbles: true }));
      if (await changed()) {
        return { ok: true, method: "input" };
      }
    }
    return { ok: false, error: "GitHub did not take the files." };
  }
}
