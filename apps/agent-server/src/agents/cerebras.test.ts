import { describe, expect, it } from 'vitest';
import { CEREBRAS_BASE_URL, cerebrasErrorMessage } from './cerebras.js';

describe('cerebrasErrorMessage', () => {
  // The real body Cerebras returns for an account with no credits.
  const paymentBody = JSON.stringify({
    message: 'Payment required to access this resource. Visit your billing tab.',
    type: 'payment_required_error',
    param: 'quota',
    code: 'payment_required'
  });

  it('tells an empty balance apart from a bad key', () => {
    const message = cerebrasErrorMessage(402, paymentBody);
    expect(message).toContain('Payment required');
    expect(message).toContain('the key itself is fine');
    expect(message).not.toMatch(/rejected|invalid/i);
  });

  it('trusts the payment code even when the status is not 402', () => {
    expect(cerebrasErrorMessage(400, paymentBody)).toContain('Add credits');
  });

  it('names an auth failure as an auth failure', () => {
    const body = JSON.stringify({ message: 'Wrong API Key', type: 'authentication_error' });
    expect(cerebrasErrorMessage(401, body)).toContain('rejected the API key');
    expect(cerebrasErrorMessage(403, body)).toContain('rejected the API key');
  });

  it('flags rate limiting separately', () => {
    expect(cerebrasErrorMessage(429, JSON.stringify({ message: 'too many requests' }))).toContain('rate limit');
  });

  it('survives a non-JSON body', () => {
    expect(cerebrasErrorMessage(500, '<html>gateway error</html>')).toBe('Cerebras error 500: <html>gateway error</html>');
  });
});

describe('CEREBRAS_BASE_URL', () => {
  it('has no trailing slash, so `${base}/chat/completions` is well formed', () => {
    expect(CEREBRAS_BASE_URL).toBe('https://api.cerebras.ai/v1');
    expect(`${CEREBRAS_BASE_URL}/chat/completions`).toBe('https://api.cerebras.ai/v1/chat/completions');
  });
});
