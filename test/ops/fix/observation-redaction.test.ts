import { afterEach, describe, expect, it } from 'vitest';
import { repoIdFromRemote, sanitizeObservation } from '../../../src/ops/fix/attemptRecord.js';

// Fake/local fixtures only: no repositories, providers or credentials.
const savedEnv: Record<string, string | undefined> = {};
function withFakeEnv(name: string, value: string): void {
  savedEnv[name] = process.env[name];
  process.env[name] = value;
}
afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('observation redaction (T12)', () => {
  it('redacts environment secret values in persisted text fields', () => {
    withFakeEnv('FAKE_OBSERVATION_SECRET', 'hushhushsecretvalue');
    const out = sanitizeObservation({
      stopReason: 'model said hushhushsecretvalue aloud',
      reason: 'env hushhushsecretvalue echoed by vendor SDK',
      nested: { error: { type: 'hushhushsecretvalue' } },
    });
    expect(out).toEqual({
      stopReason: 'model said [redacted] aloud',
      reason: 'env [redacted] echoed by vendor SDK',
      nested: { error: { type: '[redacted]' } },
    });
  });

  it('strips credential URLs in error and provenance strings', () => {
    const out = sanitizeObservation({
      error: 'fetch failed for https://ci-bot:hunter2@git.example.com/acme/repo?token=abc',
      provenance: 'cloned from https://deploy:s3cret@git.example.com/acme/repo',
    });
    expect(out.error).toEqual('fetch failed for https://git.example.com/acme/repo');
    expect(out.provenance).toEqual('cloned from https://git.example.com/acme/repo');
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(JSON.stringify(out)).not.toContain('s3cret');
  });

  it('redacts stop text and preserves structure', () => {
    withFakeEnv('FAKE_STOP_TOKEN', 'leaky-leaky');
    const out = sanitizeObservation(['worker stopped: leaky-leaky', 'plain stop text survives']);
    expect(out).toEqual(['worker stopped: [redacted]', 'plain stop text survives']);
  });

  it('repo identifiers expose only the opaque digest', () => {
    const id = repoIdFromRemote('ssh://git@github.com/camerontaylor/cq-toolkit.git');
    expect(id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(id).not.toContain('camerontaylor');
    expect(id).toEqual(repoIdFromRemote('ssh://github.com/camerontaylor/cq-toolkit.git'));
    expect(repoIdFromRemote(undefined)).toEqual(null);
  });
});
