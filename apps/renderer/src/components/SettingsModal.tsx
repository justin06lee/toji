import { AlertTriangle, Check, Cpu, KeyRound, Loader2, Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { getAgents, getSettings, saveSettings } from '../lib/api';
import type { CredentialSet, CredentialStore } from '../lib/credentials';
import type { AgentChoice, AgentsStatus } from '../types';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  store: CredentialStore;
  onChange: (store: CredentialStore) => void;
}

let uid = 0;
const newId = () => `set-${Date.now()}-${(uid += 1)}`;

const AGENT_OPTIONS: { value: AgentChoice | 'custom'; label: string }[] = [
  { value: 'auto', label: 'Auto-detect (recommended)' },
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'opencode', label: 'opencode' },
  { value: 'custom', label: 'Custom command…' },
  { value: 'off', label: 'Off (demo mode)' }
];

/** In-UI picker for the CLI coding agent that powers inference. Self-contained:
 *  fetches detection + current settings, and applies changes live (no restart,
 *  no env files). A downloaded build "just works" if any agent is installed. */
function AgentSection({ open }: { open: boolean }) {
  const [status, setStatus] = useState<AgentsStatus | null>(null);
  const [agent, setAgent] = useState<AgentChoice>('auto');
  const [agentCmd, setAgentCmd] = useState('');
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

  const apply = async (nextAgent: AgentChoice, nextCmd: string) => {
    setSaving(true);
    setError(null);
    try {
      await saveSettings({ agent: nextAgent, agentCmd: nextCmd });
      setAgent(nextAgent);
      setAgentCmd(nextCmd);
      setStatus(await getAgents());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to apply agent settings.');
    } finally {
      setSaving(false);
    }
  };

  const onSelect = (value: AgentChoice | 'custom') => {
    if (value === 'custom') {
      setCustomMode(true);
      // Apply right away only if a command is already typed; else just reveal the row.
      if (cmdDraft.trim()) void apply('off', cmdDraft.trim());
      return;
    }
    setCustomMode(false);
    void apply(value, '');
  };

  const detectedFor = (id: string) => status?.detected.find((d) => d.id === id);
  const noneAvailable = status ? !status.available : false;
  const usingCustom = customMode || Boolean(agentCmd.trim());
  const selectMode: AgentChoice | 'custom' = usingCustom ? 'custom' : agent;

  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center gap-2">
        <Cpu size={15} className="text-neutral-500" />
        <h3 className="text-[13.5px] font-medium">AI agent</h3>
        {(loading || saving) && <Loader2 size={13} className="animate-spin text-neutral-400" />}
      </div>
      <p className="mb-3 text-[12px] leading-5 text-neutral-500">
        Toji runs your own local coding agent for inference — no API keys. Pick one you have installed; Auto-detect finds it for you.
      </p>

      <div className="rounded-xl border border-black/10 p-3 dark:border-white/10">
        <select
          value={usingCustom ? 'custom' : selectMode}
          onChange={(e) => onSelect(e.target.value as AgentChoice | 'custom')}
          disabled={saving}
          className="w-full rounded-lg border border-black/10 bg-transparent px-2.5 py-2 text-[13px] outline-none focus:border-black/30 disabled:opacity-50 dark:border-white/12 dark:focus:border-white/30"
        >
          {AGENT_OPTIONS.map((opt) => {
            const det = detectedFor(opt.value);
            const suffix = det ? (det.available ? ' — detected' : ' — not found') : '';
            return (
              <option key={opt.value} value={opt.value}>
                {opt.label}
                {suffix}
              </option>
            );
          })}
        </select>

        {usingCustom && (
          <div className="mt-2 flex items-center gap-2">
            <input
              value={cmdDraft}
              onChange={(e) => setCmdDraft(e.target.value)}
              placeholder="e.g. /opt/homebrew/bin/claude -p --dangerously-skip-permissions"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-lg border border-black/10 bg-transparent px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-black/30 dark:border-white/12 dark:focus:border-white/30"
            />
            <button
              type="button"
              onClick={() => cmdDraft.trim() && void apply('off', cmdDraft.trim())}
              disabled={saving || !cmdDraft.trim() || cmdDraft.trim() === agentCmd.trim()}
              className="shrink-0 rounded-lg bg-neutral-900 px-3 py-1.5 text-[12px] font-medium text-white transition enabled:hover:opacity-85 disabled:opacity-40 dark:bg-white dark:text-neutral-900"
            >
              Apply
            </button>
          </div>
        )}

        {/* Live status: what command will actually run, or a warning when nothing is found. */}
        <div className="mt-2.5 text-[12px]">
          {error ? (
            <span className="inline-flex items-center gap-1.5 text-red-500">
              <AlertTriangle size={13} /> {error}
            </span>
          ) : status?.effective ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
              <Check size={13} /> Using <strong className="font-medium">{status.effective.label}</strong>
              <code className="ml-1 truncate rounded bg-black/[0.06] px-1.5 py-0.5 font-mono text-[11px] dark:bg-white/10">{status.effective.command}</code>
            </span>
          ) : noneAvailable && selectMode !== 'off' ? (
            <span className="inline-flex items-start gap-1.5 text-amber-600 dark:text-amber-400">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>No coding agent found. Install Claude Code, Codex, or opencode — or choose a Custom command. Toji uses demo output until then.</span>
            </span>
          ) : selectMode === 'off' ? (
            <span className="text-neutral-500">Agent off — Toji uses deterministic demo output.</span>
          ) : null}
        </div>
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
