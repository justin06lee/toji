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
    // `value` left the contract with the manifest, but models still send it.
    expect(sanitize({ action: 'fillCredential', value: 'cred-7' } as unknown as AgentStepResult).credentialId).toBe('cred-7');
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

  // Screenshot-only contract: pointing actions carry coordinates, not element ids.
  it('keeps click coordinates and accepts clickAt as an alias', () => {
    const click = sanitize({ action: 'click', x: 412, y: 96 } as AgentStepResult);
    expect(click.action).toBe('click');
    expect([click.x, click.y]).toEqual([412, 96]);
    expect(sanitize({ action: 'clickAt', x: 10, y: 20 } as unknown as AgentStepResult).action).toBe('click');
  });

  it('maps the retired manifest verbs onto something that still moves the run forward', () => {
    // A screenshot already arrives every turn, so asking for one is just a re-look.
    expect(sanitize({ action: 'look' } as unknown as AgentStepResult).action).toBe('wait');
    // Native <select> popups can't be captured; choosing is done with the keyboard.
    expect(sanitize({ action: 'select', key: 'Enter' } as unknown as AgentStepResult).action).toBe('press');
  });

  it('completes a drag whose start point arrived as x/y', () => {
    const drag = sanitize({ action: 'drag', x: 5, y: 6, toX: 50, toY: 60 } as AgentStepResult);
    expect([drag.fromX, drag.fromY, drag.toX, drag.toY]).toEqual([5, 6, 50, 60]);
  });
});
