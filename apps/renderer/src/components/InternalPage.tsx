import { BookMarked, Brain, Check, Compass, Cpu, Download, FileText, KeyRound, Loader2, Paperclip, Plus, Puzzle, Search, ShieldCheck, Star, Trash2, X } from 'lucide-react';
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
import type { AgentChoice, AgentId, AgentsStatus, InternalPage as InternalPageKind, ThinkingLevel } from '../types';
import type { CredentialSet, CredentialStore } from '../lib/credentials';
import { SEARCH_ENGINES, type SearchEngineId } from '../lib/nav';
import { Dropdown, type DropdownOption } from './Dropdown';

// The preload bridge (optional — only present in the packaged/Electron shell).
interface TojiBridge {
  setDefaultBrowser?: () => Promise<boolean>;
  isDefaultBrowser?: () => Promise<boolean>;
  addExtension?: () => Promise<{ id: string; name: string } | { error: string } | null>;
  listExtensions?: () => Promise<{ id: string; name: string }[]>;
  webStoreAvailable?: () => Promise<boolean>;
}
const bridge = (): TojiBridge => (window as unknown as { toji?: TojiBridge }).toji ?? {};

interface InternalPageProps {
  page: InternalPageKind;
  store: CredentialStore;
  onChange: (store: CredentialStore) => void;
  onOpenUrl: (url: string) => void;
  onGetStarted: () => void;
}

export function InternalPage({ page, store, onChange, onOpenUrl, onGetStarted }: InternalPageProps) {
  return (
    <div className="h-full w-full overflow-y-auto bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="mx-auto w-[min(760px,92vw)] px-6 py-12">
        {page === 'welcome' ? <WelcomeView onOpenUrl={onOpenUrl} onGetStarted={onGetStarted} /> : <SettingsView store={store} onChange={onChange} />}
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
type AgentPick = AgentChoice | 'custom';

function SettingsView({ store, onChange }: { store: CredentialStore; onChange: (s: CredentialStore) => void }) {
  return (
    <div>
      <h1 className="mb-8 text-2xl font-semibold tracking-tight">Settings</h1>
      <AgentSettings />
      <SearchSettings />
      <CredentialsSettings store={store} onChange={onChange} />
      <MemorySettings />
    </div>
  );
}

function AgentSettings() {
  const [status, setStatus] = useState<AgentsStatus | null>(null);
  const [agent, setAgent] = useState<AgentChoice>('auto');
  const [agentCmd, setAgentCmd] = useState('');
  const [agentModel, setAgentModel] = useState('');
  const [agentThinking, setAgentThinking] = useState<ThinkingLevel>('default');
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
    setCustomOpen(Boolean(settings.agentCmd?.trim()));
    setStatus(agents);
  }, []);
  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);

  const apply = async (patch: { agent?: AgentChoice; agentCmd?: string; agentModel?: string; agentThinking?: ThinkingLevel }) => {
    const next = { agent, agentCmd, agentModel, agentThinking, ...patch };
    setAgent(next.agent);
    setAgentCmd(next.agentCmd);
    setAgentModel(next.agentModel);
    setAgentThinking(next.agentThinking);
    setSaving(true);
    setSaved(false);
    setApplyErr('');
    try {
      await saveSettings(next);
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
    { value: 'custom', label: 'Custom command' },
    { value: 'off', label: 'Off' }
  ];
  const tunedId: AgentId | null = usingCustom || agent === 'off' ? null : agent === 'auto' ? detected[0]?.id ?? null : agent;

  return (
    <Section icon={<Cpu size={16} />} title="AI agent">
      <p className="mb-3 text-[12.5px] text-neutral-500">Toji runs your own local coding agent for inference — no API keys.</p>
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
            <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">{saved && <Check size={12} />} Ready</span>
          ) : (
            <span className="text-amber-600 dark:text-amber-400">No agent found — install one or set a custom command</span>
          )}
        </div>
        {applyErr && <p className="text-[12px] text-red-500">{applyErr}</p>}
      </div>
      <div className="mt-2 space-y-2">
        <PerceptionToggle
          storageKey="toji-agent-vision"
          title="Vision-first (screenshot every step)"
          description="Capture an annotated screenshot every turn so the agent always sees the page — much better on chess/canvases/visual layouts. Uses more tokens and is a bit slower; best with a vision-capable agent."
        />
        <PerceptionToggle
          storageKey="toji-agent-cdp"
          title="Accessibility-tree perception"
          description="Add elements from Chromium's accessibility tree (CDP) on top of the normal page reading — extra targeting on complex sites. Experimental."
        />
      </div>
    </Section>
  );
}

// A localStorage-backed on/off switch for a client-only agent setting (no server round-trip).
function PerceptionToggle({ storageKey, title, description }: { storageKey: string; title: string; description: string }) {
  const [on, setOn] = useState(() => localStorage.getItem(storageKey) === '1');
  const set = (v: boolean) => {
    setOn(v);
    localStorage.setItem(storageKey, v ? '1' : '0');
  };
  return (
    <div className="flex items-center justify-between rounded-xl border border-black/10 p-3 dark:border-white/10">
      <div className="min-w-0 pr-3">
        <div className="text-[13px] font-medium">{title}</div>
        <p className="mt-0.5 text-[11.5px] text-neutral-400">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => set(!on)}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition ${on ? 'bg-emerald-500' : 'bg-black/15 dark:bg-white/20'}`}
      >
        <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${on ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
      </button>
    </div>
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
