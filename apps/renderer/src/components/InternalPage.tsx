import { BookMarked, Boxes, Brain, Check, Compass, Copy, Cpu, Download, EyeOff, FileText, KeyRound, Loader2, Paperclip, Plus, Puzzle, RefreshCw, Route, Search, Star, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  addMemory,
  addReference,
  deleteBookmark,
  deleteMemoryFact,
  deleteReference,
  getAgentModels,
  getAgents,
  getBookmarks,
  getCerebrasModels,
  getImportBrowsers,
  getMemoryFacts,
  getPinnedMemory,
  getReferences,
  getSettings,
  importBookmarks,
  saveSettings,
  savePinnedMemory,
  type Bookmark,
  type DetectedBrowser,
  type MemoryFact,
  type PinnedMemory,
  type ReferenceDoc
} from '../lib/api';
import type { AgentChoice, AgentsStatus, CerebrasModels, InternalPage as InternalPageKind, ModelCatalog, ThinkingLevel, UserSettings } from '../types';
import { bridge, type TorStatus, type VaultEntry, type VaultStatus } from '../lib/bridge';
import { CONTAINER_COLORS, PROFILE_AVATARS, containerId as makeContainerId, type Container, type Egress } from '../lib/containers';
import { VaultUnavailable } from './VaultBar';
import { ProfileAvatar } from './WindowProfilePicker';
import { SEARCH_ENGINES, type SearchEngineId } from '../lib/nav';
import { Dropdown, type DropdownOption } from './Dropdown';


interface InternalPageProps {
  page: InternalPageKind;
  onOpenUrl: (url: string) => void;
  onGetStarted: () => void;
  containers: Container[];
  onContainersChange: (containers: Container[]) => void;
  onClearContainer: (containerId: string) => void;
}

export function InternalPage({ page, onOpenUrl, onGetStarted, containers, onContainersChange, onClearContainer }: InternalPageProps) {
  return (
    <div className="h-full w-full overflow-y-auto bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="mx-auto w-[min(760px,92vw)] px-6 py-12">
        {page === 'welcome' ? (
          <WelcomeView onOpenUrl={onOpenUrl} onGetStarted={onGetStarted} />
        ) : (
          <SettingsView containers={containers} onContainersChange={onContainersChange} onClearContainer={onClearContainer} />
        )}
      </div>
    </div>
  );
}

const ICON = `${import.meta.env.BASE_URL}toji-round.png`;

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-neutral-500">{icon}</span>
        <h2 className="text-[15px] font-semibold">{title}</h2>
      </div>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Welcome / onboarding
