import { describe, expect, it } from 'vitest';
import { sanitize, type AgentStepResult } from './webAgent.js';

describe('sanitize', () => {
  it('canonicalizes the credential tool actions instead of degrading them to wait', () => {
    expect(sanitize({ action: 'findCredentials' } as AgentStepResult).action).toBe('findCredentials');
    expect(sanitize({ action: 'FINDCREDENTIALS' } as unknown as AgentStepResult).action).toBe('findCredentials');
    const fill = sanitize({ action: 'fillCredential', credentialId: ' cred-123 ' } as AgentStepResult);
    expect(fill.action).toBe('fillCredential');
    expect(fill.credentialId).toBe('cred-123');
  });

  it('recovers a credential id the model put in the wrong field', () => {
    expect(sanitize({ action: 'fillCredential', text: 'cred-9' } as AgentStepResult).credentialId).toBe('cred-9');
    expect(sanitize({ action: 'fillCredential', value: 'cred-7' } as AgentStepResult).credentialId).toBe('cred-7');
  });

  it('falls back to wait (never done) for an unrecognized action', () => {
    const out = sanitize({ action: 'teleport' } as unknown as AgentStepResult);
    expect(out.action).toBe('wait');
    expect(out.done).toBe(false);
  });

  it('coalesces free-form payloads into their required field', () => {
    expect(sanitize({ action: 'research', text: 'how to castle' } as AgentStepResult).query).toBe('how to castle');
    expect(sanitize({ action: 'ask', query: 'which account?' } as AgentStepResult).question).toBe('which account?');
  });
});
