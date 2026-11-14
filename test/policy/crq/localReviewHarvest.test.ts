import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileLocalHarvestEffects } from '../../../src/adapters/crq/localReviewHarvest.js';
import { fileLocalExitHarvestEffects } from '../../../src/adapters/crq/localReviewExit.js';
import { harvestLocalReviewExit } from '../../../src/ops/crq/internal/localReviewExit.js';
import { fileLocalReviewPublishEffects } from '../../../src/adapters/crq/localReviewPublish.js';
import { republishLocalReview } from '../../../src/ops/crq/internal/localReviewPublish.js';
import { JsonNumber, JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import { receiptJsonDigest } from '../../../src/policy/crq/pythonJson.js';
import {
  completeLocalReview,
  type LocalHarvestEffects,
} from '../../../src/ops/crq/internal/localReviewHarvest.js';

function doc(text: string): JsonObject {
  const result = parseJsonValue(text, {
    parseConstant: (raw) =>
      JsonNumber.float(raw === 'NaN' ? NaN : raw === 'Infinity' ? Infinity : -Infinity),
  });
  if (!(result instanceof JsonObject)) throw new Error('expected object');
  return result;
}

describe('local review completion', () => {
  it('connects Python run artifacts to report, receipt and outbox through the exit adapter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-exit-'));
    try {
      const repo = 'camerontaylor/cq-toolkit';
      const oid = 'a'.repeat(40);
      const digest = 'b'.repeat(64);
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
      const queue = doc(
        JSON.stringify({
          items: [
            {
              id: 'local-1',
              kind: 'local-review',
              identity: digest,
              identity_inputs: identity,
              profile,
              run: { run_id: 'run-1' },
              observers: ['request'],
            },
          ],
          review_requests: { request: { notify: { paseo_agent_id: 'agent' } } },
        }),
      );
      const item = (queue.get('items') as JsonObject[])[0]!;
      const dir = join(root, 'runs', 'run-1');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'exit.json'), '{"exit":0,"ended_at":"2026-11-14T12:00:00Z"}');
      await writeFile(
        join(dir, 'meta.json'),
        JSON.stringify({
          item_id: 'local-1',
          label: 'review',
          run_id: 'run-1',
          base: oid,
          head: oid,
        }),
      );
      await writeFile(
        join(dir, 'review.ndjson'),
        '{"type":"finding","severity":"minor","fileName":"x","comment":"hello","number":NaN}\n',
      );
      let saved = queue;
      const saveQueue = async (q: JsonObject) => {
        saved = q;
      };
      const publication = fileLocalReviewPublishEffects({
        stateRoot: root,
        rollout: async () => ({ durableArtifactRoot: join(root, 'artifacts') }),
        saveQueue,
      });
      const harvest = fileLocalHarvestEffects({
        stateRoot: root,
        saveQueue,
        republish: async (q) => republishLocalReview(q, 0, repo, publication),
      });
      const effects = fileLocalExitHarvestEffects({
        stateRoot: root,
        harvest,
        classify: () =>
          doc('{"outcome":"completed","counted":true,"findings":1,"severity_counts":{"minor":1}}'),
        cleanup: async () => {},
        now: () => new Date('2026-11-14T12:00:00Z'),
      });
      const result = await harvestLocalReviewExit(queue, item, false, 5, {
        ...effects,
        liveness: async () => 'harvest',
      });
      expect(result.queue).toBe(saved);
      const updated = (result.queue.get('items') as JsonObject[])[0]!;
      expect(updated.get('state')).toBe('done');
      expect(updated.get('publication_reason')).toBe('publication-spooled');
      expect((result.queue.get('review_notify_outbox') as JsonObject).entries).toHaveLength(1);
      expect(await readFile(join(dir, 'findings.md'), 'utf8')).toContain('## F1 [minor] x');
      expect(await readFile(join(root, 'events.jsonl'), 'utf8')).toContain('review_finished');
      const receipt = doc(
        await readFile(join(root, 'receipts', `${updated.get('receipt_id')}.json`), 'utf8'),
      );
      expect(receipt.get('outcome')).toBe('findings');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('harvests Python-shaped run files through durable receipt and publication stores', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crq-harvest-'));
    try {
      const repo = 'camerontaylor/cq-toolkit';
      const oid = 'a'.repeat(40);
      const digest = 'b'.repeat(64);
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
      const queue = doc(
        JSON.stringify({
          items: [
            {
              id: 'local-1',
              kind: 'local-review',
              identity: digest,
              identity_inputs: identity,
              profile,
              run: { run_id: 'run-1' },
              observers: [],
            },
          ],
        }),
      );
      const item = (queue.get('items') as JsonObject[])[0]!;
      await mkdir(join(root, 'runs', 'run-1'), { recursive: true });
      await writeFile(
        join(root, 'runs', 'run-1', 'review.ndjson'),
        '{"type":"finding","severity":"minor"}\n{"type":"complete","status":"review_completed"}\n',
      );
      await writeFile(join(root, 'runs', 'run-1', 'findings.md'), 'report\r\n');
      let saved = queue;
      const saveQueue = async (q: JsonObject) => {
        saved = q;
      };
      const publication = fileLocalReviewPublishEffects({
        stateRoot: root,
        rollout: async () => ({ durableArtifactRoot: join(root, 'artifacts') }),
        saveQueue,
      });
      const effects = fileLocalHarvestEffects({
        stateRoot: root,
        saveQueue,
        republish: async (q) => republishLocalReview(q, 0, repo, publication),
      });
      const result = await completeLocalReview(
        queue,
        item,
        'run-1',
        doc('{"outcome":"completed","counted":true}'),
        '2026-11-14T12:00:00Z',
        0,
        effects,
      );
      expect(result.item.get('publication_reason')).toBe('publication-spooled');
      expect(result.queue).toBe(saved);
      const receipt = doc(
        (await readFile(join(root, 'receipts', `${result.receiptId}.json`))).toString(),
      );
      expect(receipt.get('report')).toBe('report\n');
      expect(receipt.get('outcome')).toBe('findings');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('publishes stable evidence before updating the queue and preserves unknown fields on replay', async () => {
    const queue = doc(
      '{"items":[{"id":"i","identity":"x","identity_inputs":{},"profile":{},"run":{"band":"urgent","started_at":"start"},"observers":["r"],"unknown":12345678901234567890}],"review_requests":{"r":{"notify":{"paseo_agent_id":"a"}}},"other":1.0}',
    );
    const item = (queue.get('items') as JsonObject[])[0]!;
    const order: string[] = [];
    let receipt: JsonObject | undefined;
    const effects: LocalHarvestEffects = {
      readReview: async () =>
        Buffer.from(
          '{"type":"finding","severity":"major","n":1.0}\n{"type":"finding","n":NaN}\ninvalid\n',
        ),
      readReport: async () => null,
      validateReceipt: () => {
        order.push('validate');
      },
      writeReceipt: async (value) => {
        order.push('receipt');
        receipt = value;
        return receiptJsonDigest(value);
      },
      saveQueue: async () => {
        order.push('queue');
      },
      republish: async (q) => {
        order.push('publish');
        return q;
      },
    };
    const classification = doc('{"counted":true,"outcome":"completed"}');
    const first = await completeLocalReview(queue, item, 'run', classification, 'now', 0, effects);
    expect(order).toEqual(['validate', 'receipt', 'queue', 'publish']);
    expect(receipt?.get('outcome')).toBe('findings');
    expect(receipt?.get('findings')).toHaveLength(2);
    expect(first.item.get('state')).toBe('done');
    expect((first.queue.get('review_events') as JsonObject).entries).toHaveLength(1);
    expect((first.queue.get('review_notify_outbox') as JsonObject).entries).toHaveLength(1);
    expect(first.item.get('unknown')).toBe(item.get('unknown'));
    const again = await completeLocalReview(
      first.queue,
      first.item,
      'run',
      classification,
      'now',
      0,
      effects,
    );
    expect(again.receiptId).toBe(first.receiptId);
    expect(again.item.get('attempts')).toHaveLength(1);
    expect((again.queue.get('review_notify_outbox') as JsonObject).entries).toHaveLength(1);
  });
  it('does not mutate the queue when receipt publication fails', async () => {
    const queue = doc(
      '{"items":[{"id":"i","identity":"x","identity_inputs":{},"profile":{},"run":{"band":null}}]}',
    );
    const item = (queue.get('items') as JsonObject[])[0]!;
    let saved = false;
    await expect(
      completeLocalReview(queue, item, 'r', doc('{"counted":false,"outcome":"error"}'), 'now', 1, {
        readReview: async () => Buffer.from(''),
        readReport: async () => null,
        validateReceipt: () => {},
        writeReceipt: async () => {
          throw new Error('disk');
        },
        saveQueue: async () => {
          saved = true;
        },
        republish: async (q) => q,
      }),
    ).rejects.toThrow('disk');
    expect(saved).toBe(false);
    expect(item.get('state')).toBeUndefined();
  });
  it('records an absent exit and never grants adequacy to interrupted runs', async () => {
    const queue = doc(
      '{"items":[{"id":"i","identity":"x","identity_inputs":{},"profile":{},"run":{"band":null}}]}',
    );
    const item = (queue.get('items') as JsonObject[])[0]!;
    let observed: JsonObject | undefined;
    const result = await completeLocalReview(
      queue,
      item,
      'run',
      doc('{"counted":false,"outcome":"interrupted"}'),
      'now',
      null,
      {
        readReview: async () => Buffer.from(''),
        readReport: async () => null,
        validateReceipt: () => {},
        writeReceipt: async (value) => {
          observed = value.get('observed') as JsonObject;
          return receiptJsonDigest(value);
        },
        saveQueue: async () => {},
        republish: async (q) => q,
      },
    );
    expect(observed?.get('exit_code')).toBeNull();
    expect(result.item.get('state')).toBe('failed');
    expect(result.item.get('scope_adequate')).toBe(false);
    expect((result.item.get('attempts') as JsonObject[])[0]!.get('band')).toBeNull();
  });
});
