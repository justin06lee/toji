/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Toji's containers (profiles), kept in <profile>/toji-containers.json and
// mirrored onto Gecko contextual identities. Firefox's identity records hold the
// name and a nearest-match colour and icon for Firefox's own surfaces; Toji's
// file holds the real accent colour, the avatar, the route (direct or Tor) and
// whether the container is ephemeral.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ContextualIdentityService:
    "resource://gre/modules/ContextualIdentityService.sys.mjs",
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
});
// gecko/lib bundles export plain functions, so each of these holds the whole module.
ChromeUtils.defineLazyGetter(lazy, "ContainersLib", () =>
  ChromeUtils.importESModule("resource:///modules/toji/lib/containers.sys.mjs")
);

const FILE_NAME = "toji-containers.json";
export const CONTAINERS_CHANGED_TOPIC = "toji-containers-changed";
export const CONTAINER_CLEARED_TOPIC = "toji-container-cleared";

function readJSONSync(path) {
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
  if (!file.exists()) {
    return null;
  }
  const stream = Cc[
    "@mozilla.org/network/file-input-stream;1"
  ].createInstance(Ci.nsIFileInputStream);
  stream.init(file, -1, 0, 0);
  try {
    const text = lazy.NetUtil.readInputStreamToString(
      stream,
      stream.available(),
      { charset: "UTF-8" }
    );
    return JSON.parse(text);
  } finally {
    stream.close();
  }
}

/** Wipes everything Gecko keeps for one userContextId, private or not. */
export function clearUserContext(userContextId) {
  return new Promise(resolve => {
    Services.clearData.deleteDataFromOriginAttributesPattern(
      { userContextId },
      { onDataDeleted: () => resolve() }
    );
  });
}

// Hold-to-Tor gives a window a fresh Tor identity for a while. These live only
// in memory, in private windows, under userContextIds far above anything
// ContextualIdentityService hands out; nothing about them reaches disk.
const TEMPORARY_BASE = 1_000_000;

class ContainerStore {
  #containers = null;
  #byUserContextId = new Map();
  #byId = new Map();
  #temporary = new Map();
  #temporaryCount = 0;

  /**
   * A fresh, ephemeral Tor container standing in for `base` (hold-to-Tor, or a
   * .onion address typed in a direct window).
   */
  createTorOverlay(base) {
    this.ensureLoaded();
    const n = ++this.#temporaryCount;
    const c = Object.freeze({
      id: `${base.id}--tor-${n}`,
      name: base.name,
      color: base.color,
      avatar: base.avatar,
      egress: "tor",
      ephemeral: true,
      temporary: true,
      baseId: base.id,
      userContextId: TEMPORARY_BASE + n,
    });
    this.#temporary.set(c.id, c);
    return c;
  }

  /** Ends a hold-to-Tor identity and wipes what it held. */
  async releaseTemporary(id) {
    const c = this.#temporary.get(id);
    if (!c) {
      return;
    }
    this.#temporary.delete(id);
    await clearUserContext(c.userContextId);
  }

  get path() {
    return PathUtils.join(PathUtils.profileDir, FILE_NAME);
  }

