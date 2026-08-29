// Containers are Toji's unit of identity. Each one owns a separate Chromium session
// partition, so cookies, localStorage, IndexedDB, cache and HTTP auth never cross
// between them: signing into a site in "Work" leaves "Personal" logged out, and a
// tracker embedded in both sees two unrelated browsers.
//
// The partition name is the security boundary AND the policy declaration:
//
//     [persist:]toji-c-<id>-<egress>
//
// The egress is baked into the name on purpose. The main process applies the proxy
// (and the kill switch) from the partition name alone when Chromium creates the
// session, so there is no window in which a session exists before its policy is
// known — and flipping a container between direct and Tor lands it in a different
// partition entirely, which means no cookie ever carries across an egress change.

export type Egress = 'direct' | 'tor';

export interface Container {
  /** Stable slug; appears in the partition name, so it must stay ASCII/kebab. */
  id: string;
  name: string;
  color: string;
  /** User-chosen profile picture shown in the window/profile picker. */
  avatar?: string;
  /** How this container's traffic leaves the machine. */
  egress: Egress;
  /** In-memory session: everything is gone when the last tab in it closes. */
  ephemeral: boolean;
  /** Built-in containers can be edited but not deleted. */
  builtin?: boolean;
}

export const PROFILE_AVATARS = [
  'profiles/personal.svg',
  'profiles/work.svg',
  'profiles/shopping.svg',
  'profiles/private.svg',
  'profiles/onion.svg'
] as const;

/** Container accent colors. Deliberately no purple/violet. */
export const CONTAINER_COLORS = [
  '#0ea5e9', // sky
  '#10b981', // emerald
  '#f59e0b', // amber
  '#f43f5e', // rose
  '#06b6d4', // cyan
  '#84cc16', // lime
  '#f97316', // orange
  '#64748b'  // slate
];

export const DEFAULT_CONTAINERS: Container[] = [
  { id: 'personal', name: 'Personal', avatar: PROFILE_AVATARS[0], color: '#0ea5e9', egress: 'direct', ephemeral: false, builtin: true },
  { id: 'work', name: 'Work', avatar: PROFILE_AVATARS[1], color: '#10b981', egress: 'direct', ephemeral: false, builtin: true },
  { id: 'shopping', name: 'Shopping', avatar: PROFILE_AVATARS[2], color: '#f59e0b', egress: 'direct', ephemeral: false, builtin: true },
  { id: 'private', name: 'Private', avatar: PROFILE_AVATARS[3], color: '#64748b', egress: 'direct', ephemeral: true, builtin: true },
  { id: 'onion', name: 'Onion', avatar: PROFILE_AVATARS[4], color: '#f43f5e', egress: 'tor', ephemeral: true, builtin: true }
];

export const DEFAULT_CONTAINER_ID = 'personal';

/**
 * The Chromium partition for a container.
 *
 * Ephemeral containers get an in-memory partition (no `persist:`), so Chromium
 * discards the whole store when the last webview using it goes away. `epoch` bumps
 * when the user explicitly clears a container, which strands the old partition and
 * hands the next tab a brand new one.
 */
export function partitionFor(container: Container, epoch = 0): string {
  const base = `toji-c-${container.id}-${container.egress}`;
  const versioned = epoch > 0 ? `${base}-e${epoch}` : base;
  return container.ephemeral ? versioned : `persist:${versioned}`;
}

/**
 * A throwaway session for a single tab ("Reset context"), isolated even from the rest
 * of its own container. Never persisted, but still tagged with the container's egress
 * so the main process applies the same proxy and kill switch to it.
 */
export function tabSessionPartition(container: Container, tabEpoch: number): string {
  return `toji-c-${container.id}-${container.egress}-t${tabEpoch}`;
}

/** Parse a partition name back into the policy the main process must enforce. */
export function parsePartition(partition: string): { id: string; egress: Egress } | null {
  const match = /^(?:persist:)?toji-c-(.+)-(direct|tor)(?:-[et]\d+)?$/.exec(partition);
  return match ? { id: match[1], egress: match[2] as Egress } : null;
}

export const CONTAINERS_STORAGE_KEY = 'toji.containers';

/** Repair persisted profile data and restore built-ins required by app shortcuts. */
export function normalizeContainers(value: unknown): Container[] {
  if (!Array.isArray(value)) return DEFAULT_CONTAINERS;
  const clean: Container[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue;
    const c = candidate as Partial<Container>;
    if (typeof c.id !== 'string' || !/^[a-z0-9-]+$/.test(c.id) || typeof c.name !== 'string' || !c.name.trim()) continue;
    if (clean.some((existing) => existing.id === c.id)) continue;
    const builtin = DEFAULT_CONTAINERS.find((item) => item.id === c.id);
    // Two generations of legacy avatars migrate to the current artwork: the original
    // emoji, and the since-replaced PNG portraits (any profiles/*.png).
    const legacyBuiltinAvatar = builtin && (['👤', '💼', '🛍️', '🕶️', '🧅'].includes(c.avatar ?? '') || /^profiles\/.+\.png$/.test(c.avatar ?? ''));
    const migratedAvatar = typeof c.avatar === 'string' && /^profiles\/.+\.png$/.test(c.avatar) ? c.avatar.replace(/\.png$/, '.svg') : undefined;
    clean.push({
      ...(builtin ?? {
        id: c.id,
        name: c.name.trim(),
        color: CONTAINER_COLORS[clean.length % CONTAINER_COLORS.length],
        egress: 'direct' as const,
        ephemeral: false
      }),
      ...c,
      name: c.name.trim(),
      color: typeof c.color === 'string' && c.color ? c.color : builtin?.color ?? CONTAINER_COLORS[clean.length % CONTAINER_COLORS.length],
      avatar: legacyBuiltinAvatar ? builtin?.avatar : migratedAvatar ?? (typeof c.avatar === 'string' && c.avatar ? c.avatar : builtin?.avatar),
      egress: c.egress === 'tor' ? 'tor' : c.egress === 'direct' ? 'direct' : builtin?.egress ?? 'direct',
      ephemeral: typeof c.ephemeral === 'boolean' ? c.ephemeral : builtin?.ephemeral ?? false,
      builtin: builtin ? true : Boolean(c.builtin)
    });
  }
  for (const builtin of DEFAULT_CONTAINERS) {
    if (!clean.some((container) => container.id === builtin.id)) clean.push({ ...builtin });
  }
  return clean.length ? clean : DEFAULT_CONTAINERS;
}

export function loadContainers(): Container[] {
  try {
    const raw = localStorage.getItem(CONTAINERS_STORAGE_KEY);
    if (!raw) return DEFAULT_CONTAINERS;
    return normalizeContainers(JSON.parse(raw));
  } catch {
    return DEFAULT_CONTAINERS;
  }
}

export function saveContainers(containers: Container[]): void {
  try {
    localStorage.setItem(CONTAINERS_STORAGE_KEY, JSON.stringify(containers));
  } catch {
    // A full/blocked localStorage must not break browsing.
  }
}

/** Slugify a display name into an id that is unique within `existing`. */
export function containerId(name: string, existing: Container[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'container';
  let id = base;
  let n = 2;
  while (existing.some((c) => c.id === id)) id = `${base}-${n++}`;
  return id;
}

export function findContainer(containers: Container[], id: string | undefined): Container {
  return containers.find((c) => c.id === id) ?? containers[0] ?? DEFAULT_CONTAINERS[0];
}
