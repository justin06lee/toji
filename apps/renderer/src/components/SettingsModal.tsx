import { Check, Cpu, KeyRound, Loader2, Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { getAgents, getSettings, saveSettings } from '../lib/api';
import type { CredentialSet, CredentialStore } from '../lib/credentials';
import type { AgentChoice, AgentId, AgentsStatus, ThinkingLevel } from '../types';
import { Dropdown, type DropdownOption } from './Dropdown';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  store: CredentialStore;
  onChange: (store: CredentialStore) => void;
}

let uid = 0;
const newId = () => `set-${Date.now()}-${(uid += 1)}`;

type AgentPick = AgentChoice | 'custom';

interface AgentDraft {
  agent: AgentChoice;
  agentCmd: string;
  agentModel: string;
  agentThinking: ThinkingLevel;
}

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

/** Presentational AI-agent picker. Edits the parent's draft; persistence happens on Save. */
function AgentSection({
  draft,
  onPatch,
  status,
  loading,
  customOpen,
  setCustomOpen
}: {
  draft: AgentDraft;
  onPatch: (patch: Partial<AgentDraft>) => void;
  status: AgentsStatus | null;
  loading: boolean;
  customOpen: boolean;
  setCustomOpen: (v: boolean) => void;
}) {
  const usingCustom = customOpen || Boolean(draft.agentCmd.trim());
  const pick: AgentPick = usingCustom ? 'custom' : draft.agent;

  // Only offer agents actually installed on this device (+ Auto/Custom/Off).
  const detected = status?.detected.filter((d) => d.available) ?? [];
  const agentOptions: DropdownOption<AgentPick>[] = [
    { value: 'auto', label: 'Auto-detect' },
    ...detected.map((d) => ({ value: d.id as AgentPick, label: AGENT_LABELS[d.id] })),
    { value: 'custom', label: 'Custom command' },
    { value: 'off', label: 'Off' }
  ];

  // Which agent's model list applies (Auto resolves to the first detected one).
  const tunedId: AgentId | null = usingCustom || draft.agent === 'off'
    ? null
    : draft.agent === 'auto'
      ? detected[0]?.id ?? null
      : draft.agent;

  const onSelect = (value: AgentPick) => {
    if (value === 'custom') {
      setCustomOpen(true);
      return;
    }
    setCustomOpen(false);
    // Model presets are per-agent, so reset the model when switching agents.
    onPatch({ agent: value, agentCmd: '', agentModel: '' });
  };

  const statusLine = draft.agent === 'off' && !usingCustom
    ? <span className="text-neutral-400">Demo mode — no agent</span>
    : status?.available
      ? <span className="text-emerald-600 dark:text-emerald-400">Ready</span>
      : <span className="text-amber-600 dark:text-amber-400">No agent found — install one or set a custom command</span>;

  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center gap-2">
        <Cpu size={15} className="text-neutral-500" />
        <h3 className="text-[13.5px] font-medium">AI agent</h3>
        {loading && <Loader2 size={13} className="animate-spin text-neutral-400" />}
      </div>
      <p className="mb-3 text-[12px] leading-5 text-neutral-500">
        Toji runs your own local coding agent for inference — no API keys.
      </p>

      <div className="space-y-2 rounded-xl border border-black/10 p-3 dark:border-white/10">
        <Dropdown<AgentPick> value={pick} options={agentOptions} onChange={onSelect} />

        {usingCustom && (
          <input
            value={draft.agentCmd}
            onChange={(e) => onPatch({ agentCmd: e.target.value })}
            placeholder="claude -p --dangerously-skip-permissions"
            spellCheck={false}
            className="w-full rounded-lg border border-black/10 bg-transparent px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-black/30 dark:border-white/12 dark:focus:border-white/30"
          />
        )}

        {tunedId && (
          <div className="flex gap-2">
            <label className="flex-1">
              <span className="mb-1 block text-[11px] text-neutral-400">Model</span>
              <Dropdown<string> value={draft.agentModel} options={MODELS[tunedId]} onChange={(v) => onPatch({ agentModel: v })} placeholder="Default" />
            </label>
            <label className="flex-1">
              <span className="mb-1 block text-[11px] text-neutral-400">Thinking</span>
              <Dropdown<ThinkingLevel> value={draft.agentThinking} options={THINKING} onChange={(v) => onPatch({ agentThinking: v })} />
            </label>
          </div>
        )}

        <div className="text-[12px]">{statusLine}</div>
      </div>
    </div>
  );
}

