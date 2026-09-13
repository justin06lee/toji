// Containers for a page that stands on its own (the Gecko browser's about:settings and
// about:welcome), rather than one handed its containers by App.tsx.
//
// With the Gecko bridge the browser owns the list: it is read with containers(), saved
// whole with saveContainers() and followed through onContainersChanged. Without it (a
// plain browser tab during development) the list lives in localStorage, as it does in
// the Electron app.

import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge, type BridgeContainer } from './bridge';
import { DEFAULT_CONTAINER_ID, loadContainers, saveContainers as storeContainers, type Container } from './containers';

/** A container as the browser returns it: the renderer's shape plus what the browser assigns. */
export type SyncedContainer = Container & Pick<BridgeContainer, 'userContextId'>;

const fingerprint = (list: SyncedContainer[]) =>
  JSON.stringify(list.map((c) => [c.id, c.name, c.color, c.avatar ?? null, c.egress, c.ephemeral, Boolean(c.builtin)]));

/** Whether two lists would look the same on screen. */
export const sameContainers = (a: SyncedContainer[], b: SyncedContainer[]): boolean => fingerprint(a) === fingerprint(b);

/**
 * What to hand the browser for `next`, or null when it has to wait. The browser drops a
 * container whose name is blank — which every rename passes through when the old name
 * is deleted before the new one is typed — and a container missing from a save is
 * wiped, cookies and all. So nothing is saved until every container has a name again.
 */
export function containersToSave(next: SyncedContainer[]): SyncedContainer[] | null {
  return next.some((c) => !c.name.trim()) ? null : next;
}

/**
 * Keep what is on screen, taking from the browser's answer only what the browser
 * assigns (a container's Firefox userContextId). Names are not taken back: the browser
 * trims them, and adopting that mid-typing would eat the space just typed.
 */
export function adoptAssigned(local: SyncedContainer[], canonical: SyncedContainer[]): SyncedContainer[] {
  return local.map((c) => {
    const match = canonical.find((x) => x.id === c.id);
    return match && match.userContextId !== undefined && match.userContextId !== c.userContextId ? { ...c, userContextId: match.userContextId } : c;
  });
}

export interface ContainerStore {
  /** Null until the browser has answered (or when it could not). */
  containers: SyncedContainer[] | null;
  setContainers: (next: SyncedContainer[]) => void;
  /** Erase everything a container stores. */
  clearContainer: (id: string) => void;
}

export function useContainerStore(): ContainerStore {
  const [containers, setLocal] = useState<SyncedContainer[] | null>(() => (bridge().containers ? null : loadContainers()));
  // The list as the browser last confirmed it. Null means never loaded, and then nothing
  // may be saved: a save replaces the whole list, so saving one we have not seen would
  // wipe every container missing from it.
  const confirmed = useRef<SyncedContainer[] | null>(null);
  const inflight = useRef(0);

  useEffect(() => {
    const toji = bridge();
    if (!toji.containers) return;
    let alive = true;
    const adopt = (list: SyncedContainer[]) => {
      // While a save is on its way the browser's list is about to be ours anyway, and
      // the echo of our own save carries trimmed names, so neither should overwrite the
      // field being typed in.
      if (!alive || inflight.current > 0) return;
      if (confirmed.current && sameContainers(list, confirmed.current)) return;
      confirmed.current = list;
      setLocal(list);
    };
    toji.containers().then(adopt, () => {});
    const off = toji.onContainersChanged?.(adopt);
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  const setContainers = useCallback((next: SyncedContainer[]) => {
    const toji = bridge();
    if (!toji.containers) {
      setLocal(next);
      storeContainers(next);
      return;
    }
    if (!confirmed.current) return;
    setLocal(next);
    const payload = containersToSave(next);
    if (!payload || !toji.saveContainers) return;
    inflight.current += 1;
    toji
      .saveContainers(payload)
      .then(
        (canonical) => {
          confirmed.current = canonical;
          setLocal((current) => (current ? adoptAssigned(current, canonical) : canonical));
        },
        () => {
          // Refused: show what the browser actually has.
          void toji.containers?.().then((list) => {
            confirmed.current = list;
            setLocal(list);
          }, () => {});
        }
      )
      .finally(() => {
        inflight.current -= 1;
      });
  }, []);

  const clearContainer = useCallback((id: string) => {
    void bridge().clearContainer?.(id);
  }, []);

  return { containers, setContainers, clearContainer };
}

/** The container of the window this page is in; imports file passwords into it. */
export function useWindowContainer(): string {
  const [id, setId] = useState(DEFAULT_CONTAINER_ID);
  useEffect(() => {
    let alive = true;
    void bridge()
      .windowContainer?.()
      .then((current) => alive && current && setId(current), () => {});
    return () => {
      alive = false;
    };
  }, []);
  return id;
}
