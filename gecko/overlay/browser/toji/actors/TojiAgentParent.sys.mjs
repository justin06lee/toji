/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The parent end of the agent's hands. It never originates anything itself:
// TojiAgent.sys.mjs calls these to act on one tab. File uploads are limited to
// the agent server's uploads and references folders.

export class TojiAgentParent extends JSWindowActorParent {
  /** One call into the page; rejects if the page went away. */
  act(name, data = {}) {
    return this.sendQuery(name, data);
  }

  async upload(path, index, allowedRoots) {
    const real = PathUtils.normalize(path);
    const allowed = allowedRoots.some(root => {
      const r = PathUtils.normalize(root);
      return real.startsWith(r.endsWith("/") ? r : `${r}/`);
    });
    if (!allowed) {
      return { ok: false, error: "That file is not one the agent may upload." };
    }
    const info = await IOUtils.stat(real).catch(() => null);
    if (info?.type !== "regular") {
      return { ok: false, error: "The file is missing." };
    }
    return this.sendQuery("upload", { path: real, index });
  }
}
