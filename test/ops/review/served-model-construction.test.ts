// S4b-B (ADR-0002 §2.6) — review.fixItem's REAL served-model construction
// path. The FACTORY is the one served-model hook for toolkit dispatch, so
// the construction path under test is makeFixReviewItem over
// createDriverFactory → the subprocess lane over the fake CLI (the same
// shape as test/driver/served-model-construction.test.ts's S1 leg). The
// lane binding is explicit factory config — the conservative defaults
// never resolve to a host-CLI lane, and no lane class is constructed here.
//
// CONTROL and TREATMENT differ only in the served model the fake CLI
// reports; both inner results are complete and carry the same valid,
// successful fix contract. CONTROL → ok (the parsed triple); TREATMENT →
// the wrapper rewrites the verdict to error/served-model-mismatch, and the
// op maps that to `failed` per ADR-0002 §2.9 with the class named in the
// text — a served-model mismatch can no longer masquerade as a clean
// no-change fix.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createDriverFactory } from '../../../src/driver/factory.js';
import { makeFixReviewItem } from '../../../src/ops/review/fixReviewItem.js';
import type { FixReviewItemInput } from '../../../src/ops/review/fixReviewItem.js';
import { defaultHarnessConfig } from '../../../src/harness/config.js';

const FAKE_CLI = fileURLToPath(new URL('../../fixtures/fake-agent-cli.mjs', import.meta.url));
const temporary: string[] = [];

// The strict op-side parse accepts exactly this no-change fix contract
// (changed false ⇔ empty commits, non-empty summary).
const FIX_CONTRACT = { changed: false, summary: 'Already addressed.', commits: [] };

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'review-served-construction-'));
  temporary.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const inputFor = (root: string): FixReviewItemInput => ({
  pr: 7,
  item: { id: 'thread-7', path: 'src/a.ts', line: 1, body: 'Check the result.', comments: [] },
  worktree: { path: root, branch: 'review/pr-7' },
  driver: { model: 'construction-model', provider: 'construction' },
  // All tools disabled → an EMPTY harness selection → the lane runs its
  // stock surface (no MCP config, no harness server spawn) — the same
  // posture as the S1 leg in test/driver/served-model-construction.test.ts
  // (whose op passes no harness at all). The served-model property under
  // test is orthogonal to the tool surface.
  harness: {
    ...defaultHarnessConfig,
    tools: {
      ...defaultHarnessConfig.tools,
      read: { ...defaultHarnessConfig.tools.read, enabled: false },
      edit: { ...defaultHarnessConfig.tools.edit, enabled: false },
      run: { ...defaultHarnessConfig.tools.run, enabled: false },
    },
  },
});

describe('S4b review.fixItem served-model construction', () => {
  test.each(['CONTROL', 'TREATMENT'] as const)(
    'a factory-resolved fixer worker %s: dispatch succeeds only for the requested model',
    async (variant) => {
      const root = await fixture();
      const binary = [
        'env',
        'FAKE_AGENT_MODE=structured-ok',
        `FAKE_AGENT_STRUCTURED_RAW=${JSON.stringify(FIX_CONTRACT)}`,
        ...(variant === 'TREATMENT' ? ['FAKE_AGENT_SERVED_MODEL=remapped'] : []),
        process.execPath,
        FAKE_CLI,
      ];
      vi.stubEnv('CQ_CONSTRUCTION_KEY', 'offline-fixture-key');
      const op = makeFixReviewItem({
        drivers: createDriverFactory({
          bindings: { fixer: { construction: 'subprocess' } },
          lanes: {
            subprocess: {
              binary,
              sessionsDir: join(root, 'sessions'),
              routingTable: {
                endpoints: {
                  construction: {
                    baseUrlEnv: 'CQ_CONSTRUCTION_URL',
                    baseUrlDefault: 'https://unused.invalid',
                    keyEnv: 'CQ_CONSTRUCTION_KEY',
                    models: ['construction-model'],
                    notes: 'Offline fake CLI; no network calls',
                  },
                },
              },
            },
          },
        }),
      });
      const result = await op(inputFor(root));
      if (variant === 'CONTROL') {
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') throw new Error(`unexpected ${result.status}`);
        expect(result.value).toMatchObject({
          changed: false,
          summary: 'Already addressed.',
          commits: [],
        });
      } else {
        expect(result.status).toBe('failed');
        if (result.status !== 'failed') throw new Error(`unexpected ${result.status}`);
        expect(result.error).toContain("requested 'construction-model', served 'remapped'");
        expect(result.error).toContain('errorClass=served-model-mismatch');
        // The mismatch verdict outranks the valid payload: the ok value
        // (the parsed fix contract) never surfaces.
        expect(result).not.toHaveProperty('value');
        expect(JSON.stringify(result)).not.toContain('Already addressed.');
      }
    },
  );
});
