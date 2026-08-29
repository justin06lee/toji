import { describe, expect, it } from 'vitest';
import { capabilitiesFor, findModel, qualifyModel, type ModelCatalog } from './yagamiCatalog.js';

// A stand-in for a real probe (which spawns a process per harness): Claude as the
// default provider, Codex alongside it, and an ACP harness with no effort control.
const caps = (over: Partial<ModelCatalog['providers'][number]['capabilities']> = {}) => ({
  resume: true,
  fork: false,
  images: true,
  documents: false,
  systemPrompt: false,
  thinking: false,
  effort: false,
  streaming: 'tokens' as const,
  ...over
});

const catalog: ModelCatalog = {
  defaultProvider: 'claude',
  at: '2026-08-28T00:00:00.000Z',
  providers: [
    { id: 'claude', label: 'Claude Code', usable: true, modelCount: 2, capabilities: caps({ fork: true, documents: true, systemPrompt: true, thinking: true, effort: true }) },
    { id: 'codex', label: 'Codex CLI', usable: true, modelCount: 1, capabilities: caps({ effort: true, streaming: 'chunks' }) },
    { id: 'opencode', label: 'OpenCode', usable: true, modelCount: 1, capabilities: caps() },
    { id: 'gemini', label: 'Gemini CLI', usable: false, error: 'gemini: ACP connection closed', modelCount: 0, capabilities: caps() }
  ],
  models: [
    { id: 'claude:sonnet', model: 'sonnet', provider: 'claude', providerLabel: 'Claude Code', label: 'Sonnet', resolvedModel: 'claude-sonnet-5' },
    { id: 'claude:opus[1m]', model: 'opus[1m]', provider: 'claude', providerLabel: 'Claude Code', label: 'Opus (1M context)' },
    { id: 'codex:gpt-5.6-luna', model: 'gpt-5.6-luna', provider: 'codex', providerLabel: 'Codex CLI', label: 'GPT-5.6-Luna' },
    { id: 'opencode:opencode/big-pickle', model: 'opencode/big-pickle', provider: 'opencode', providerLabel: 'OpenCode', label: 'OpenCode Zen/Big Pickle' }
  ]
};

describe('qualifyModel', () => {
  it('routes a bare non-Claude model to its own harness', () => {
    // The regression this exists for: bare ids default to Claude Code, which rejects
    // every call with "There's an issue with the selected model (gpt-5.6-luna)".
    expect(qualifyModel('gpt-5.6-luna', catalog)).toBe('codex:gpt-5.6-luna');
    expect(qualifyModel('opencode/big-pickle', catalog)).toBe('opencode:opencode/big-pickle');
  });

  it('leaves an already-qualified id alone', () => {
    expect(qualifyModel('codex:gpt-5.6-luna', catalog)).toBe('codex:gpt-5.6-luna');
    expect(qualifyModel('opencode:opencode/big-pickle', catalog)).toBe('opencode:opencode/big-pickle');
  });

  it('qualifies the default provider’s own models too, so the id is stable', () => {
    expect(qualifyModel('sonnet', catalog)).toBe('claude:sonnet');
    expect(qualifyModel('opus[1m]', catalog)).toBe('claude:opus[1m]');
  });

  it('keeps a bare provider id (that harness’s default model)', () => {
    expect(qualifyModel('codex', catalog)).toBe('codex');
  });

  it('passes through the empty value and anything no harness claims', () => {
    expect(qualifyModel('', catalog)).toBe('');
    expect(qualifyModel('  ', catalog)).toBe('');
    expect(qualifyModel('llama-9', catalog)).toBe('llama-9');
  });

  it('is a no-op against an unprobed catalog', () => {
    const empty: ModelCatalog = { models: [], providers: [], defaultProvider: '', at: '' };
    expect(qualifyModel('gpt-5.6-luna', empty)).toBe('gpt-5.6-luna');
    expect(qualifyModel('codex:gpt-5.6-luna', empty)).toBe('codex:gpt-5.6-luna');
  });
});

describe('findModel', () => {
  it('finds a model from either the bare or the qualified id', () => {
    expect(findModel('gpt-5.6-luna', catalog)?.label).toBe('GPT-5.6-Luna');
    expect(findModel('codex:gpt-5.6-luna', catalog)?.providerLabel).toBe('Codex CLI');
  });

  it('returns nothing for a model no harness offers', () => {
    expect(findModel('llama-9', catalog)).toBeUndefined();
  });
});

describe('capabilitiesFor', () => {
  it('reports the capabilities of the harness behind the model, not Claude’s', () => {
    expect(capabilitiesFor('gpt-5.6-luna', catalog)?.effort).toBe(true);
    // ACP harnesses have no reasoning-effort control; Thinking must not be sent.
    expect(capabilitiesFor('opencode/big-pickle', catalog)?.effort).toBe(false);
    expect(capabilitiesFor('sonnet', catalog)?.thinking).toBe(true);
  });

  it('falls back to the default provider for a bare/unknown id', () => {
    expect(capabilitiesFor('', catalog)?.systemPrompt).toBe(true);
  });
});
