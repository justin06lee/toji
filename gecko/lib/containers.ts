// Containers are Toji's unit of identity: each one is a Gecko contextual
// identity (userContextId), so cookies, storage, caches and HTTP auth never cross
// between them. One window belongs to one container for its whole life.
//
// This module is the pure model, shared by the chrome module
// (resource:///modules/toji/lib/containers.sys.mjs) and Toji's pages and tests.

export type Egress = 'direct' | 'tor';

export interface Container {
  /** Stable slug. */
  id: string;
  name: string;
  /** Accent, as #rrggbb. */
  color: string;
  /** Profile picture, relative to Toji's content ("profiles/work.svg"). */
  avatar?: string;
  /** How this container's traffic leaves the machine. */
  egress: Egress;
  /** Private windows, wiped when the container's last window closes and at startup. */
  ephemeral: boolean;
  /** Built-in containers can be edited but not deleted. */
  builtin?: boolean;
  /** The Gecko contextual identity backing this container. */
  userContextId?: number;
}

export const PROFILE_AVATARS = [
  'profiles/personal.svg',
  'profiles/work.svg',
  'profiles/shopping.svg',
  'profiles/private.svg',
  'profiles/onion.svg'
] as const;

/** Container accent colours. Deliberately no purple or violet. */
export const CONTAINER_COLORS = [
  '#0ea5e9', // sky
  '#10b981', // emerald
  '#f59e0b', // amber
  '#f43f5e', // rose
  '#06b6d4', // cyan
  '#84cc16', // lime
  '#f97316', // orange
  '#64748b' // slate
];

export const DEFAULT_CONTAINERS: Container[] = [
  { id: 'personal', name: 'Personal', avatar: PROFILE_AVATARS[0], color: '#0ea5e9', egress: 'direct', ephemeral: false, builtin: true },
  { id: 'work', name: 'Work', avatar: PROFILE_AVATARS[1], color: '#10b981', egress: 'direct', ephemeral: false, builtin: true },
  { id: 'shopping', name: 'Shopping', avatar: PROFILE_AVATARS[2], color: '#f59e0b', egress: 'direct', ephemeral: false, builtin: true },
  { id: 'private', name: 'Private', avatar: PROFILE_AVATARS[3], color: '#64748b', egress: 'direct', ephemeral: true, builtin: true },
  { id: 'onion', name: 'Onion', avatar: PROFILE_AVATARS[4], color: '#f43f5e', egress: 'tor', ephemeral: true, builtin: true }
];

export const DEFAULT_CONTAINER_ID = 'personal';

/** Firefox's own default identities, by their l10n id, mapped to Toji's. */
export const FIREFOX_DEFAULT_IDENTITIES: Record<string, string> = {
  'user-context-personal': 'personal',
  'user-context-work': 'work',
  'user-context-shopping': 'shopping'
};

const HEX = /^#[0-9a-f]{6}$/i;

