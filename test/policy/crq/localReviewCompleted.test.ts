import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalReviewCompletedCaller } from '../../../src/adapters/crq/localReviewCompleted.js';
import { fileLocalHarvestEffects } from '../../../src/adapters/crq/localReviewHarvest.js';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';

describe('completed cycle adapter', () => {
  it('reconciles an on-disk cycle and refuses a different recorded artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-completed-'));
    const dir = join(root, 'runs', 'old');
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'review.ndjson');
    await writeFile(path, '{"type":"complete","status":"review_completed"}\n');
    const other = join(root, 'other.ndjson');
    await writeFile(other, '{"type":"complete","status":"review_completed"}\n');
    const oid = 'a'.repeat(40);
    const digest = 'b'.repeat(64);
    const repo = 'a/b';
    const profile = { adapter: 'coderabbit-cli', revision: 'v1', flags: [] };
    const identity = {
      v: 1,
      repo,
      base_commit: oid,
      base_tree: oid,
      head_commit: oid,
      head_tree: oid,
      scope: 'full-diff',
      projection: 'full-diff',
      config_digest: digest,
      profile: { adapter: 'coderabbit-cli', revision: 'v1' },
    };
    const wanted = parseJsonValue(JSON.stringify(identity)) as JsonObject;
    const queue = (ndjson: string) =>
      parseJsonValue(
        JSON.stringify({
          items: [
            {
              id: 'local-1',
              kind: 'local-review',
              state: 'pending',
              identity: digest,
              identity_inputs: identity,
              profile,
              generation: 1,
            },
            {
              kind: 'open',
              repo,
              cycles: [
                {
                  base: oid,
                  head: oid,
                  profile,
                  range_policy: 'full-range-once-v1',
                  run_id: 'old',
                  ndjson,
                },
              ],
            },
          ],
        }),
      ) as JsonObject;
    let saved: JsonObject | undefined;
    let swap = false;
    let calls = 0;
    const caller = createLocalReviewCompletedCaller({
      stateRoot: root,
      runnerRepo: repo,
      facts: {
        historyGit: () => async () => Buffer.from(oid),
        resolveIdentity: async () => wanted,
      },
      saveQueue: async (q) => {
        saved = q;
      },
      rollout: async () => null,
      now: () => {
        if (swap && ++calls === 2) writeFileSync(path, '{"type":"finding","comment":"swapped"}\n');
        return new Date('2026-11-14T12:00:00Z');
      },
    });
    const rejected = await caller.reconcile(queue(other), 5);
    expect((rejected.get('items') as JsonObject[])[0]!.get('state')).toBe('pending');
    expect(saved).toBeUndefined();
    swap = true;
    const result = await caller.reconcile(queue(path), 5);
    const item = (result.get('items') as JsonObject[])[0]!;
    expect(item.get('state')).toBe('done');
    expect(item.get('publication_reason')).toBe('publication-disabled');
    expect((saved!.get('items') as JsonObject[])[0]!.get('publication_reason')).toBe(
      'publication-disabled',
    );
    const receipt = await readFile(
      join(root, 'receipts', `${item.get('receipt_id')}.json`),
      'utf8',
    );
    expect(receipt).toContain('local-review-full-diff');
    expect(receipt).not.toContain('swapped');
  });
  it('rejects traversal and symlinked run directories and artifacts on harvest reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-containment-'));
    const runs = join(root, 'runs');
    const outside = join(root, 'outside');
    await mkdir(runs);
    await mkdir(outside);
    await writeFile(join(outside, 'review.ndjson'), 'outside');
    await writeFile(join(outside, 'findings.md'), 'outside');
    await symlink(outside, join(runs, 'linked'));
    await mkdir(join(runs, 'run'));
    await symlink(join(outside, 'review.ndjson'), join(runs, 'run', 'review.ndjson'));
    await symlink(join(outside, 'findings.md'), join(runs, 'run', 'findings.md'));
    const effects = fileLocalHarvestEffects({
      stateRoot: root,
      saveQueue: async () => {},
      republish: async (q) => q,
    });
    await expect(effects.readReview('../outside')).rejects.toThrow();
    await expect(effects.readReview('linked')).rejects.toThrow();
    await expect(effects.readReview('run')).rejects.toThrow();
    await expect(effects.readReport('linked')).rejects.toThrow();
    await expect(effects.readReport('run')).rejects.toThrow();
  });
});
