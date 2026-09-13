import { describe, expect, it } from 'vitest';
import {
  CONTAINER_COLORS,
  DEFAULT_CONTAINERS,
  containerId,
  defaultPrivateContainer,
  firefoxColor,
  firefoxIcon,
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
    for (const hex of [...CONTAINER_COLORS, ...DEFAULT_CONTAINERS.map((c) => c.color)]) {
      expect(['purple', 'violet']).not.toContain(firefoxColor(hex));
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

describe('Firefox mapping', () => {
  it('picks the nearest identity colour', () => {
    expect(firefoxColor('#0ea5e9')).toBe('blue');
    expect(firefoxColor('#10b981')).toBe('green');
    expect(firefoxColor('#f59e0b')).toBe('orange');
    expect(firefoxColor('#f43f5e')).toBe('red');
    expect(firefoxColor('#06b6d4')).toBe('cyan');
    expect(firefoxColor('#64748b')).toBe('gray');
    expect(firefoxColor('#8b5cf6')).toBe('blue');
    expect(firefoxColor('nope')).toBe('gray');
  });

  it('maps icons', () => {
    expect(firefoxIcon({ id: 'work', egress: 'direct', ephemeral: false })).toBe('briefcase');
    expect(firefoxIcon({ id: 'x', egress: 'direct', ephemeral: true })).toBe('fence');
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
