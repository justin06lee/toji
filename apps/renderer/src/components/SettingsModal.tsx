import { Check, Cpu, KeyRound, Loader2, Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { getAgents, getSettings, saveSettings } from '../lib/api';
import type { CredentialSet, CredentialStore } from '../lib/credentials';
import type { AgentChoice, AgentId, AgentsStatus, ThinkingLevel, UserSettings } from '../types';
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

const AGENT_OPTIONS: { value: AgentPick; label: string }[] = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'opencode', label: 'opencode' },
  { value: 'custom', label: 'Custom command' },
  { value: 'off', label: 'Off' }
];

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

/** In-UI picker for the CLI coding agent that powers inference. Self-contained:
 *  fetches detection + current settings, and applies changes live (no restart,
 *  no env files). A downloaded build "just works" if any agent is installed. */
function AgentSection({ open }: { open: boolean }) {
  const [status, setStatus] = useState<AgentsStatus | null>(null);
  const [agent, setAgent] = useState<AgentChoice>('auto');
  const [agentCmd, setAgentCmd] = useState('');
  const [agentModel, setAgentModel] = useState('');
  const [agentThinking, setAgentThinking] = useState<ThinkingLevel>('default');
  const [cmdDraft, setCmdDraft] = useState('');
  // A custom command is persisted as agent='off' + a non-empty agentCmd. This flag
  // lets the user open the custom row before they've typed/applied a command.
  const [customMode, setCustomMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const [settings, agents] = await Promise.all([getSettings(), getAgents()]);
      setAgent(settings.agent);
      setAgentCmd(settings.agentCmd ?? '');
      setAgentModel(settings.agentModel ?? '');
      setAgentThinking(settings.agentThinking ?? 'default');
      setCmdDraft(settings.agentCmd ?? '');
      setCustomMode(Boolean(settings.agentCmd?.trim()));
      setStatus(agents);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the local agent server.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void refresh();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyPatch = async (patch: Partial<Pick<UserSettings, 'agent' | 'agentCmd' | 'agentModel' | 'agentThinking'>>) => {
    setSaving(true);
    setError(null);
    const next = { agent, agentCmd, agentModel, agentThinking, ...patch };
    try {
      await saveSettings(next);
      setAgent(next.agent);
      setAgentCmd(next.agentCmd);
      setAgentModel(next.agentModel);
      setAgentThinking(next.agentThinking);
      setStatus(await getAgents());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to apply agent settings.');
    } finally {
      setSaving(false);
    }
  };

  const onSelectAgent = (value: AgentPick) => {
    if (value === 'custom') {
      setCustomMode(true);
      if (cmdDraft.trim()) void applyPatch({ agent: 'off', agentCmd: cmdDraft.trim() });
      return;
    }
    setCustomMode(false);
    // Model presets are per-agent, so reset the model when switching agents.
    void applyPatch({ agent: value, agentCmd: '', agentModel: '' });
  };

  const dotFor = (id: AgentId): string | undefined => {
    const det = status?.detected.find((d) => d.id === id);
    if (!det) return undefined;
    return det.available ? '#10b981' : '#9ca3af';
  };

  const usingCustom = customMode || Boolean(agentCmd.trim());
  const pick: AgentPick = usingCustom ? 'custom' : agent;
  // The agent whose model list applies: explicit choice, or what auto resolved to.
  const tunedId: AgentId | null = !usingCustom && agent !== 'off' ? (agent === 'auto' ? status?.effective?.id ?? null : agent) : null;
  const showTuning = tunedId !== null;

  const agentOptions: DropdownOption<AgentPick>[] = AGENT_OPTIONS.map((o) => ({
    value: o.value,
    label: o.label,
    dotColor: o.value === 'claude' || o.value === 'codex' || o.value === 'opencode' ? dotFor(o.value) : undefined
  }));

  const statusLine = error ? (
    <span className="text-red-500">{error}</span>
  ) : agent === 'off' && !usingCustom ? (
    <span className="text-neutral-400">Demo mode — no agent</span>
  ) : status?.effective ? (
    <span className="text-emerald-600 dark:text-emerald-400">Ready</span>
  ) : (
    <span className="text-amber-600 dark:text-amber-400">No agent found — install one or set a custom command</span>
  );

  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center gap-2">
        <Cpu size={15} className="text-neutral-500" />
        <h3 className="text-[13.5px] font-medium">AI agent</h3>
        {(loading || saving) && <Loader2 size={13} className="animate-spin text-neutral-400" />}
      </div>
      <p className="mb-3 text-[12px] leading-5 text-neutral-500">
        Toji runs your own local coding agent for inference — no API keys.
      </p>

      <div className="space-y-2 rounded-xl border border-black/10 p-3 dark:border-white/10">
        <Dropdown<AgentPick> value={pick} options={agentOptions} onChange={onSelectAgent} disabled={saving} />

        {usingCustom && (
          <div className="flex items-center gap-2">
            <input
              value={cmdDraft}
              onChange={(e) => setCmdDraft(e.target.value)}
              placeholder="claude -p --dangerously-skip-permissions"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-lg border border-black/10 bg-transparent px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-black/30 dark:border-white/12 dark:focus:border-white/30"
            />
            <button
              type="button"
              onClick={() => cmdDraft.trim() && void applyPatch({ agent: 'off', agentCmd: cmdDraft.trim() })}
              disabled={saving || !cmdDraft.trim() || cmdDraft.trim() === agentCmd.trim()}
              className="shrink-0 rounded-lg bg-neutral-900 px-3 py-1.5 text-[12px] font-medium text-white transition enabled:hover:opacity-85 disabled:opacity-40 dark:bg-white dark:text-neutral-900"
            >
              Apply
            </button>
          </div>
        )}

        {showTuning && tunedId && (
          <div className="flex gap-2">
            <label className="flex-1">
              <span className="mb-1 block text-[11px] text-neutral-400">Model</span>
              <Dropdown<string>
                value={agentModel}
                options={MODELS[tunedId]}
                onChange={(v) => void applyPatch({ agentModel: v })}
                disabled={saving}
                placeholder="Default"
              />
            </label>
            <label className="flex-1">
              <span className="mb-1 block text-[11px] text-neutral-400">Thinking</span>
              <Dropdown<ThinkingLevel> value={agentThinking} options={THINKING} onChange={(v) => void applyPatch({ agentThinking: v })} disabled={saving} />
            </label>
          </div>
        )}

        <div className="text-[12px]">{statusLine}</div>
      </div>
    </div>
  );
}