// ---------------------------------------------------------------------------
function WelcomeView({ onOpenUrl, onGetStarted }: { onOpenUrl: (url: string) => void; onGetStarted: () => void }) {
  const [isDefault, setIsDefault] = useState<boolean | null>(null);
  const [settingDefault, setSettingDefault] = useState(false);
  const [browsers, setBrowsers] = useState<DetectedBrowser[]>([]);
  const [importing, setImporting] = useState<string | null>(null);
  const [importMsg, setImportMsg] = useState<string>('');
  const [extensions, setExtensions] = useState<{ id: string; name: string }[]>([]);
  const [webStoreOk, setWebStoreOk] = useState(false);

  useEffect(() => {
    void bridge().isDefaultBrowser?.().then((v) => setIsDefault(Boolean(v)));
    void getImportBrowsers().then((r) => setBrowsers(r.browsers)).catch(() => {});
    void bridge().listExtensions?.().then((e) => setExtensions(e ?? [])).catch(() => {});
    void bridge().webStoreAvailable?.().then((v) => setWebStoreOk(Boolean(v))).catch(() => {});
  }, []);

  const makeDefault = async () => {
    setSettingDefault(true);
    try {
      const ok = (await bridge().setDefaultBrowser?.()) ?? false;
      setIsDefault(ok || (await bridge().isDefaultBrowser?.()) || false);
    } finally {
      setSettingDefault(false);
    }
  };

  const doImport = async (id: string) => {
    setImporting(id);
    setImportMsg('');
    try {
      const r = await importBookmarks(id);
      setImportMsg(`Imported ${r.added} bookmark${r.added === 1 ? '' : 's'}${r.found && !r.added ? ' (already imported)' : ''}.`);
    } catch {
      setImportMsg('Import failed.');
    } finally {
      setImporting(null);
    }
  };

  const addExt = async () => {
    const res = await bridge().addExtension?.();
    if (res && 'name' in res) setExtensions((e) => [...e, res]);
    else void bridge().listExtensions?.().then((e) => setExtensions(e ?? []));
  };

  return (
    <div>
      <div className="mb-10 flex flex-col items-center text-center">
        <img src={ICON} alt="Toji" className="mb-4 h-16 w-16 rounded-[18px] shadow-sm" />
        <h1 className="text-3xl font-semibold tracking-tight">Welcome to Toji</h1>
        <p className="mt-2 max-w-md text-[14px] text-neutral-500">An agent-first browser. Bring your own local coding agent, ask it to do things on any page, and keep your research inside familiar browser tabs.</p>
      </div>

      {/* Extensions area lives at the top, mirroring a browser toolbar. */}
      <Section icon={<Puzzle size={16} />} title="Extensions">
        <div className="rounded-xl border border-black/10 p-3 dark:border-white/10">
          <div className="flex min-h-9 flex-wrap items-center gap-2">
            {extensions.length === 0 && <span className="text-[12.5px] text-neutral-400">No extensions yet.</span>}
            {extensions.map((e) => (
              <span key={e.id} className="inline-flex items-center gap-1.5 rounded-lg bg-black/[0.05] px-2 py-1 text-[12px] dark:bg-white/10">
                <Puzzle size={12} /> {e.name}
              </span>
            ))}
            {webStoreOk && (
              <button type="button" onClick={() => onOpenUrl('https://chromewebstore.google.com/')} className="inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-2.5 py-1 text-[12px] font-medium text-white transition hover:opacity-85 dark:bg-white dark:text-neutral-900">
                <Puzzle size={13} /> Chrome Web Store
              </button>
            )}
            <button type="button" onClick={() => void addExt()} className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-black/15 px-2.5 py-1 text-[12px] text-neutral-600 transition hover:border-black/30 dark:border-white/15 dark:text-neutral-300">
              <Plus size={13} /> Load unpacked…
            </button>
          </div>
          <p className="mt-2 text-[11.5px] text-neutral-400">
            {webStoreOk
              ? 'Open the Chrome Web Store and click “Add to Chrome” to install — or load an unpacked folder. Extensions apply across all tabs. Support is experimental.'
              : 'Load an unpacked Chrome extension folder. (Web Store integration unavailable in this build.)'}
          </p>
        </div>
      </Section>

      <Section icon={<Star size={16} />} title="Make Toji your default browser">
        <div className="flex items-center justify-between rounded-xl border border-black/10 p-3 dark:border-white/10">
          <span className="text-[13px] text-neutral-500">{isDefault ? 'Toji is your default browser.' : 'Open links from other apps in Toji.'}</span>
          <button
            type="button"
            onClick={() => void makeDefault()}
            disabled={settingDefault || isDefault === true}
            className="inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-3.5 py-1.5 text-[12.5px] font-medium text-white transition enabled:hover:opacity-85 disabled:opacity-40 dark:bg-white dark:text-neutral-900"
          >
            {settingDefault && <Loader2 size={12} className="animate-spin" />}
            {isDefault ? <><Check size={13} /> Default</> : 'Set as default'}
          </button>
        </div>
      </Section>

      <Section icon={<Download size={16} />} title="Import from another browser">
        <div className="rounded-xl border border-black/10 p-3 dark:border-white/10">
          <div className="space-y-2">
            {browsers.length === 0 && <span className="text-[12.5px] text-neutral-400">No other browsers detected.</span>}
            {browsers.map((b) => {
              // Safari stores bookmarks in a binary plist we don't parse yet.
              const unsupported = b.id === 'safari';
              return (
                <div key={b.id} className="flex items-center justify-between">
                  <span className={`text-[13px] ${b.available && !unsupported ? '' : 'text-neutral-400'}`}>{b.name}</span>
                  {unsupported ? (
                    <span className="text-[11.5px] text-neutral-400">Not supported yet</span>
                  ) : (
                    <button
                      type="button"
                      disabled={!b.available || importing !== null}
                      onClick={() => void doImport(b.id)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-black/10 px-2.5 py-1 text-[12px] transition enabled:hover:border-black/30 disabled:opacity-40 dark:border-white/15"
                    >
                      {importing === b.id ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} Import bookmarks
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {importMsg && <p className="mt-2 text-[12px] text-emerald-600 dark:text-emerald-400">{importMsg}</p>}
        </div>
        <BookmarksList onOpenUrl={onOpenUrl} />
      </Section>

      <div className="mt-10 flex justify-center">
        <button type="button" onClick={onGetStarted} className="inline-flex items-center gap-2 rounded-xl bg-neutral-900 px-5 py-2.5 text-[14px] font-medium text-white transition hover:opacity-85 dark:bg-white dark:text-neutral-900">
          <Compass size={16} /> Start browsing
        </button>
      </div>
    </div>
  );
}

function BookmarksList({ onOpenUrl }: { onOpenUrl: (url: string) => void }) {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const refresh = useCallback(() => void getBookmarks().then((r) => setBookmarks(r.bookmarks)).catch(() => {}), []);
  useEffect(() => refresh(), [refresh]);
  if (bookmarks.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[12px] text-neutral-400">
        <BookMarked size={13} /> {bookmarks.length} imported
      </div>
      <div className="flex flex-wrap gap-1.5">
        {bookmarks.slice(0, 60).map((b) => (
          <span key={b.id} className="group inline-flex max-w-[240px] items-center gap-1.5 rounded-lg bg-black/[0.04] px-2 py-1 text-[12px] dark:bg-white/[0.06]">
            <button type="button" onClick={() => onOpenUrl(b.url)} className="truncate hover:underline" title={b.url}>
              {b.title || b.url}
            </button>
            <button type="button" aria-label="Remove" onClick={() => void deleteBookmark(b.id).then(refresh)} className="shrink-0 text-neutral-400 opacity-0 transition group-hover:opacity-100 hover:text-red-500">
              <X size={11} />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const THINKING: DropdownOption<ThinkingLevel>[] = [
  { value: 'default', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
];

/**
 * The one status mark used across settings: a small neutral dot. Filled = active,
 * hollow = inactive, pulsing hollow = in progress. No traffic-light colors.
 */
function StatusDot({ state }: { state: 'on' | 'busy' | 'off' }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
        state === 'on'
          ? 'bg-neutral-900 dark:bg-white'
          : state === 'busy'
            ? 'animate-pulse border border-neutral-400 dark:border-neutral-500'
            : 'border border-neutral-300 dark:border-neutral-600'
      }`}
    />
  );
}

function SettingsView({
  containers,
  onContainersChange,
  onClearContainer
}: {
  containers: Container[];
  onContainersChange: (containers: Container[]) => void;
  onClearContainer: (containerId: string) => void;
}) {
  return (
    <div>
      <h1 className="mb-8 text-2xl font-semibold tracking-tight">Settings</h1>
      <ContainersSettings containers={containers} onChange={onContainersChange} onClear={onClearContainer} />
      <TorSettings />
      <VaultSettings containers={containers} />
      <AgentSettings />
      <SearchSettings />
      <MemorySettings />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------
const EGRESS_OPTIONS: DropdownOption<Egress>[] = [
  { value: 'direct', label: 'Direct', hint: 'normal connection' },
  { value: 'tor', label: 'Tor', hint: 'onion-routed' }
];

function ContainersSettings({ containers, onChange, onClear }: { containers: Container[]; onChange: (c: Container[]) => void; onClear: (id: string) => void }) {
  const [newName, setNewName] = useState('');

  const patch = (id: string, next: Partial<Container>) => onChange(containers.map((c) => (c.id === id ? { ...c, ...next } : c)));

  const add = () => {
    const name = newName.trim();
    if (!name) return;
    onChange([
      ...containers,
      {
        id: makeContainerId(name, containers),
        name,
        avatar: PROFILE_AVATARS[containers.length % PROFILE_AVATARS.length],
        color: CONTAINER_COLORS[containers.length % CONTAINER_COLORS.length],
        egress: 'direct',
        ephemeral: false
      }
    ]);
    setNewName('');
  };

  return (
    <Section icon={<Boxes size={15} />} title="Containers">
      <p className="mb-4 text-[13px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        Each container is a separate identity with its own cookies, storage and cache. A site you sign into in one container
        is signed out in every other, and a tracker embedded in both sees two unrelated browsers. Changing a container&rsquo;s
        connection moves it to a fresh session, so nothing carries across.
      </p>

      <div className="divide-y divide-black/[0.07] rounded-xl border border-black/10 dark:divide-white/10 dark:border-white/12">
        {containers.map((container) => (
          <div key={container.id} className="flex flex-wrap items-center gap-3 p-3">
            <button
              type="button"
              onClick={() => {
                const current = PROFILE_AVATARS.indexOf(container.avatar as (typeof PROFILE_AVATARS)[number]);
                patch(container.id, { avatar: PROFILE_AVATARS[(current + 1) % PROFILE_AVATARS.length] });
              }}
              aria-label={`${container.name} profile picture`}
              title="Change profile picture"
              className="shrink-0 rounded-full outline-none transition hover:scale-105 focus-visible:ring-2 focus-visible:ring-neutral-400"
            >
              <ProfileAvatar container={container} />
            </button>
            <input
              type="color"
              aria-label={`${container.name} color`}
              value={container.color}
              onChange={(e) => patch(container.id, { color: e.target.value })}
              className="swatch h-6 w-6 shrink-0 cursor-pointer"
            />
            <input
              value={container.name}
              onChange={(e) => patch(container.id, { name: e.target.value })}
              aria-label="Container name"
              className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 text-[13px] outline-none hover:border-black/10 focus:border-black/30 dark:hover:border-white/12 dark:focus:border-white/30"
            />
            <Dropdown
              value={container.egress}
              options={EGRESS_OPTIONS}
              onChange={(egress) => patch(container.id, { egress })}
              className="w-[150px] shrink-0"
            />
            <button
              type="button"
              onClick={() => patch(container.id, { ephemeral: !container.ephemeral })}
              title={container.ephemeral ? 'Ephemeral: discarded when the last tab closes' : 'Persistent: stays signed in across restarts'}
              className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] transition ${
                container.ephemeral
                  ? 'border-black/20 bg-black/[0.05] dark:border-white/25 dark:bg-white/10'
                  : 'border-black/10 text-neutral-500 hover:border-black/20 dark:border-white/12 dark:text-neutral-400 dark:hover:border-white/25'
              }`}
            >
              <EyeOff size={12} />
              Ephemeral
            </button>
            <button
              type="button"
              onClick={() => onClear(container.id)}
              title={`Erase everything stored in ${container.name}`}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-neutral-400 transition hover:bg-black/[0.06] hover:text-neutral-900 dark:hover:bg-white/10 dark:hover:text-white"
            >
              <Trash2 size={13} />
            </button>
            <button
              type="button"
              disabled={container.builtin}
              onClick={() => onChange(containers.filter((c) => c.id !== container.id))}
              title={container.builtin ? 'Built-in containers can be renamed but not removed' : `Delete ${container.name}`}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-neutral-400 transition hover:bg-black/[0.06] hover:text-neutral-900 disabled:pointer-events-none disabled:opacity-25 dark:hover:bg-white/10 dark:hover:text-white"
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="New container name"
          className="min-w-0 flex-1 rounded-lg border border-black/10 bg-transparent px-2.5 py-1.5 text-[13px] outline-none focus:border-black/30 dark:border-white/12 dark:focus:border-white/30"
        />
        <button
          type="button"
          onClick={add}
          disabled={!newName.trim()}
          className="inline-flex h-[34px] shrink-0 items-center gap-1.5 rounded-lg bg-neutral-900 px-3 text-[13px] text-white transition hover:opacity-85 disabled:opacity-35 dark:bg-white dark:text-neutral-900"
        >
          <Plus size={13} />
          Add
        </button>
      </div>

      <p className="mt-3 text-[12px] leading-relaxed text-neutral-400">
        Containers set to Tor stay offline until Tor connects &mdash; they will not fall back to a direct connection.
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Tor
// ---------------------------------------------------------------------------
const OFFLINE_STATUS: TorStatus = { ready: false, state: 'off', progress: 0, detail: 'Tor is not running' };

function TorSettings() {
  const [status, setStatus] = useState<TorStatus>(OFFLINE_STATUS);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void bridge().torStatus?.().then((s) => s && setStatus(s));
    return bridge().onTorStatus?.(setStatus);
  }, []);

  const run = (fn: (() => Promise<unknown>) | undefined) => async () => {
    if (!fn) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const running = status.state !== 'off' && status.state !== 'error';

  return (
    <Section icon={<Route size={15} />} title="Tor">
      <p className="mb-4 text-[13px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        Toji drives the real Tor client rather than implementing onion routing itself. Containers set to Tor send every
        request through it &mdash; and while Tor is unavailable their traffic is cancelled outright, never quietly sent over
        the direct connection.
      </p>

      <div className="rounded-xl border border-black/10 p-3 dark:border-white/12">
        <div className="flex flex-wrap items-center gap-3">
          <StatusDot state={status.ready ? 'on' : running ? 'busy' : 'off'} />
          <span className="min-w-0 flex-1 text-[13px]">
            {status.detail}
            {status.source === 'external' && <span className="ml-1.5 text-[11px] text-neutral-400">(external)</span>}
          </span>
          {running && !status.ready && <span className="shrink-0 text-[12px] tabular-nums text-neutral-400">{status.progress}%</span>}

          {status.ready && (
            <button type="button" onClick={run(bridge().torNewCircuit)} disabled={busy} className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-black/10 px-2.5 text-[12px] transition hover:border-black/25 disabled:opacity-40 dark:border-white/12 dark:hover:border-white/30">
              <RefreshCw size={12} className={busy ? 'animate-spin' : undefined} />
              New circuit
            </button>
          )}
          <button
            type="button"
            onClick={run(running ? bridge().torStop : bridge().torStart)}
            disabled={busy}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-neutral-900 px-3 text-[12px] text-white transition hover:opacity-85 disabled:opacity-40 dark:bg-white dark:text-neutral-900"
          >
            {busy && <Loader2 size={12} className="animate-spin" />}
            {running ? 'Stop Tor' : 'Start Tor'}
          </button>
        </div>

        {status.ready && !status.isolated && (
          <p className="mt-3 border-t border-black/[0.07] pt-3 text-[12px] leading-relaxed text-neutral-500 dark:border-white/10 dark:text-neutral-400">
            Using a Tor instance that was already running. It offers a single SOCKS port, and Chromium cannot send SOCKS
            credentials, so every Tor container shares its circuits &mdash; they can be linked by their common exit. For
            per-container circuits, quit the other Tor and let Toji manage its own.
          </p>
        )}

        {status.state === 'error' && (
          <p className="mt-3 border-t border-black/[0.07] pt-3 text-[12px] leading-relaxed text-neutral-500 dark:border-white/10 dark:text-neutral-400">
            Toji looks for a <code className="rounded bg-black/[0.06] px-1 py-0.5 font-mono text-[11px] dark:bg-white/10">tor</code> binary in the app bundle and the usual
            install locations, then for a Tor already listening on 9050 or 9150. On macOS,{' '}
            <code className="rounded bg-black/[0.06] px-1 py-0.5 font-mono text-[11px] dark:bg-white/10">brew install tor</code> is enough; starting Tor Browser also works.
          </p>
        )}
      </div>

      <p className="mt-3 text-[12px] leading-relaxed text-neutral-400">
        Tor protects what the network can see about you. It does not make this browser indistinguishable from other
        browsers &mdash; for a threat model where that matters, use the Tor Browser.
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------
function VaultSettings({ containers }: { containers: Container[] }) {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [generated, setGenerated] = useState('');
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    const s = await bridge().vaultStatus?.();
    if (s) setStatus(s);
    const listed = await bridge().vaultList?.();
    if (listed?.ok) setEntries(listed.value);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remove = async (id: string) => {
    await bridge().vaultDelete?.(id);
    void refresh();
  };

  const generate = async () => {
    const password = await bridge().vaultGenerate?.(20);
    if (password) {
      setGenerated(password);
      setCopied(false);
    }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(generated);
    setCopied(true);
  };

  const nameOf = (containerId: string | null) => containers.find((c) => c.id === containerId) ?? null;

  return (
    <Section icon={<KeyRound size={15} />} title="Passwords">
      <p className="mb-4 text-[13px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        Saved logins are encrypted with your operating system&rsquo;s keychain and are scoped to the container they were saved
        in &mdash; a credential saved in Work is never offered in Personal. Passwords are held in Toji&rsquo;s main process and
        are filled straight into the page: the browser UI (and the AI agent driving it) can see which accounts exist, but
        never the passwords themselves.
      </p>

      {status && !status.available ? (
        <VaultUnavailable message={status.error ?? 'The vault is unavailable on this system.'} />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <button type="button" onClick={generate} className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-black/10 px-2.5 text-[12px] transition hover:border-black/25 dark:border-white/12 dark:hover:border-white/30">
              <RefreshCw size={12} />
              Generate a password
            </button>
            {generated && (
              <button type="button" onClick={copy} title="Copy to clipboard" className="inline-flex h-8 min-w-0 items-center gap-2 rounded-lg border border-black/10 px-2.5 font-mono text-[12px] transition hover:border-black/25 dark:border-white/12 dark:hover:border-white/30">
                <span className="truncate">{generated}</span>
                {copied ? <Check size={12} className="shrink-0 text-neutral-500" /> : <Copy size={12} className="shrink-0 text-neutral-400" />}
              </button>
            )}
          </div>

          {entries.length === 0 ? (
            <p className="rounded-xl border border-dashed border-black/10 p-4 text-center text-[13px] text-neutral-400 dark:border-white/12">
              No saved logins yet. Sign in to a site and Toji will offer to save it.
            </p>
          ) : (
            <div className="divide-y divide-black/[0.07] rounded-xl border border-black/10 dark:divide-white/10 dark:border-white/12">
              {entries.map((entry) => {
                const container = nameOf(entry.containerId);
                return (
                  <div key={entry.id} className="flex items-center gap-3 p-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px]">{entry.origin.replace(/^https?:\/\//, '')}</p>
                      <p className="truncate text-[12px] text-neutral-400">{entry.username || '(no username)'}</p>
                    </div>
                    {container && (
                      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-black/10 px-2 py-0.5 text-[11px] text-neutral-500 dark:border-white/12 dark:text-neutral-400">
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: container.color }} />
                        {container.name}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => remove(entry.id)}
                      aria-label={`Delete the login for ${entry.origin}`}
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-neutral-400 transition hover:bg-black/[0.06] hover:text-neutral-900 dark:hover:bg-white/10 dark:hover:text-white"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </Section>
  );
}

// A single provider field: label + input; password-style for keys (the server returns
// keys MASKED — sending the mask back leaves the stored key untouched).
function ProviderField({ label, value, onChange, placeholder, secret }: { label: string; value: string; onChange: (v: string) => void; placeholder: string; secret?: boolean }) {
  return (
    <label className="block flex-1">
      <span className="mb-1 block text-[11px] text-neutral-400">{label}</span>
      <input
        type={secret ? 'password' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className="w-full rounded-lg border border-black/10 bg-transparent px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-black/30 dark:border-white/12 dark:focus:border-white/30"
      />
    </label>
  );
}

type AgentPick = AgentChoice | 'alpaca';

const AGENT_OPTIONS: DropdownOption<AgentPick>[] = [
  { value: 'yagami', label: 'Yagami', hint: 'automatic' },
  { value: 'alpaca', label: 'Alpaca', hint: 'under construction', disabled: true },
  { value: 'cerebras', label: 'Cerebras', hint: 'hosted API' },
  { value: 'local', label: 'Custom endpoint', hint: 'URL + key' },
  { value: 'off', label: 'Off' }
];

/**
 * The model picker: every model every installed coding CLI reports, grouped by
 * harness. Options carry the QUALIFIED `provider:model` id — a bare model name is
 * routed to the default provider (Claude Code), so picking a Codex or Gemini model
 * by its plain name used to fail on every call.
 */
function ModelPicker({ value, catalog, loading, onChange }: { value: string; catalog: ModelCatalog | null; loading: boolean; onChange: (id: string) => void }) {
  const options: DropdownOption<string>[] = [{ value: '', label: 'Auto', hint: 'the default harness', group: 'Automatic' }];
  for (const model of catalog?.models ?? []) {
    options.push({
      value: model.id,
      label: model.label,
      ...(model.resolvedModel && model.resolvedModel !== model.model ? { hint: model.resolvedModel } : { hint: model.model }),
      group: model.providerLabel
    });
  }
  // A saved model whose harness is gone (or is still being probed) stays selectable,
  // so opening settings never silently rewrites the user's choice.
  if (value && !options.some((o) => o.value === value)) {
    options.push({ value, label: value, hint: loading ? 'checking…' : 'not available', group: 'Saved' });
  }
  return (
    <label className="block min-w-0 flex-1">
      <span className="mb-1 block text-[11px] text-neutral-400">Model</span>
      <Dropdown<string> value={value} options={options} onChange={onChange} placeholder={loading ? 'Loading models…' : 'Auto'} />
    </label>
  );
}

function AgentSettings() {
  const [status, setStatus] = useState<AgentsStatus | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [agent, setAgent] = useState<AgentChoice>('yagami');
  const [agentModel, setAgentModel] = useState('');
  const [agentThinking, setAgentThinking] = useState<ThinkingLevel>('default');
  // Cerebras — the model list comes from the account behind the key; the key itself is
  // held server-side (usually from CEREBRAS_API_KEY) and only ever arrives masked.
  const [cerebras, setCerebras] = useState<CerebrasModels | null>(null);
  const [cerebrasLoading, setCerebrasLoading] = useState(false);
  const [cerebrasModel, setCerebrasModel] = useState('');
  const [cerebrasKey, setCerebrasKey] = useState('');
  // Custom endpoint — the key arrives masked; typing a new value replaces it on save.
  const [localUrl, setLocalUrl] = useState('');
  const [localModel, setLocalModel] = useState('');
  const [localKey, setLocalKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [applyErr, setApplyErr] = useState('');

  const refresh = useCallback(async () => {
    const [settings, agents] = await Promise.all([getSettings(), getAgents()]);
    setAgent(settings.agent);
    setAgentModel(settings.agentModel ?? '');
    setAgentThinking(settings.agentThinking ?? 'default');
    setCerebrasModel(settings.cerebrasModel ?? '');
    setCerebrasKey(settings.cerebrasApiKey ?? '');
    setLocalUrl(settings.localUrl ?? '');
    setLocalModel(settings.localModel ?? '');
    setLocalKey(settings.localApiKey ?? '');
    setStatus(agents);
  }, []);
  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);

  // Probing the harnesses spawns a process each, so it runs once on open (the server
  // caches the result) and again only when the user asks for a rescan.
  const loadModels = useCallback(async (rescan = false) => {
    setModelsLoading(true);
    try {
      setCatalog(await getAgentModels(rescan));
    } catch {
      setCatalog(null);
    } finally {
      setModelsLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  const loadCerebras = useCallback(async (refresh = false) => {
    setCerebrasLoading(true);
    try {
      setCerebras(await getCerebrasModels(refresh));
    } catch {
      setCerebras(null);
    } finally {
      setCerebrasLoading(false);
    }
  }, []);
  // Only fetched once Cerebras is the selected backend — no reaching out to a hosted
  // API just because the settings page was opened.
  useEffect(() => {
    if (agent === 'cerebras') void loadCerebras();
  }, [agent, loadCerebras]);

  const apply = async (patch: Partial<UserSettings>) => {
    const next: Partial<UserSettings> = {
      agent,
      agentModel: agentModel.trim(),
      agentThinking,
      cerebrasModel: cerebrasModel.trim(),
      cerebrasApiKey: cerebrasKey,
      localUrl: localUrl.trim(),
      localModel: localModel.trim(),
      localApiKey: localKey,
      ...patch
    };
    if (next.agent !== undefined) setAgent(next.agent);
    if (next.agentModel !== undefined) setAgentModel(next.agentModel);
    if (next.agentThinking !== undefined) setAgentThinking(next.agentThinking);
    if (next.cerebrasModel !== undefined) setCerebrasModel(next.cerebrasModel);
    setSaving(true);
    setSaved(false);
    setApplyErr('');
    try {
      const settings = await saveSettings(next);
      // Reflect the server's masked keys so we never hold a plaintext key in state longer than needed.
      setLocalKey(settings.localApiKey ?? '');
      setCerebrasKey(settings.cerebrasApiKey ?? '');
      setStatus(await getAgents());
      // A new key means a different account, so its model list must be re-fetched.
      if (next.cerebrasApiKey !== undefined && next.agent === 'cerebras') await loadCerebras(true);
      setSaved(true);
    } catch (e) {
      setApplyErr(e instanceof Error ? e.message : 'Could not save agent settings.');
    } finally {
      setSaving(false);
    }
  };

  const saveButton = (
    <button type="button" onClick={() => void apply({})} disabled={saving} className="shrink-0 self-end rounded-lg bg-neutral-900 px-3 py-1.5 text-[12px] font-medium text-white transition enabled:hover:opacity-85 disabled:opacity-40 dark:bg-white dark:text-neutral-900">
      Save
    </button>
  );

  const installed = status?.yagami.providers.filter((p) => p.installed) ?? [];

  return (
    <Section icon={<Cpu size={16} />} title="AI model">
      <p className="mb-3 text-[12.5px] text-neutral-500">
        Inference runs through yagami: the coding-agent CLIs you are already signed into on this machine, with nothing to
        configure and no API keys. Or point Toji at your own OpenAI-compatible endpoint.
      </p>
      <div className="space-y-2.5 rounded-xl border border-black/10 p-3 dark:border-white/10">
        <Dropdown<AgentPick>
          value={agent}
          options={AGENT_OPTIONS}
          onChange={(v) => {
            // 'alpaca' is a placeholder with no backend behind it; every real choice applies.
            if (v === 'alpaca') return;
            void apply({ agent: v });
          }}
        />
        {agent === 'yagami' && (
          <div className="space-y-2.5">
            {status && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-0.5 text-[12px] text-neutral-500">
                {installed.map((p) => (
                  // Installed but unusable (not signed in, ACP handshake failed) reads as
                  // hollow, not on — it can't actually serve a model.
                  <span key={p.id} className="inline-flex items-center gap-1.5" title={p.error ?? undefined}>
                    <StatusDot state={p.usable ? 'on' : 'off'} />
                    {p.label}
                    {!p.usable && <span className="text-neutral-400">· unavailable</span>}
                  </span>
                ))}
                {installed.length === 0 && <span className="inline-flex items-center gap-1.5"><StatusDot state="off" /> No coding CLIs detected</span>}
                <button
                  type="button"
                  onClick={() => void loadModels(true)}
                  disabled={modelsLoading}
                  className="inline-flex items-center gap-1 text-[11.5px] text-neutral-400 transition hover:text-neutral-600 disabled:opacity-50 dark:hover:text-neutral-200"
                >
                  <RefreshCw size={11} className={modelsLoading ? 'animate-spin' : ''} /> Rescan
                </button>
              </div>
            )}
            <div className="flex gap-2">
              <ModelPicker value={agentModel} catalog={catalog} loading={modelsLoading} onChange={(v) => void apply({ agentModel: v })} />
              <label className="w-[140px] shrink-0">
                <span className="mb-1 block text-[11px] text-neutral-400">Thinking</span>
                <Dropdown<ThinkingLevel>
                  value={agentThinking}
                  options={THINKING}
                  disabled={status ? !status.yagami.supportsEffort : false}
                  onChange={(v) => void apply({ agentThinking: v })}
                />
              </label>
            </div>
            {status && !status.yagami.supportsEffort && (
              <p className="px-0.5 text-[11.5px] text-neutral-400">
                {status.yagami.modelProvider ?? 'This harness'} has no reasoning-effort control, so Thinking does not apply to this model.
              </p>
            )}
          </div>
        )}
        {agent === 'cerebras' && (
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-0.5 text-[12px] text-neutral-500">
              <span className="inline-flex items-center gap-1.5">
                <StatusDot state={cerebras?.keySource === 'none' ? 'off' : 'on'} />
                {cerebras?.keySource === 'env' ? 'API key from .env.local' : cerebras?.keySource === 'settings' ? 'API key saved in settings' : 'No API key'}
              </span>
              <button
                type="button"
                onClick={() => void loadCerebras(true)}
                disabled={cerebrasLoading}
                className="inline-flex items-center gap-1 text-[11.5px] text-neutral-400 transition hover:text-neutral-600 disabled:opacity-50 dark:hover:text-neutral-200"
              >
                <RefreshCw size={11} className={cerebrasLoading ? 'animate-spin' : ''} /> Refresh models
              </button>
            </div>
            <div className="flex gap-2">
              <label className="block min-w-0 flex-1">
                <span className="mb-1 block text-[11px] text-neutral-400">Model</span>
                <Dropdown<string>
                  value={cerebrasModel}
                  options={
                    cerebras?.models.length
                      ? cerebras.models.map((m) => ({ value: m.id, label: m.label }))
                      : cerebrasModel
                        ? [{ value: cerebrasModel, label: cerebrasModel, hint: 'saved' }]
                        : []
                  }
                  placeholder={cerebrasLoading ? 'Loading models…' : cerebras?.error ? 'Unavailable' : 'Select a model'}
                  onChange={(v) => void apply({ cerebrasModel: v })}
                />
              </label>
              <ProviderField
                label={cerebras?.keySource === 'env' ? 'API key (overrides .env.local)' : 'API key'}
                value={cerebrasKey}
                onChange={setCerebrasKey}
                placeholder={cerebras?.keySource === 'env' ? 'using CEREBRAS_API_KEY' : 'csk-…'}
                secret
              />
              {saveButton}
            </div>
            {cerebras?.error && <p className="text-[11.5px] text-amber-600 dark:text-amber-400">{cerebras.error}</p>}
            <p className="text-[11.5px] text-neutral-400">
              Cerebras runs open models on their own inference hardware. Toji reads the key from CEREBRAS_API_KEY in your
              .env.local; a key entered here overrides it and is stored in Toji&rsquo;s local settings instead.
            </p>
          </div>
        )}
        {agent === 'local' && (
          <div className="space-y-2">
            <ProviderField label="Endpoint URL (OpenAI-compatible)" value={localUrl} onChange={setLocalUrl} placeholder="http://127.0.0.1:11434/v1" />
            <div className="flex gap-2">
              <ProviderField label="Model" value={localModel} onChange={setLocalModel} placeholder="llama3.2" />
              <ProviderField label="API key (optional)" value={localKey} onChange={setLocalKey} placeholder="none" secret />
              {saveButton}
            </div>
            <p className="text-[11.5px] text-neutral-400">
              Works with Ollama (`http://127.0.0.1:11434/v1`), LM Studio, vLLM, or anything OpenAI-compatible on your home server.
            </p>
          </div>
        )}
        <div className="flex items-center gap-2 text-[12px] text-neutral-500">
          {saving ? (
            <span className="inline-flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Saving…</span>
          ) : agent === 'off' ? (
            <span className="inline-flex items-center gap-1.5"><StatusDot state="off" /> Demo mode — no model</span>
          ) : agent === 'yagami' && status?.yagami.unknownModel ? (
            // The saved model belongs to no installed harness — every call would fail,
            // so this must not read as "Ready".
            <span className="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
              <StatusDot state="off" /> “{status.yagami.model}” is not offered by any installed CLI — pick another model
            </span>
          ) : status?.available ? (
            <span className="inline-flex items-center gap-1.5 text-neutral-600 dark:text-neutral-300">
              <StatusDot state="on" />
              {saved && <Check size={12} />} Ready — {status.model}
            </span>
          ) : agent === 'local' ? (
            <span className="inline-flex items-center gap-1.5"><StatusDot state="off" /> Enter your endpoint URL and model, then Save</span>
          ) : agent === 'cerebras' ? (
            <span className="inline-flex items-center gap-1.5">
              <StatusDot state="off" />
              {status?.cerebras.keySource === 'none' ? 'Add a Cerebras API key to continue' : 'Pick a Cerebras model to continue'}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5"><StatusDot state="off" /> No coding CLI found — install and sign into one (e.g. Claude Code)</span>
          )}
        </div>
        {applyErr && <p className="text-[12px] text-red-500">{applyErr}</p>}
      </div>
    </Section>
  );
}


function SearchSettings() {
  const [engine, setEngine] = useState<SearchEngineId>(() => (localStorage.getItem('toji-search-engine') as SearchEngineId | null) ?? 'duckduckgo');
  const options: DropdownOption<SearchEngineId>[] = SEARCH_ENGINES.map((e) => ({ value: e.id, label: e.name }));
  return (
    <Section icon={<Search size={16} />} title="Search">
      <p className="mb-3 text-[12.5px] text-neutral-500">The engine used when you search the web (the globe button or Shift+Enter).</p>
      <div className="rounded-xl border border-black/10 p-3 dark:border-white/10">
        <label className="block">
          <span className="mb-1 block text-[11px] text-neutral-400">Default search engine</span>
          <Dropdown<SearchEngineId>
            value={engine}
            options={options}
            onChange={(v) => {
              setEngine(v);
              localStorage.setItem('toji-search-engine', v);
            }}
          />
        </label>
      </div>
    </Section>
  );
}

function ReferenceDocs() {
  const [docs, setDocs] = useState<ReferenceDoc[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => void getReferences().then((r) => setDocs(r.references)).catch(() => {}), []);
  useEffect(() => refresh(), [refresh]);

  const upload = useCallback(
    async (fileList: FileList | File[]) => {
      setBusy(true);
      try {
        for (const file of Array.from(fileList)) {
          const dataBase64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
            reader.onerror = () => reject(new Error('read failed'));
            reader.readAsDataURL(file);
          });
          await addReference(file.name, file.type, dataBase64).catch(() => {});
        }
        refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  return (
    <div className="mb-4">
      <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-neutral-600 dark:text-neutral-300">
        <FileText size={14} /> Reference documents
      </div>
      <p className="mb-2 text-[12px] text-neutral-500">Drop files the agent should be able to pull up anytime — a resume, a cover letter, an ID — to read or upload into forms.</p>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
        }}
        className={`rounded-xl border border-dashed p-3 transition ${dragOver ? 'border-neutral-900/40 bg-black/[0.02] dark:border-white/40 dark:bg-white/[0.03]' : 'border-black/15 dark:border-white/15'}`}
      >
        {docs.length === 0 ? (
          <p className="text-center text-[12px] text-neutral-400">{busy ? 'Uploading…' : 'Drop files here, or'} <label className="cursor-pointer underline"><input type="file" multiple className="hidden" onChange={(e) => e.target.files && void upload(e.target.files)} />browse</label></p>
        ) : (
          <div className="space-y-1.5">
            {docs.map((d) => (
              <div key={d.id} className="group flex items-center gap-2 rounded-lg bg-black/[0.03] px-2.5 py-1.5 dark:bg-white/[0.04]">
                <Paperclip size={13} className="shrink-0 text-neutral-400" />
                <span className="flex-1 truncate text-[12.5px]">{d.name}</span>
                <span className="shrink-0 text-[11px] text-neutral-400">{Math.max(1, Math.round(d.size / 1024))} KB</span>
                <button type="button" aria-label="Remove" onClick={() => void deleteReference(d.id).then(refresh)} className="shrink-0 text-neutral-400 opacity-0 transition group-hover:opacity-100 hover:text-red-500">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            <label className="inline-flex cursor-pointer items-center gap-1 text-[11.5px] text-neutral-500 hover:text-neutral-800 dark:hover:text-white">
              <input type="file" multiple className="hidden" onChange={(e) => e.target.files && void upload(e.target.files)} />
              <Plus size={12} /> Add more
            </label>
          </div>
        )}
      </div>
    </div>
  );
}

function MemorySettings() {
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [pinned, setPinned] = useState<PinnedMemory | null>(null);
  const [memDraft, setMemDraft] = useState('');
  const [userDraft, setUserDraft] = useState('');
  const [newFact, setNewFact] = useState('');
  const [pinErr, setPinErr] = useState('');
  const [savingPin, setSavingPin] = useState(false);

  const refresh = useCallback(async () => {
    const [f, p] = await Promise.all([getMemoryFacts(), getPinnedMemory()]);
    setFacts(f.facts);
    setPinned(p);
    setMemDraft(p.memory);
    setUserDraft(p.user);
  }, []);
  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);

  const savePinned = async () => {
    setSavingPin(true);
    setPinErr('');
    try {
      const p = await savePinnedMemory({ memory: memDraft, user: userDraft });
      setPinned(p);
    } catch (e) {
      setPinErr(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSavingPin(false);
    }
  };

  const pinnedDirty = pinned ? memDraft !== pinned.memory || userDraft !== pinned.user : false;

  return (
    <Section icon={<Brain size={16} />} title="Memory">
      <p className="mb-3 text-[12.5px] text-neutral-500">What Toji remembers across sessions. A librarian surfaces only what's relevant to each task, so the agent stays focused.</p>

      <ReferenceDocs />

      <div className="space-y-3 rounded-xl border border-black/10 p-3 dark:border-white/10">
        <PinnedField label="Agent notes (MEMORY)" value={memDraft} cap={pinned?.caps.memory ?? 2200} onChange={setMemDraft} />
        <PinnedField label="About you (USER)" value={userDraft} cap={pinned?.caps.user ?? 1400} onChange={setUserDraft} />
        {pinErr && <p className="text-[12px] text-red-500">{pinErr}</p>}
        {pinnedDirty && (
          <button type="button" onClick={() => void savePinned()} disabled={savingPin} className="inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-3.5 py-1.5 text-[12.5px] font-medium text-white transition enabled:hover:opacity-85 disabled:opacity-40 dark:bg-white dark:text-neutral-900">
            {savingPin && <Loader2 size={12} className="animate-spin" />} Save
          </button>
        )}
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-center gap-2">
          <input
            value={newFact}
            onChange={(e) => setNewFact(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newFact.trim()) {
                void addMemory(newFact.trim()).then(() => {
                  setNewFact('');
                  void refresh();
                });
              }
            }}
            placeholder="Add a memory the agent should keep…"
            className="min-w-0 flex-1 rounded-lg border border-black/10 bg-transparent px-2.5 py-1.5 text-[12.5px] outline-none focus:border-black/30 dark:border-white/12"
          />
          <button type="button" disabled={!newFact.trim()} onClick={() => void addMemory(newFact.trim()).then(() => { setNewFact(''); void refresh(); })} className="shrink-0 rounded-lg border border-black/10 px-2.5 py-1.5 text-[12px] transition enabled:hover:border-black/30 disabled:opacity-40 dark:border-white/15">
            Add
          </button>
        </div>
        <div className="space-y-1.5">
          {facts.length === 0 && <p className="text-[12.5px] text-neutral-400">No memories yet. The agent adds these as it learns, or add your own above.</p>}
          {facts.map((f) => (
            <div key={f.id} className="group flex items-start gap-2 rounded-lg bg-black/[0.03] px-2.5 py-1.5 dark:bg-white/[0.04]">
              <span className="flex-1 text-[12.5px]">{f.text}</span>
              <button type="button" aria-label="Delete memory" onClick={() => void deleteMemoryFact(f.id).then(refresh)} className="shrink-0 text-neutral-400 opacity-0 transition group-hover:opacity-100 hover:text-red-500">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}

function PinnedField({ label, value, cap, onChange }: { label: string; value: string; cap: number; onChange: (v: string) => void }) {
  const over = value.length > cap;
  return (
    <label className="block">
      <span className="mb-1 flex items-center justify-between text-[11.5px] text-neutral-400">
        <span>{label}</span>
        <span className={over ? 'text-red-500' : ''}>{value.length}/{cap}</span>
      </span>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={3} className={`w-full resize-y rounded-lg border bg-transparent px-2.5 py-1.5 text-[12.5px] outline-none ${over ? 'border-red-400' : 'border-black/10 focus:border-black/30 dark:border-white/12'}`} />
    </label>
  );
}
