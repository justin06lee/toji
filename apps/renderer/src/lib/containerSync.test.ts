import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTAINERS } from './containers';
import { adoptAssigned, containersToSave, sameContainers, type SyncedContainer } from './containerSync';

const list = (): SyncedContainer[] => DEFAULT_CONTAINERS.map((c) => ({ ...c }));

describe('containersToSave', () => {
  it('passes a list where every container has a name', () => {
    const next = list();
    expect(containersToSave(next)).toBe(next);
  });

  it('holds back a list with a blank name, which the browser would drop and wipe', () => {
    const next = list();
    next[1] = { ...next[1], name: '   ' };
    expect(containersToSave(next)).toBeNull();
  });
});

describe('sameContainers', () => {
  it('ignores key order and browser-assigned ids', () => {
    const a = list();
    const b = list().map((c, i) => ({ userContextId: i + 1, ephemeral: c.ephemeral, egress: c.egress, builtin: c.builtin, avatar: c.avatar, color: c.color, name: c.name, id: c.id }));
    expect(sameContainers(a, b)).toBe(true);
  });

  it('sees a rename, a route change and a removal', () => {
    const base = list();
    expect(sameContainers(base, base.map((c) => (c.id === 'work' ? { ...c, name: 'Job' } : c)))).toBe(false);
    expect(sameContainers(base, base.map((c) => (c.id === 'work' ? { ...c, egress: 'tor' as const } : c)))).toBe(false);
    expect(sameContainers(base, base.slice(1))).toBe(false);
  });
});

describe('adoptAssigned', () => {
  it('takes the userContextId the browser assigned, and keeps names as typed', () => {
    const local = [...list(), { id: 'side', name: 'Side ', color: '#0ea5e9', egress: 'direct' as const, ephemeral: false }];
    const canonical = local.map((c, i) => ({ ...c, name: c.name.trim(), userContextId: 10 + i }));
    const adopted = adoptAssigned(local, canonical);
    expect(adopted.map((c) => c.userContextId)).toEqual(canonical.map((c) => c.userContextId));
    expect(adopted[adopted.length - 1].name).toBe('Side ');
  });

  it('returns the same objects when nothing new was assigned', () => {
    const local = list().map((c, i) => ({ ...c, userContextId: i }));
    const adopted = adoptAssigned(local, local.map((c) => ({ ...c })));
    adopted.forEach((c, i) => expect(c).toBe(local[i]));
  });

  it('keeps containers the browser has not answered for yet', () => {
    const local = [...list(), { id: 'new-one', name: 'New', color: '#0ea5e9', egress: 'direct' as const, ephemeral: false }];
    expect(adoptAssigned(local, list())).toHaveLength(local.length);
  });
});