/** Settings overlay. Edits a local DRAFT of the credential vault and only commits on Save, so it's
 *  unambiguous whether changes are persisted. Secrets are filled into login forms via
 *  {{placeholders}} and never enter the model's context. */
export function SettingsModal({ open, onClose, store, onChange }: SettingsModalProps) {
  const [draft, setDraft] = useState<CredentialStore>(store);
  // Re-seed the draft from the saved store each time the modal opens.
  useEffect(() => {
    if (open) setDraft(store);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const dirty = JSON.stringify(draft) !== JSON.stringify(store);
  const save = () => onChange(draft);

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
    <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/30 p-6 backdrop-blur-[2px]" onMouseDown={onClose}>
      <div
        className="no-drag flex max-h-[80vh] w-[min(560px,94vw)] flex-col overflow-hidden rounded-2xl border border-black/10 bg-white shadow-2xl dark:border-white/12 dark:bg-neutral-900"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-black/[0.07] px-5 py-3.5 dark:border-white/10">
          <h2 className="text-[15px] font-semibold">Settings</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-neutral-500 transition hover:bg-black/[0.05] hover:text-neutral-900 dark:hover:bg-white/10 dark:hover:text-white">
            <X size={15} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <AgentSection open={open} />

          <div className="mb-2 flex items-center gap-2">
            <KeyRound size={15} className="text-neutral-500" />
            <h3 className="text-[13.5px] font-medium">Credentials</h3>
          </div>
          <p className="mb-3 flex items-start gap-1.5 text-[12px] leading-5 text-neutral-500">
            <ShieldCheck size={14} className="mt-0.5 shrink-0 text-emerald-500" />
            <span>
              Stored only on this device. The agent fills these into login forms via placeholders like <code className="rounded bg-black/[0.06] px-1 dark:bg-white/10">{'{{password}}'}</code> — the real value is inserted locally and <strong>never sent to the model or over the network</strong>.
            </span>
          </p>

          <div className="space-y-3">
            {draft.sets.map((set) => {
              const active = (draft.activeId ?? draft.sets[0]?.id) === set.id;
              return (
                <div key={set.id} className={`rounded-xl border p-3 transition ${active ? 'border-neutral-900/30 dark:border-white/30' : 'border-black/10 dark:border-white/10'}`}>
                  <div className="mb-2 flex items-center gap-2">
                    <input
                      value={set.name}
                      onChange={(e) => patchSet(set.id, (s) => ({ ...s, name: e.target.value }))}
                      className="min-w-0 flex-1 rounded-md bg-transparent px-1.5 py-1 text-[13px] font-medium text-neutral-900 outline-none focus:bg-black/[0.04] dark:text-white dark:focus:bg-white/5"
                      placeholder="Account name"
                    />
                    <button
                      type="button"
                      onClick={() => setDraft({ ...draft, activeId: set.id })}
                      className={`rounded-md px-2 py-1 text-[11.5px] transition ${active ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900' : 'text-neutral-500 hover:bg-black/[0.05] dark:hover:bg-white/10'}`}
                    >
                      {active ? 'Active' : 'Use'}
                    </button>
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
              );
            })}
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
          <span className={`inline-flex items-center gap-1.5 text-[12px] ${dirty ? 'text-amber-500' : 'text-emerald-500'}`}>
            {dirty ? (
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
              onClick={save}
              disabled={!dirty}
              className="rounded-lg bg-neutral-900 px-3.5 py-1.5 text-[12.5px] font-medium text-white transition enabled:hover:opacity-85 disabled:opacity-40 dark:bg-white dark:text-neutral-900"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
