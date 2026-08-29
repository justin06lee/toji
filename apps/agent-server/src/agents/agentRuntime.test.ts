import { describe, expect, it } from 'vitest';
import { getActiveBackend, normalizeAgentChoice, setAgentChoice, setApiConfig } from './agentRuntime.js';

describe('normalizeAgentChoice', () => {
  it('keeps the real choices', () => {
    expect(normalizeAgentChoice('yagami')).toBe('yagami');
    expect(normalizeAgentChoice('local')).toBe('local');
    expect(normalizeAgentChoice('off')).toBe('off');
  });

  it('routes every legacy backend name through yagami', () => {
    for (const legacy of ['claude', 'codex', 'opencode', 'auto', 'anthropic', 'openai', '', undefined]) {
      expect(normalizeAgentChoice(legacy)).toBe('yagami');
    }
  });
});

describe('backend resolution', () => {
  it('custom endpoint uses the configured URL, key, and model', () => {
    setApiConfig({ localUrl: 'http://127.0.0.1:11434/v1/', localModel: 'llama3.2', localApiKey: 'tok' });
    setAgentChoice({ agent: 'local', agentModel: '', agentThinking: 'default' });
    expect(getActiveBackend()).toEqual({
      kind: 'api',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: 'tok',
      model: 'llama3.2',
      label: 'custom endpoint · llama3.2',
      thinking: 'default'
    });
  });

  it('cerebras needs both a key and a model before it is a usable backend', () => {
    setApiConfig({ cerebrasApiKey: 'csk-test', cerebrasModel: '' });
    setAgentChoice({ agent: 'cerebras', agentModel: '', agentThinking: 'default' });
    expect(getActiveBackend()).toBeNull();

    setApiConfig({ cerebrasModel: 'gpt-oss-120b' });
    expect(getActiveBackend()).toEqual({
      kind: 'api',
      baseUrl: 'https://api.cerebras.ai/v1',
      apiKey: 'csk-test',
      model: 'gpt-oss-120b',
      label: 'Cerebras · gpt-oss-120b',
      thinking: 'default'
    });
  });

  it('a key typed into settings overrides the one from the environment', () => {
    setApiConfig({ cerebrasApiKey: 'csk-from-settings', cerebrasModel: 'gpt-oss-120b' });
    setAgentChoice({ agent: 'cerebras', agentModel: '', agentThinking: 'default' });
    expect((getActiveBackend() as { apiKey: string }).apiKey).toBe('csk-from-settings');
  });

  it('off means no backend (demo mode)', () => {
    setAgentChoice({ agent: 'off', agentModel: '', agentThinking: 'default' });
    expect(getActiveBackend()).toBeNull();
  });

  it('yagami backend carries the model override and thinking level', () => {
    setAgentChoice({ agent: 'yagami', agentModel: 'codex:gpt-5.6-sol', agentThinking: 'high' });
    const backend = getActiveBackend();
    // On a machine with no harness installed the backend is null; with one, it's yagami.
    // The catalog is unprobed here, so an already-qualified id passes through untouched.
    if (backend) {
      expect(backend).toEqual({
        kind: 'yagami',
        model: 'codex:gpt-5.6-sol',
        label: 'Yagami · codex:gpt-5.6-sol',
        thinking: 'high',
        supportsEffort: true
      });
    } else {
      expect(backend).toBeNull();
    }
  });
});
