import { describe, expect, it } from 'vitest';
import {
  CONTAINER_COLORS,
  DEFAULT_CONTAINERS,
  containerId,
  defaultPrivateContainer,
  FIRST_USER_CONTEXT_ID,
  TEMPORARY_USER_CONTEXT_ID,
  assignUserContextIds,
  newContainer,
  normalizeContainers,
  routeLabel
} from './containers';

describe('defaults', () => {
  it('ship Personal, Work, Shopping, Private and Onion', () => {
    expect(DEFAULT_CONTAINERS.map((c) => c.id)).toEqual(['personal', 'work', 'shopping', 'private', 'onion']);
    const onion = DEFAULT_CONTAINERS.find((c) => c.id === 'onion')!;
    expect(onion.egress).toBe('tor');
    expect(onion.ephemeral).toBe(true);
    expect(DEFAULT_CONTAINERS.find((c) => c.id === 'private')!.ephemeral).toBe(true);
  });

  it('never use purple or violet', () => {
    const hue = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
      const max = Math.max(r, g, b);
      const d = max - Math.min(r, g, b);
      if (!d) return -1;
      const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return h * 60;
    };
    for (const hex of [...CONTAINER_COLORS, ...DEFAULT_CONTAINERS.map((c) => c.color)]) {
      const h = hue(hex);
      expect(h >= 255 && h < 300).toBe(false);
    }
  });
});

describe('normalizeContainers', () => {
  it('returns copies of the defaults for garbage', () => {
    const out = normalizeContainers(null);
    expect(out).toEqual(DEFAULT_CONTAINERS);
    out[0].name = 'changed';
    expect(DEFAULT_CONTAINERS[0].name).toBe('Personal');
  });

  it('drops invalid and duplicate entries and restores missing built-ins', () => {
    const out = normalizeContainers([
      { id: 'work', name: ' Office ' },
      { id: 'work', name: 'Dup' },
      { id: 'Bad Id', name: 'x' },
      { id: 'side', name: '' },
      { id: 'club', name: 'Club', color: '#123456', egress: 'tor', ephemeral: true, userContextId: 9 }
    ]);
    expect(out.map((c) => c.id)).toEqual(['work', 'club', 'personal', 'shopping', 'private', 'onion']);
    expect(out[0]).toMatchObject({ name: 'Office', color: '#10b981', builtin: true, egress: 'direct' });
    expect(out[1]).toMatchObject({ color: '#123456', egress: 'tor', ephemeral: true, userContextId: 9 });
    expect(out[1].builtin).toBeUndefined();
  });

  it('migrates the Electron app avatars', () => {
    const out = normalizeContainers([
      { id: 'personal', name: 'Personal', avatar: '👤' },
      { id: 'mine', name: 'Mine', avatar: 'profiles/work.png' }
    ]);
    expect(out[0].avatar).toBe('profiles/personal.svg');
    expect(out[1].avatar).toBe('profiles/work.svg');
  });

  it('rejects a bad colour and a bad userContextId', () => {
    const [c] = normalizeContainers([{ id: 'x', name: 'X', color: 'purple', userContextId: -1 }]);
    expect(c.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(c.userContextId).toBeUndefined();
  });
});

describe('ids and new containers', () => {
  it('slugifies and de-duplicates', () => {
    expect(containerId('Side Project!', [])).toBe('side-project');
    expect(containerId('Work', [{ id: 'work' }, { id: 'work-2' }])).toBe('work-3');
    expect(containerId('???', [])).toBe('container');
  });

  it('makes direct, persistent containers with a cycling colour', () => {
    const c = newContainer('  Club ', DEFAULT_CONTAINERS);
    expect(c).toMatchObject({ id: 'club', name: 'Club', egress: 'direct', ephemeral: false });
    expect(CONTAINER_COLORS).toContain(c.color);
  });
});

describe('userContextIds', () => {
  it('numbers new containers from Toji\'s own range and keeps existing ones', () => {
    const list = normalizeContainers([{ id: 'personal', name: 'Personal', userContextId: 1 }, { id: 'work', name: 'Work', userContextId: 2 }]);
    const next = assignUserContextIds(list);
    expect(list.find((c) => c.id === 'personal')!.userContextId).toBe(1);
    expect(list.find((c) => c.id === 'work')!.userContextId).toBe(2);
    const fresh = list.filter((c) => !['personal', 'work'].includes(c.id)).map((c) => c.userContextId!);
    expect(fresh).toEqual([FIRST_USER_CONTEXT_ID, FIRST_USER_CONTEXT_ID + 1, FIRST_USER_CONTEXT_ID + 2]);
    expect(next).toBe(FIRST_USER_CONTEXT_ID + 3);
  });

  it('never hands an id out twice, even after its container is gone', () => {
    const list = normalizeContainers(null);
    const next = assignUserContextIds(list, 10_050);
    expect(Math.min(...list.map((c) => c.userContextId!))).toBe(10_050);
    const later = [...list.slice(1), newContainer('Club', list)];
    expect(assignUserContextIds(later, next)).toBe(next + 1);
    expect(later.at(-1)!.userContextId).toBe(next);
  });

  it('re-numbers a duplicate or a throwaway-range id', () => {
    const list = [
      { ...DEFAULT_CONTAINERS[0], userContextId: 10_000 },
      { ...DEFAULT_CONTAINERS[1], userContextId: 10_000 },
      { ...DEFAULT_CONTAINERS[2], userContextId: TEMPORARY_USER_CONTEXT_ID + 3 }
    ];
    assignUserContextIds(list);
    expect(new Set(list.map((c) => c.userContextId)).size).toBe(3);
    expect(list.every((c) => c.userContextId! < TEMPORARY_USER_CONTEXT_ID)).toBe(true);
  });
});

describe('labels and private windows', () => {
  it('describes the route', () => {
    expect(routeLabel({ egress: 'direct', ephemeral: false })).toBe('Standard');
    expect(routeLabel({ egress: 'tor', ephemeral: true })).toBe('Tor · Private');
  });

  it('finds the container for ⌘⇧N', () => {
    expect(defaultPrivateContainer(DEFAULT_CONTAINERS)?.id).toBe('private');
    expect(defaultPrivateContainer(DEFAULT_CONTAINERS.filter((c) => c.id !== 'private'))).toBeUndefined();
  });
});
