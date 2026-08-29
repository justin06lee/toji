import { describe, expect, it } from 'vitest';
import {
  CONTAINER_COLORS,
  DEFAULT_CONTAINERS,
  containerId,
  findContainer,
  normalizeContainers,
  parsePartition,
  partitionFor,
  tabSessionPartition,
  type Container
} from './containers';

const make = (over: Partial<Container> = {}): Container => ({
  id: 'personal',
  name: 'Personal',
  color: '#0ea5e9',
  egress: 'direct',
  ephemeral: false,
  ...over
});

describe('partitionFor', () => {
  it('persists non-ephemeral containers', () => {
    expect(partitionFor(make())).toBe('persist:toji-c-personal-direct');
  });

  it('keeps ephemeral containers in memory', () => {
    expect(partitionFor(make({ id: 'private', ephemeral: true }))).toBe('toji-c-private-direct');
  });

  it('encodes the egress, so direct and tor never share a store', () => {
    const direct = partitionFor(make({ id: 'work' }));
    const tor = partitionFor(make({ id: 'work', egress: 'tor' }));
    expect(direct).not.toBe(tor);
  });

  it('strands the old partition when the epoch bumps', () => {
    expect(partitionFor(make(), 2)).toBe('persist:toji-c-personal-direct-e2');
  });
});

describe('parsePartition', () => {
  it('round-trips every default container', () => {
    for (const container of DEFAULT_CONTAINERS) {
      expect(parsePartition(partitionFor(container))).toEqual({ id: container.id, egress: container.egress });
    }
  });

  it('round-trips an epoched partition', () => {
    expect(parsePartition(partitionFor(make({ id: 'onion', egress: 'tor' }), 7))).toEqual({ id: 'onion', egress: 'tor' });
  });

  it('round-trips a per-tab throwaway session', () => {
    const container = make({ id: 'work', egress: 'tor' });
    const partition = tabSessionPartition(container, 3);
    expect(partition).toBe('toji-c-work-tor-t3');
    expect(parsePartition(partition)).toEqual({ id: 'work', egress: 'tor' });
  });

  it('keeps tab sessions distinct from container epochs', () => {
    const container = make({ id: 'private', ephemeral: true });
    expect(tabSessionPartition(container, 2)).not.toBe(partitionFor(container, 2));
  });

  it('parses hyphenated ids without eating the egress', () => {
    expect(parsePartition('persist:toji-c-my-side-project-tor')).toEqual({ id: 'my-side-project', egress: 'tor' });
  });

  it('rejects partitions that are not ours', () => {
    expect(parsePartition('persist:some-other-app')).toBeNull();
    expect(parsePartition('toji-ctx-tab-1-0')).toBeNull();
    // No egress segment → no policy → must not be treated as a container.
    expect(parsePartition('persist:toji-c-personal')).toBeNull();
  });
});

describe('containerId', () => {
  it('slugifies a display name', () => {
    expect(containerId('Side Project!', [])).toBe('side-project');
  });

  it('avoids collisions with existing containers', () => {
    expect(containerId('Work', DEFAULT_CONTAINERS)).toBe('work-2');
  });

  it('falls back when a name has no usable characters', () => {
    expect(containerId('!!!', [])).toBe('container');
  });
});

describe('findContainer', () => {
  it('finds by id and falls back to the first container', () => {
    expect(findContainer(DEFAULT_CONTAINERS, 'work').name).toBe('Work');
    expect(findContainer(DEFAULT_CONTAINERS, 'nope')).toBe(DEFAULT_CONTAINERS[0]);
    expect(findContainer(DEFAULT_CONTAINERS, undefined)).toBe(DEFAULT_CONTAINERS[0]);
  });
});

describe('normalizeContainers', () => {
  it('repairs malformed fields and restores shortcut profiles', () => {
    const result = normalizeContainers([{ id: 'personal', name: '  Home  ', egress: 'broken' }, { id: '../bad', name: 'Bad' }]);
    expect(result.find((container) => container.id === 'personal')).toEqual(
      expect.objectContaining({ name: 'Home', egress: 'direct', ephemeral: false, builtin: true, avatar: 'profiles/personal.svg' })
    );
    expect(result.some((container) => container.id === 'private')).toBe(true);
    expect(result.some((container) => container.id === 'onion')).toBe(true);
    expect(result.some((container) => container.id === '../bad')).toBe(false);
  });

  it('migrates the old built-in emoji avatars to artwork', () => {
    const result = normalizeContainers([{ ...DEFAULT_CONTAINERS[0], avatar: '👤' }]);
    expect(result.find((container) => container.id === 'personal')?.avatar).toBe('profiles/personal.svg');
  });

  it('migrates the retired PNG portraits to the current artwork', () => {
    const result = normalizeContainers([
      { ...DEFAULT_CONTAINERS[0], avatar: 'profiles/personal.png' },
      { id: 'custom', name: 'Custom', egress: 'direct', ephemeral: false, avatar: 'profiles/work.png' }
    ]);
    expect(result.find((container) => container.id === 'personal')?.avatar).toBe('profiles/personal.svg');
    expect(result.find((container) => container.id === 'custom')?.avatar).toBe('profiles/work.svg');
  });

  it('deduplicates ids so one profile maps to one session policy', () => {
    const result = normalizeContainers([
      { id: 'work', name: 'First', egress: 'direct', ephemeral: false },
      { id: 'work', name: 'Second', egress: 'tor', ephemeral: true }
    ]);
    expect(result.filter((container) => container.id === 'work')).toHaveLength(1);
    expect(result.find((container) => container.id === 'work')?.name).toBe('First');
  });
});

describe('palette', () => {
  it('contains no purple or violet', () => {
    expect(CONTAINER_COLORS).not.toContain('#8b5cf6');
    expect(CONTAINER_COLORS).not.toContain('#6366f1');
  });
});