/** Settings overlay. Edits local DRAFTS of the credential vault AND the agent config;
 *  nothing persists until Save, so it's unambiguous whether changes are applied.
 *  Secrets fill login forms via {{placeholders}} and never enter the model's context. */
export function SettingsModal({ open, onClose, store, onChange }: SettingsModalProps) {
  const [draft, setDraft] = useState<CredentialStore>(store);
  const [agentDraft, setAgentDraft] = useState<AgentDraft>({ agent: 'auto', agentCmd: '', agentModel: '', agentThinking: 'default' });
  const [agentInitial, setAgentInitial] = useState<AgentDraft>({ agent: 'auto', agentCmd: '', agentModel: '', agentThinking: 'default' });
  const [status, setStatus] = useState<AgentsStatus | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed both drafts from saved state each time the modal opens.
  useEffect(() => {
    if (!open) return;
    setDraft(store);
    setError(null);
    setLoading(true);
    void (async () => {
      try {
        const [settings, agents] = await Promise.all([getSettings(), getAgents()]);
        const seed: AgentDraft = {
          agent: settings.agent,
          agentCmd: settings.agentCmd ?? '',
          agentModel: settings.agentModel ?? '',
          agentThinking: settings.agentThinking ?? 'default'
        };
        setAgentDraft(seed);
        setAgentInitial(seed);
        setCustomOpen(Boolean(seed.agentCmd.trim()));
        setStatus(agents);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not reach the local agent server.');
      } finally {
        setLoading(false);
      }
    })();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const credDirty = JSON.stringify(draft) !== JSON.stringify(store);
  const agentDirty = JSON.stringify(agentDraft) !== JSON.stringify(agentInitial);
  const dirty = credDirty || agentDirty;

  const save = async () => {
    setError(null);
    if (credDirty) onChange(draft);
    if (agentDirty) {
      setSaving(true);
      try {
        await saveSettings(agentDraft);
        setAgentInitial(agentDraft);
        setStatus(await getAgents());
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to save agent settings.');
      } finally {
        setSaving(false);
      }
    }
  };

  const patchSet = (id: string, fn: (s: CredentialSet) => CredentialSet) =>
    setDraft({ ...draft, sets: draft.sets.map((s) => (s.id === id ? fn(s) : s)) });
  const addSet = () => {
    const id = newId();
    setDraft({
      activeId: draft.activeId ?? id,
      sets: [...draft.sets, { id, name: `Account ${draft.sets.length + 1}`, fields: [{ key: 'email', value: '' }, { key: 'password', value: '' }] }]
    });
  };
  const removeSet = (id: string) =>
    setDraft({ activeId: draft.activeId === id ? null : draft.activeId, sets: draft.sets.filter((s) => s.id !== id) });

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[140] flex items-center justify-center bg-black/30 p-6 backdrop-blur-[2px]"
          onMouseDown={onClose}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16, ease: 'easeOut' }}
        >
          <motion.div
            className="no-drag flex max-h-[80vh] w-[min(560px,94vw)] flex-col overflow-hidden rounded-2xl border border-black/10 bg-white shadow-2xl dark:border-white/12 dark:bg-neutral-900"
            onMouseDown={(e) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.97, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 4 }}
            transition={{ type: 'spring', stiffness: 360, damping: 30 }}
          >
            <div className="flex items-center justify-between border-b border-black/[0.07] px-5 py-3.5 dark:border-white/10">
              <h2 className="text-[15px] font-semibold">Settings</h2>
              <button type="button" onClick={onClose} aria-label="Close" className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-neutral-500 transition hover:bg-black/[0.05] hover:text-neutral-900 dark:hover:bg-white/10 dark:hover:text-white">
                <X size={15} />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <AgentSection draft={agentDraft} onPatch={(p) => setAgentDraft((d) => ({ ...d, ...p }))} status={status} loading={loading} customOpen={customOpen} setCustomOpen={setCustomOpen} />

              <div className="mb-2 flex items-center gap-2">
                <KeyRound size={15} className="text-neutral-500" />
                <h3 className="text-[13.5px] font-medium">Credentials</h3>
              </div>
              <p className="mb-3 flex items-start gap-1.5 text-[12px] leading-5 text-neutral-500">
                <ShieldCheck size={14} className="mt-0.5 shrink-0 text-emerald-500" />
                <span>
                  Stored only on this device. The agent picks the right one for the task and fills it into login forms via placeholders like <code className="rounded bg-black/[0.06] px-1 dark:bg-white/10">{'{{password}}'}</code> — the real value is inserted locally and <strong>never sent to the model or over the network</strong>.
                </span>
              </p>

              <div className="space-y-3">
                {draft.sets.map((set) => (
                  <div key={set.id} className="rounded-xl border border-black/10 p-3 dark:border-white/10">
                    <div className="mb-2 flex items-center gap-2">
                      <input
                        value={set.name}
                        onChange={(e) => patchSet(set.id, (s) => ({ ...s, name: e.target.value }))}
                        className="min-w-0 flex-1 rounded-md bg-transparent px-1.5 py-1 text-[13px] font-medium text-neutral-900 outline-none focus:bg-black/[0.04] dark:text-white dark:focus:bg-white/5"
                        placeholder="Account name"
                      />
                      <button type="button" onClick={() => removeSet(set.id)} aria-label="Delete account" className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 transition hover:bg-red-500/10 hover:text-red-500">
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <div className="space-y-1.5">
                      {set.fields.map((f, idx) => (
                        <div key={idx} className="flex items-center gap-2">
                          <input
                            value={f.key}
                            onChange={(e) => patchSet(set.id, (s) => ({ ...s, fields: s.fields.map((x, i) => (i === idx ? { ...x, key: e.target.value } : x)) }))}
                            placeholder="key (e.g. email)"
                            className="w-32 rounded-md border border-black/10 bg-transparent px-2 py-1 text-[12.5px] outline-none focus:border-black/25 dark:border-white/12 dark:focus:border-white/30"
                          />
                          <input
                            value={f.value}
                            type="password"
                            autoComplete="off"
                            onChange={(e) => patchSet(set.id, (s) => ({ ...s, fields: s.fields.map((x, i) => (i === idx ? { ...x, value: e.target.value } : x)) }))}
                            placeholder="value"
                            className="min-w-0 flex-1 rounded-md border border-black/10 bg-transparent px-2 py-1 text-[12.5px] outline-none focus:border-black/25 dark:border-white/12 dark:focus:border-white/30"
                          />
                          <button type="button" onClick={() => patchSet(set.id, (s) => ({ ...s, fields: s.fields.filter((_, i) => i !== idx) }))} aria-label="Remove field" className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-400 transition hover:bg-red-500/10 hover:text-red-500">
                            <X size={13} />
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => patchSet(set.id, (s) => ({ ...s, fields: [...s.fields, { key: '', value: '' }] }))}
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] text-neutral-500 transition hover:bg-black/[0.05] hover:text-neutral-800 dark:hover:bg-white/10 dark:hover:text-white"
                      >
                        <Plus size={12} /> Add field
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <button
                type="button"
                onClick={addSet}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-dashed border-black/15 px-3 py-2 text-[12.5px] text-neutral-600 transition hover:border-black/30 hover:bg-black/[0.02] dark:border-white/15 dark:text-neutral-300 dark:hover:border-white/30 dark:hover:bg-white/5"
              >
                <Plus size={14} /> Add account
              </button>
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-black/[0.07] px-5 py-3 dark:border-white/10">
              <span className={`inline-flex items-center gap-1.5 text-[12px] ${error ? 'text-red-500' : dirty ? 'text-amber-500' : 'text-emerald-500'}`}>
                {error ? (
                  error
                ) : dirty ? (
                  <>
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> Unsaved changes
                  </>
                ) : (
                  <>
                    <Check size={13} /> All changes saved
                  </>
                )}
              </span>
              <div className="flex items-center gap-2">
                <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-[12.5px] text-neutral-500 transition hover:bg-black/[0.05] hover:text-neutral-900 dark:hover:bg-white/10 dark:hover:text-white">
                  {dirty ? 'Discard' : 'Done'}
                </button>
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={!dirty || saving}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-3.5 py-1.5 text-[12.5px] font-medium text-white transition enabled:hover:opacity-85 disabled:opacity-40 dark:bg-white dark:text-neutral-900"
                >
                  {saving && <Loader2 size={12} className="animate-spin" />}
                  Save
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