/** Repairs persisted containers and restores any missing built-in. */
export function normalizeContainers(value: unknown): Container[] {
  if (!Array.isArray(value)) return DEFAULT_CONTAINERS.map((c) => ({ ...c }));
  const clean: Container[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue;
    const c = candidate as Partial<Container>;
    if (typeof c.id !== 'string' || !/^[a-z0-9-]+$/.test(c.id) || typeof c.name !== 'string' || !c.name.trim()) continue;
    if (clean.some((existing) => existing.id === c.id)) continue;
    const builtin = DEFAULT_CONTAINERS.find((item) => item.id === c.id);
    // Legacy avatars from the Electron app: emoji, then PNG portraits.
    const legacyBuiltinAvatar = builtin && (['👤', '💼', '🛍️', '🕶️', '🧅'].includes(c.avatar ?? '') || /^profiles\/.+\.png$/.test(c.avatar ?? ''));
    const migratedAvatar = typeof c.avatar === 'string' && /^profiles\/.+\.png$/.test(c.avatar) ? c.avatar.replace(/\.png$/, '.svg') : undefined;
    const fallbackColor = builtin?.color ?? CONTAINER_COLORS[clean.length % CONTAINER_COLORS.length];
    const container: Container = {
      id: c.id,
      name: c.name.trim(),
      color: typeof c.color === 'string' && HEX.test(c.color) ? c.color.toLowerCase() : fallbackColor,
      avatar: legacyBuiltinAvatar ? builtin?.avatar : migratedAvatar ?? (typeof c.avatar === 'string' && c.avatar ? c.avatar : builtin?.avatar),
      egress: c.egress === 'tor' ? 'tor' : c.egress === 'direct' ? 'direct' : builtin?.egress ?? 'direct',
      ephemeral: typeof c.ephemeral === 'boolean' ? c.ephemeral : builtin?.ephemeral ?? false,
      builtin: builtin ? true : undefined
    };
    if (typeof c.userContextId === 'number' && Number.isInteger(c.userContextId) && c.userContextId > 0) {
      container.userContextId = c.userContextId;
    }
    if (!container.builtin) delete container.builtin;
    clean.push(container);
  }
  for (const builtin of DEFAULT_CONTAINERS) {
    if (!clean.some((container) => container.id === builtin.id)) clean.push({ ...builtin });
  }
  return clean;
}

/** Slugifies a display name into an id unique within `existing`. */
export function containerId(name: string, existing: Pick<Container, 'id'>[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'container';
  let id = base;
  let n = 2;
  while (existing.some((c) => c.id === id)) id = `${base}-${n++}`;
  return id;
}

/** A fresh direct, persistent container — named by the user or after an imported profile. */
export function newContainer(name: string, existing: Container[], avatar?: string): Container {
  return {
    id: containerId(name, existing),
    name: name.trim(),
    avatar: avatar ?? PROFILE_AVATARS[existing.length % PROFILE_AVATARS.length],
    color: CONTAINER_COLORS[existing.length % CONTAINER_COLORS.length],
    egress: 'direct',
    ephemeral: false
  };
}

export function findContainer(containers: Container[], id: string | undefined | null): Container | undefined {
  return containers.find((c) => c.id === id);
}

/** What the picker says under a container's name. */
export function routeLabel(c: Pick<Container, 'egress' | 'ephemeral'>): string {
  if (c.egress === 'tor' && c.ephemeral) return 'Tor · Private';
  if (c.egress === 'tor') return 'Tor';
  if (c.ephemeral) return 'Private';
  return 'Standard';
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}

/**
 * The nearest of Firefox's identity colour names, for the few Firefox surfaces
 * Toji doesn't restyle. Toji draws the real hex itself. Purple and violet are
 * never chosen.
 */
export function firefoxColor(hex: string): string {
  if (!HEX.test(hex)) return 'gray';
  const { h, s } = hexToHsl(hex);
  if (s < 0.2) return 'gray';
  if (h < 15 || h >= 345) return 'red';
  if (h < 40) return 'orange';
  if (h < 70) return 'yellow';
  if (h < 165) return 'green';
  if (h < 195) return 'cyan';
  if (h < 290) return 'blue';
  return 'pink';
}

/** Firefox identity icon for a container (only used by Firefox's own surfaces). */
export function firefoxIcon(c: Pick<Container, 'id' | 'egress' | 'ephemeral'>): string {
  const byId: Record<string, string> = {
    personal: 'fingerprint',
    work: 'briefcase',
    shopping: 'cart',
    private: 'fence',
    onion: 'circle'
  };
  return byId[c.id] ?? (c.ephemeral ? 'fence' : 'circle');
}

/** The container a new private window gets when nothing chose one (⌘⇧N). */
export function defaultPrivateContainer(containers: Container[]): Container | undefined {
  return containers.find((c) => c.id === 'private' && c.ephemeral) ?? containers.find((c) => c.ephemeral && c.egress === 'direct');
}
