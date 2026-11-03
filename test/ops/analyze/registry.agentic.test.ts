// Split provenance: test/ops/analyze/registry.test.ts was split into the
// registry.*.test.ts siblings in this directory; shared fixtures live in
// registry.helpers.ts. This file carries the agentic importer's resolution
// over the constructed subprocess floor driver.
import { afterEach, describe, expect, test } from 'vitest';
import { registry, setAnalyzeApprovalAuthority } from '../../../src/ops/analyze/registry.js';

// The authority binding is PROCESS-WIDE module state (the same reason the
// playbook registry and quarantine ledger are shared), so every test must
// hand it back. Without this, one test binding an authority would silently
// authorize writes in the next — the exact failure the deny-all default
// exists to prevent.
afterEach(() => {
  setAnalyzeApprovalAuthority(undefined);
});

describe('the agentic importer resolves (the subprocess floor lane, composed at the importer)', () => {
  test('analyze.agenticRemediation resolves to an op over a constructed driver (construction spawns nothing)', async () => {
    const entry = registry.find((candidate) => candidate.name === 'analyze.agenticRemediation');
    if (!entry) throw new Error('analyze.agenticRemediation missing from the registry');
    const op = await entry.importer();
    expect(typeof op).toBe('function');
    // The importer's op is erased — assert over the WHOLE result: a MISSING
    // driver would be `failed`, but the registry binds the subprocess floor
    // driver, so a complete scripted... the honest check here is that the
    // wired driver produces the taxonomy mapping, not a fabricated run.
    const cluster = {
      id: '0deadbe0',
      signature: '["oxlint","r","boom"]',
      tool: 'oxlint',
      ruleId: 'r',
      confidence: 'low' as const,
      failures: [
        {
          file: 'src/a.ts',
          line: 1,
          column: 1,
          ruleId: 'r',
          message: 'boom',
          severity: 'error' as const,
        },
      ],
      size: 1,
    };
    const result = await op({
      clusterId: '0deadbe0',
      cluster,
      modelSpec: { model: 'definitely-not-a-model', provider: 'definitely-not-a-provider' },
      // Invocation data only: SubprocessDriver IGNORES Budget.wallClockMs
      // (the governor owns wall clock — I8). The no-hang protection here is
      // the unroutable model (routing throws PRE-dispatch, before any spawn)
      // plus this test's own explicit vitest timeout below.
      budget: { wallClockMs: 5_000 },
    });
    // The real driver runs (no binary/spawn succeeds in the sandbox) — the
    // op must surface that honestly, never as an ok with a fabricated
    // WorkerResult and never as a throw across the seam. The unroutable
    // model is a PRE-DISPATCH DispatchError('config'), which the §2.9 throw
    // mapping settles as `needs-human` (a misconfiguration is the human's
    // to fix — `failed` would claim a definitive worker outcome the op
    // never observed, and a bare `indeterminate` would hide the class).
    expect(result.status).toBe('needs-human');
  }, 20_000);
});