  /**
   * Loads synchronously on first use: the proxy filter and the first window
   * both need an answer before any async startup work could finish.
   */
  ensureLoaded() {
    if (this.#containers) {
      return;
    }
    let data = null;
    try {
      data = readJSONSync(this.path);
    } catch (e) {
      console.error("[toji:containers] unreadable, starting fresh", e);
    }
    const firstRun = !data;
    this.#containers = lazy.ContainersLib.normalizeContainers(
      data?.containers
    );
    this.#syncIdentities(firstRun);
    if (firstRun || this.#dirty) {
      this.#save();
    }
  }

  #dirty = false;

  #syncIdentities(firstRun) {
    const lib = lazy.ContainersLib;
    const CIS = lazy.ContextualIdentityService;
    const identities = CIS.getPublicIdentities();
    const used = new Set();
    for (const c of this.#containers) {
      let ident = c.userContextId
        ? CIS.getPublicIdentityFromId(c.userContextId)
        : null;
      if (!ident && firstRun) {
        ident =
          identities.find(
            i =>
              !used.has(i.userContextId) &&
              lib.FIREFOX_DEFAULT_IDENTITIES[i.l10nId] === c.id
          ) ?? null;
      }
      const icon = lib.firefoxIcon(c);
      const color = lib.firefoxColor(c.color);
      if (!ident) {
        ident = CIS.create(c.name, icon, color);
        this.#dirty = true;
      } else if (
        ident.l10nId ||
        ident.name !== c.name ||
        ident.icon !== icon ||
        ident.color !== color
      ) {
        CIS.update(ident.userContextId, c.name, icon, color);
      }
      if (c.userContextId !== ident.userContextId) {
        c.userContextId = ident.userContextId;
        this.#dirty = true;
      }
      used.add(ident.userContextId);
    }
    if (firstRun) {
      // Firefox's own defaults that Toji doesn't use (Banking).
      for (const i of identities) {
        if (!used.has(i.userContextId)) {
          CIS.remove(i.userContextId);
        }
      }
    }
    this.#reindex();
  }

  #reindex() {
    this.#byUserContextId.clear();
    this.#byId.clear();
    for (const c of this.#containers) {
      Object.freeze(c);
      this.#byId.set(c.id, c);
      if (c.userContextId) {
        this.#byUserContextId.set(c.userContextId, c);
      }
    }
  }

  #save() {
    this.#dirty = false;
    const data = { version: 1, containers: this.#containers };
    IOUtils.writeJSON(this.path, data, { tmpPath: `${this.path}.tmp` }).catch(
      e => console.error("[toji:containers] save failed", e)
    );
  }

  #changed() {
    this.#save();
    Services.obs.notifyObservers(null, CONTAINERS_CHANGED_TOPIC);
  }

  /** Copies of every container, in order. */
  list() {
    this.ensureLoaded();
    return this.#containers.map(c => ({ ...c }));
  }

  /** The (frozen) container behind a userContextId, or null. Cheap: the proxy filter calls it per request. */
  byUserContextId(userContextId) {
    this.ensureLoaded();
    if (userContextId > TEMPORARY_BASE) {
      for (const c of this.#temporary.values()) {
        if (c.userContextId === userContextId) {
          return c;
        }
      }
      return null;
    }
    return this.#byUserContextId.get(userContextId) ?? null;
  }

  byId(id) {
    this.ensureLoaded();
    return this.#byId.get(id) ?? this.#temporary.get(id) ?? null;
  }

  /**
   * Replaces the whole list (Settings saves this way). Removed containers lose
   * their identity and data; a container whose route changed is wiped, so no
   * cookie ever carries between direct and Tor.
   */
  async replaceAll(next) {
    this.ensureLoaded();
    const lib = lazy.ContainersLib;
    const CIS = lazy.ContextualIdentityService;
    const incoming = lib.normalizeContainers(next);
    const wipe = [];
    for (const old of this.#containers) {
      const now = incoming.find(c => c.id === old.id);
      if (!now) {
        if (old.userContextId) {
          CIS.remove(old.userContextId);
          wipe.push(old.userContextId);
        }
      } else {
        now.userContextId = old.userContextId;
        if (now.egress !== old.egress && old.userContextId) {
          wipe.push(old.userContextId);
        }
      }
    }
    this.#containers = incoming;
    this.#syncIdentities(false);
    this.#changed();
    await Promise.all(wipe.map(clearUserContext));
    return this.list();
  }

  /** Adds a direct, persistent container named by the user. */
  add(name, avatar) {
    this.ensureLoaded();
    const c = lazy.ContainersLib.newContainer(name, this.#containers, avatar);
    return this.replaceAll([...this.list(), c]).then(() => this.byId(c.id));
  }

  /** "Clear container": drop every cookie, cache and storage it holds. */
  async clear(id) {
    const c = this.byId(id);
    if (!c?.userContextId) {
      return false;
    }
    await clearUserContext(c.userContextId);
    Services.obs.notifyObservers(null, CONTAINER_CLEARED_TOPIC, id);
    return true;
  }

  /** Startup: ephemeral containers begin empty even after a crash. */
  wipeEphemeral() {
    this.ensureLoaded();
    return Promise.all(
      this.#containers
        .filter(c => c.ephemeral && c.userContextId)
        .map(c => clearUserContext(c.userContextId))
    );
  }
}

export const TojiContainers = new ContainerStore();
