import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import { writeLocalReviewReceipt } from '../../../src/adapters/crq/localReviewReceipt.js';
import { fileLocalReviewPublishEffects } from '../../../src/adapters/crq/localReviewPublish.js';
import { republishLocalReview } from '../../../src/ops/crq/internal/localReviewPublish.js';
function doc(text: string): JsonObject {
  const v = parseJsonValue(text);
  if (!(v instanceof JsonObject)) throw new Error('object');
  return v;
}
describe('local review publication', () => {
  it('spools unverified full-diff evidence through real disk stores and requests background publication', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crq-publish-'));
    try {
      const receipt = doc('{"observed":{"exit_code":0},"findings":[]}');
      const id = await writeLocalReviewReceipt(join(dir, 'receipts'), receipt);
      const oid = 'a'.repeat(40);
      const digest = 'b'.repeat(64);
      const queue = doc(
        JSON.stringify({
          items: [
            {
              kind: 'local-review',
              identity: digest,
              identity_inputs: {
                repo: 'camerontaylor/cq-toolkit',
                base_commit: oid,
                head_commit: oid,
                head_tree: oid,
                config_digest: digest,
              },
              receipt_id: id,
              local_run_id: 'run',
              completed_at: '2026-11-14T12:00:00Z',
              publication_pending: true,
            },
          ],
        }),
      );
      let saved: JsonObject | undefined;
      const effects = fileLocalReviewPublishEffects({
        stateRoot: dir,
        rollout: async () => ({ durableArtifactRoot: join(dir, 'artifacts') }),
        saveQueue: async (value) => {
          saved = value;
        },
      });
      const result = await republishLocalReview(queue, 0, 'camerontaylor/cq-toolkit', effects);
      const item = (result.get('items') as JsonObject[])[0]!;
      expect(item.get('publication_reason')).toBe('publication-spooled');
      const eventId = item.get('publication_event_id');
      expect(typeof eventId).toBe('string');
      const event = doc(
        (
          await readFile(join(dir, 'backfill', 'publication', 'pending', `${eventId}.json`))
        ).toString(),
      );
      expect((event.get('payload') as JsonObject).get('outcome')).toBe('unverified');
      expect((event.get('payload') as JsonObject).get('reviewed_scope')).toEqual([]);
      expect(await readFile(join(dir, 'backfill', 'publish-request.json'))).toBeDefined();
      expect(saved).toBe(result);
      const replay = await republishLocalReview(result, 0, 'camerontaylor/cq-toolkit', effects);
      expect((replay.get('items') as JsonObject[])[0]!.get('publication_event_id')).toBe(eventId);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
