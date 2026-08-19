import { BookMarked, Boxes, Brain, Check, Compass, Cpu, Download, EyeOff, FileText, KeyRound, Loader2, Paperclip, Plus, Puzzle, RefreshCw, Route, Search, ShieldCheck, Star, Trash2, TriangleAlert, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  addMemory,
  addReference,
  deleteBookmark,
  deleteMemoryFact,
  deleteReference,
  getAgents,
  getBookmarks,
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
import type { AgentChoice, AgentId, AgentsStatus, InternalPage as InternalPageKind, ThinkingLevel, UserSettings } from '../types';
import type { CredentialSet, CredentialStore } from '../lib/credentials';
import { bridge, type TorStatus } from '../lib/bridge';
import { CONTAINER_COLORS, containerId as makeContainerId, type Container, type Egress } from '../lib/containers';
import { SEARCH_ENGINES, type SearchEngineId } from '../lib/nav';
import { Dropdown, type DropdownOption } from './Dropdown';


interface InternalPageProps {
  page: InternalPageKind;
  store: CredentialStore;
  onChange: (store: CredentialStore) => void;
  onOpenUrl: (url: string) => void;
  onGetStarted: () => void;
  containers: Container[];
  onContainersChange: (containers: Container[]) => void;
  onClearContainer: (containerId: string) => void;
}

export function InternalPage({ page, store, onChange, onOpenUrl, onGetStarted, containers, onContainersChange, onClearContainer }: InternalPageProps) {
  return (
    <div className="h-full w-full overflow-y-auto bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="mx-auto w-[min(760px,92vw)] px-6 py-12">
        {page === 'welcome' ? (
          <WelcomeView onOpenUrl={onOpenUrl} onGetStarted={onGetStarted} />
        ) : (
          <SettingsView store={store} onChange={onChange} containers={containers} onContainersChange={onContainersChange} onClearContainer={onClearContainer} />
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
const MODELS: Record<AgentId, DropdownOption<string>[]> = {
  claude: [
    { value: '', label: 'Default' },
    { value: 'opus', label: 'Opus' },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'haiku', label: 'Haiku' }
  ],
  codex: [
    { value: '', label: 'Default' },
    { value: 'gpt-5-codex', label: 'gpt-5-codex' },
    { value: 'gpt-5', label: 'gpt-5' },
    { value: 'o3', label: 'o3' }
  ],
  opencode: [{ value: '', label: 'Default' }]
};
const THINKING: DropdownOption<ThinkingLevel>[] = [
  { value: 'default', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
];
const AGENT_LABELS: Record<AgentId, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'opencode' };
// Claude API model ids ('' = the server default, claude-opus-4-8).
const ANTHROPIC_MODELS: DropdownOption<string>[] = [
  { value: '', label: 'Opus 4.8 (default)' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5' }
];
type AgentPick = AgentChoice | 'custom';

function SettingsView({
  store,
  onChange,
  containers,
  onContainersChange,
  onClearContainer
}: {
  store: CredentialStore;
  onChange: (s: CredentialStore) => void;
  containers: Container[];
  onContainersChange: (containers: Container[]) => void;
  onClearContainer: (containerId: string) => void;
}) {
  return (
    <div>
      <h1 className="mb-8 text-2xl font-semibold tracking-tight">Settings</h1>
      <ContainersSettings containers={containers} onChange={onContainersChange} onClear={onClearContainer} />
      <TorSettings />
      <AgentSettings />
      <SearchSettings />
      <CredentialsSettings store={store} onChange={onChange} />
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
            <input
              type="color"
              aria-label={`${container.name} color`}
              value={container.color}
              onChange={(e) => patch(container.id, { color: e.target.value })}
              className="h-6 w-6 shrink-0 cursor-pointer rounded-full border-0 bg-transparent p-0"
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

      <p className="mt-3 flex items-start gap-1.5 text-[12px] leading-relaxed text-neutral-400">
        <Route size={13} className="mt-px shrink-0" />
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
  const dot = status.ready ? 'bg-emerald-500' : running ? 'bg-amber-500' : 'bg-neutral-400';

  return (
    <Section icon={<Route size={15} />} title="Tor">
      <p className="mb-4 text-[13px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        Toji drives the real Tor client rather than implementing onion routing itself. Containers set to Tor send every
        request through it &mdash; and while Tor is unavailable their traffic is cancelled outright, never quietly sent over
        the direct connection.
      </p>

      <div className="rounded-xl border border-black/10 p-3 dark:border-white/12">
        <div className="flex flex-wrap items-center gap-3">
          <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
          <span className="min-w-0 flex-1 text-[13px]">
            {status.detail}
            {status.source && <span className="ml-1.5 text-[11px] text-neutral-400">({status.source === 'managed' ? 'Toji-managed' : 'external'})</span>}
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
          <p className="mt-3 flex items-start gap-1.5 border-t border-black/[0.07] pt-3 text-[12px] leading-relaxed text-amber-600 dark:border-white/10 dark:text-amber-400">
            <TriangleAlert size={13} className="mt-px shrink-0" />
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

function AgentSettings() {
  const [status, setStatus] = useState<AgentsStatus | null>(null);
  const [agent, setAgent] = useState<AgentChoice>('auto');
  const [agentCmd, setAgentCmd] = useState('');
  const [agentModel, setAgentModel] = useState('');
  const [agentThinking, setAgentThinking] = useState<ThinkingLevel>('default');
  // API backends — keys arrive masked; typing a new value replaces the stored key on save.
  const [anthropicKey, setAnthropicKey] = useState('');
  const [anthropicModel, setAnthropicModel] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [openaiModel, setOpenaiModel] = useState('');
  const [localUrl, setLocalUrl] = useState('');
  const [localModel, setLocalModel] = useState('');
  const [localKey, setLocalKey] = useState('');
  const [customOpen, setCustomOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [applyErr, setApplyErr] = useState('');

  const refresh = useCallback(async () => {
    const [settings, agents] = await Promise.all([getSettings(), getAgents()]);
    setAgent(settings.agent);
    setAgentCmd(settings.agentCmd ?? '');
    setAgentModel(settings.agentModel ?? '');
    setAgentThinking(settings.agentThinking ?? 'default');
    setAnthropicKey(settings.anthropicApiKey ?? '');
    setAnthropicModel(settings.anthropicModel ?? '');
    setOpenaiKey(settings.openaiApiKey ?? '');
    setOpenaiModel(settings.openaiModel ?? '');
    setLocalUrl(settings.localUrl ?? '');
    setLocalModel(settings.localModel ?? '');
    setLocalKey(settings.localApiKey ?? '');
    setCustomOpen(Boolean(settings.agentCmd?.trim()));
    setStatus(agents);
  }, []);
  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);

  const apply = async (patch: Partial<UserSettings>) => {
    const next: Partial<UserSettings> = {
      agent,
      agentCmd,
      agentModel,
      agentThinking,
      anthropicApiKey: anthropicKey,
      anthropicModel,
      openaiApiKey: openaiKey,
      openaiModel,
      localUrl: localUrl.trim(),
      localModel: localModel.trim(),
      localApiKey: localKey,
      ...patch
    };
    if (next.agent !== undefined) setAgent(next.agent);
    if (next.agentCmd !== undefined) setAgentCmd(next.agentCmd);
    if (next.agentModel !== undefined) setAgentModel(next.agentModel);
    if (next.agentThinking !== undefined) setAgentThinking(next.agentThinking);
    setSaving(true);
    setSaved(false);
    setApplyErr('');
    try {
      const settings = await saveSettings(next);
      // Reflect the server's masked keys so we never hold a plaintext key in state longer than needed.
      setAnthropicKey(settings.anthropicApiKey ?? '');
      setOpenaiKey(settings.openaiApiKey ?? '');
      setLocalKey(settings.localApiKey ?? '');
      setStatus(await getAgents());
      setSaved(true);
    } catch (e) {
      setApplyErr(e instanceof Error ? e.message : 'Could not save agent settings.');
    } finally {
      setSaving(false);
    }
  };

  const usingCustom = customOpen || Boolean(agentCmd.trim());
  const pick: AgentPick = usingCustom ? 'custom' : agent;
  const detected = status?.detected.filter((d) => d.available) ?? [];
  const options: DropdownOption<AgentPick>[] = [
    { value: 'auto', label: 'Auto-detect' },
    ...detected.map((d) => ({ value: d.id as AgentPick, label: AGENT_LABELS[d.id] })),
    { value: 'anthropic', label: 'Claude API' },
    { value: 'openai', label: 'OpenAI API' },
    { value: 'local', label: 'Self-hosted / local model' },
    { value: 'custom', label: 'Custom command' },
    { value: 'off', label: 'Off' }
  ];
  const isApiPick = agent === 'anthropic' || agent === 'openai' || agent === 'local';
  const tunedId: AgentId | null = usingCustom || agent === 'off' || isApiPick ? null : agent === 'auto' ? detected[0]?.id ?? null : agent;

  const saveButton = (
    <button type="button" onClick={() => void apply({})} disabled={saving} className="shrink-0 self-end rounded-lg bg-neutral-900 px-3 py-1.5 text-[12px] font-medium text-white transition enabled:hover:opacity-85 disabled:opacity-40 dark:bg-white dark:text-neutral-900">
      Save
    </button>
  );

  return (
    <Section icon={<Cpu size={16} />} title="AI model">
      <p className="mb-3 text-[12.5px] text-neutral-500">
        Toji can run on a local coding agent (no keys), your own API key (Claude / OpenAI), or a model you host yourself — Ollama on this
        machine or an OpenAI-compatible endpoint on your own server. Keys are stored only in Toji&apos;s local settings file and sent
        nowhere except the provider you pick.
      </p>
      <div className="space-y-2 rounded-xl border border-black/10 p-3 dark:border-white/10">
        <Dropdown<AgentPick>
          value={pick}
          options={options}
          onChange={(v) => {
            if (v === 'custom') {
              setCustomOpen(true);
              return;
            }
            setCustomOpen(false);
            void apply({ agent: v, agentCmd: '', agentModel: '' });
          }}
        />
        {usingCustom && (
          <div className="flex items-center gap-2">
            <input
              value={agentCmd}
              onChange={(e) => setAgentCmd(e.target.value)}
              placeholder="claude -p --dangerously-skip-permissions"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-lg border border-black/10 bg-transparent px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-black/30 dark:border-white/12 dark:focus:border-white/30"
            />
            <button type="button" onClick={() => void apply({ agentCmd: agentCmd.trim() })} disabled={saving} className="shrink-0 rounded-lg bg-neutral-900 px-3 py-1.5 text-[12px] font-medium text-white transition enabled:hover:opacity-85 disabled:opacity-40 dark:bg-white dark:text-neutral-900">
              Apply
            </button>
          </div>
        )}
        {agent === 'anthropic' && !usingCustom && (
          <div className="space-y-2">
            <div className="flex gap-2">
              <ProviderField label="API key" value={anthropicKey} onChange={setAnthropicKey} placeholder="sk-ant-…" secret />
              {saveButton}
            </div>
            <div className="flex gap-2">
              <label className="flex-1">
                <span className="mb-1 block text-[11px] text-neutral-400">Model</span>
                <Dropdown<string> value={anthropicModel} options={ANTHROPIC_MODELS} onChange={(v) => void apply({ anthropicModel: v })} />
              </label>
              <label className="flex-1">
                <span className="mb-1 block text-[11px] text-neutral-400">Thinking</span>
                <Dropdown<ThinkingLevel> value={agentThinking} options={THINKING} onChange={(v) => void apply({ agentThinking: v })} />
              </label>
            </div>
          </div>
        )}
        {agent === 'openai' && !usingCustom && (
          <div className="flex gap-2">
            <ProviderField label="API key" value={openaiKey} onChange={setOpenaiKey} placeholder="sk-…" secret />
            <ProviderField label="Model" value={openaiModel} onChange={setOpenaiModel} placeholder="gpt-5.1" />
            {saveButton}
          </div>
        )}
        {agent === 'local' && !usingCustom && (
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
        {tunedId && (
          <div className="flex gap-2">
            <label className="flex-1">
              <span className="mb-1 block text-[11px] text-neutral-400">Model</span>
              <Dropdown<string> value={agentModel} options={MODELS[tunedId]} onChange={(v) => void apply({ agentModel: v })} placeholder="Default" />
            </label>
            <label className="flex-1">
              <span className="mb-1 block text-[11px] text-neutral-400">Thinking</span>
              <Dropdown<ThinkingLevel> value={agentThinking} options={THINKING} onChange={(v) => void apply({ agentThinking: v })} />
            </label>
          </div>
        )}
        <div className="flex items-center gap-2 text-[12px]">
          {saving ? (
            <span className="inline-flex items-center gap-1.5 text-neutral-400"><Loader2 size={12} className="animate-spin" /> Saving…</span>
          ) : agent === 'off' && !usingCustom ? (
            <span className="text-neutral-400">Demo mode — no agent</span>
          ) : status?.available ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">{saved && <Check size={12} />} Ready — {status.model}</span>
          ) : isApiPick ? (
            <span className="text-amber-600 dark:text-amber-400">
              {agent === 'local' ? 'Enter your endpoint URL and model, then Save' : 'Paste your API key, then Save'}
            </span>
          ) : (
            <span className="text-amber-600 dark:text-amber-400">No agent found — install one, use an API key, or self-host a model</span>
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

let cuid = 0;
const newId = () => `set-${Date.now()}-${(cuid += 1)}`;

function CredentialsSettings({ store, onChange }: { store: CredentialStore; onChange: (s: CredentialStore) => void }) {
  const [draft, setDraft] = useState<CredentialStore>(store);
  useEffect(() => setDraft(store), [store]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(store);
  const patchSet = (id: string, fn: (s: CredentialSet) => CredentialSet) => setDraft({ ...draft, sets: draft.sets.map((s) => (s.id === id ? fn(s) : s)) });

  return (
    <Section icon={<KeyRound size={16} />} title="Credentials">
      <p className="mb-3 flex items-start gap-1.5 text-[12px] leading-5 text-neutral-500">
        <ShieldCheck size={14} className="mt-0.5 shrink-0 text-emerald-500" />
        <span>Stored only on this device. The agent picks the right one for the task and fills it into login forms via placeholders like <code className="rounded bg-black/[0.06] px-1 dark:bg-white/10">{'{{password}}'}</code> — the real value is inserted locally and <strong>never sent to the model or over the network</strong>.</span>
      </p>
      <div className="space-y-3">
        {draft.sets.map((set) => (
          <div key={set.id} className="rounded-xl border border-black/10 p-3 dark:border-white/10">
            <div className="mb-2 flex items-center gap-2">
              <input value={set.name} onChange={(e) => patchSet(set.id, (s) => ({ ...s, name: e.target.value }))} className="min-w-0 flex-1 rounded-md bg-transparent px-1.5 py-1 text-[13px] font-medium outline-none focus:bg-black/[0.04] dark:focus:bg-white/5" placeholder="Account name" />
              <button type="button" onClick={() => setDraft({ activeId: draft.activeId === set.id ? null : draft.activeId, sets: draft.sets.filter((s) => s.id !== set.id) })} aria-label="Delete account" className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 transition hover:bg-red-500/10 hover:text-red-500">
                <Trash2 size={14} />
              </button>
            </div>
            <div className="space-y-1.5">
              {set.fields.map((f, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <input value={f.key} onChange={(e) => patchSet(set.id, (s) => ({ ...s, fields: s.fields.map((x, i) => (i === idx ? { ...x, key: e.target.value } : x)) }))} placeholder="key (e.g. email)" className="w-32 rounded-md border border-black/10 bg-transparent px-2 py-1 text-[12.5px] outline-none focus:border-black/25 dark:border-white/12" />
                  <input value={f.value} type="password" autoComplete="off" onChange={(e) => patchSet(set.id, (s) => ({ ...s, fields: s.fields.map((x, i) => (i === idx ? { ...x, value: e.target.value } : x)) }))} placeholder="value" className="min-w-0 flex-1 rounded-md border border-black/10 bg-transparent px-2 py-1 text-[12.5px] outline-none focus:border-black/25 dark:border-white/12" />
                  <button type="button" onClick={() => patchSet(set.id, (s) => ({ ...s, fields: s.fields.filter((_, i) => i !== idx) }))} aria-label="Remove field" className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-400 transition hover:bg-red-500/10 hover:text-red-500">
                    <X size={13} />
                  </button>
                </div>
              ))}
              <button type="button" onClick={() => patchSet(set.id, (s) => ({ ...s, fields: [...s.fields, { key: '', value: '' }] }))} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] text-neutral-500 transition hover:bg-black/[0.05] dark:hover:bg-white/10">
                <Plus size={12} /> Add field
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button type="button" onClick={() => setDraft({ activeId: draft.activeId, sets: [...draft.sets, { id: newId(), name: `Account ${draft.sets.length + 1}`, fields: [{ key: 'email', value: '' }, { key: 'password', value: '' }] }] })} className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-black/15 px-3 py-2 text-[12.5px] text-neutral-600 transition hover:border-black/30 dark:border-white/15 dark:text-neutral-300">
          <Plus size={14} /> Add account
        </button>
        <div className="flex-1" />
        {dirty && (
          <button type="button" onClick={() => onChange(draft)} className="rounded-lg bg-neutral-900 px-3.5 py-1.5 text-[12.5px] font-medium text-white transition hover:opacity-85 dark:bg-white dark:text-neutral-900">
            Save credentials
          </button>
        )}
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
