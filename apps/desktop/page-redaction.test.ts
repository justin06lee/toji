import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { redactManifestValues } = require('./page-redaction.cjs') as typeof import('./page-redaction.cjs');

describe('redactManifestValues', () => {
  it('removes password and ordinary input values from model-facing manifests', () => {
    const manifest = [
      '[4] textbox "Email" value="ada@example.com" placeholder="Email"',
      '[5] textbox "Password" value="correct horse battery staple"',
      '[6] button "Sign in"'
    ].join('\n');

    const redacted = redactManifestValues(manifest);
    expect(redacted).not.toContain('ada@example.com');
    expect(redacted).not.toContain('correct horse battery staple');
    expect(redacted).toContain('[4] textbox "Email" value="[redacted]" placeholder="Email"');
    expect(redacted).toContain('[6] button "Sign in"');
  });

  it('handles JSON-escaped quotes without leaving a partial secret', () => {
    expect(redactManifestValues('[1] textbox value="a\\\"b\\\\c"')).toBe('[1] textbox value="[redacted]"');
  });

  it('leaves non-string bridge results unchanged', () => {
    expect(redactManifestValues(undefined)).toBeUndefined();
  });
});
