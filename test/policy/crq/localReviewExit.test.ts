import { describe, expect, it } from 'vitest';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import { withObjectKeys } from '../../../src/policy/crq/queueDoc.js';
import {
  harvestLocalReviewExit,
  LocalReviewCleanupError,
  type LocalExitHarvestEffects,
} from '../../../src/ops/crq/internal/localReviewExit.js';
import { renderLocalReviewFindings } from '../../../src/ops/crq/internal/localReviewReport.js';
function doc(text: string): JsonObject {
  const v = parseJsonValue(text);
  if (!(v instanceof JsonObject)) throw new Error('object');
  return v;
}
const meta = doc(
  '{"item_id":"item","label":"local full-diff review","run_id":"run","base":"base","head":"head"}',
);
const classification = doc(
  '{"outcome":"completed","counted":true,"findings":1,"severity_counts":{"major":1}}',
);
function setup() {
  const queue = doc(
    '{"items":[{"id":"item","kind":"local-review","state":"reviewing","run":{"run_id":"run"},"unknown":1.0}]}',
  );
  const item = (queue.get('items') as JsonObject[])[0]!;
  const calls: string[] = [];
  const effects: LocalExitHarvestEffects = {
    liveness: async () => {
      calls.push('liveness');
      return 'harvest';
    },
    readExit: async () => {
      calls.push('exit');
      return doc('{"exit":0,"ended_at":"2026-11-14T12:00:00Z"}');
    },
    writeNext: async () => {
      calls.push('next');
    },
    readMeta: async () => {
      calls.push('meta');
      return meta;
    },
    readStream: async () => {
      calls.push('stream');
      return Buffer.from(
        '{"type":"finding","severity":"major","fileName":"a.ts","comment":" comment "}\n',
      );
    },
    classify: () => {
      calls.push('classify');
      return classification;
    },
    writeClassification: async () => {
      calls.push('classification');
    },
    writeFindings: async (_id, report) => {
      calls.push('findings');
      expect(report).toContain('## F1 [major] a.ts\n\n```text\ncomment\n```');
    },
    event: async (kind) => {
      calls.push(kind);
    },
    complete: async (q, current) => {
      calls.push('complete');
      const finished = withObjectKeys(current, [
        ['state', 'done'],
        ['receipt_id', 'receipt'],
      ]);
      return withObjectKeys(q, [['items', [finished]]]);
    },
    cleanup: async () => {
      calls.push('cleanup');
    },
    nowIso: () => '2026-11-14T12:00:00Z',
  };
  return { queue, item, calls, effects };
}
describe('local-review exit harvest lifecycle', () => {
  it('propagates programming errors during cleanup instead of hiding them', async () => {
    const x = setup();
    await expect(
      harvestLocalReviewExit(x.queue, x.item, false, 5, {
        ...x.effects,
        cleanup: async () => {
          throw new Error('missing worktree');
        },
      }),
    ).rejects.toThrow('missing worktree');
    expect(x.calls).not.toContain('local_review_cleanup_failed');
  });
  it('uses an explicit zero wait instead of the configured default', async () => {
    const x = setup();
    const result = await harvestLocalReviewExit(x.queue, x.item, false, 5, {
      ...x.effects,
      classify: () =>
        doc(
          '{"outcome":"rate_limited","counted":false,"findings":0,"severity_counts":{},"wait_seconds":0}',
        ),
    });
    expect(result.queue.get('cooldown_until')).toBe('2026-11-14T12:00:00Z');
  });
  it('retains ambiguous ownership and records its event', async () => {
    const x = setup();
    const result = await harvestLocalReviewExit(x.queue, x.item, false, 5, {
      ...x.effects,
      liveness: async () => 'ambiguous',
    });
    expect(x.calls).toEqual(['review_ambiguous']);
    const item = (result.queue.get('items') as JsonObject[])[0]!;
    expect(item.get('run')).toBe(x.item.get('run'));
    expect(item.get('wait_reason')).toContain('capacity retained');
  });
  it('pauses on authentication failures before completion', async () => {
    const x = setup();
    let paused: unknown;
    const result = await harvestLocalReviewExit(x.queue, x.item, false, 5, {
      ...x.effects,
      classify: () => doc('{"outcome":"auth","counted":false,"findings":0,"severity_counts":{}}'),
      complete: async (q, current, run, cls, at, code, stream) => {
        paused = q.get('paused');
        return x.effects.complete(q, current, run, cls, at, code, stream);
      },
    });
    expect(paused).toBe(true);
    expect(result.queue.get('pause_reason')).toBe('auth on run; owner action needed');
  });
  it('refuses float exit codes without writing evidence', async () => {
    const x = setup();
    await expect(
      harvestLocalReviewExit(x.queue, x.item, false, 5, {
        ...x.effects,
        readExit: async () => doc('{"exit":0.0}'),
      }),
    ).rejects.toThrow('unsupported exit code');
    expect(x.calls).toEqual(['liveness']);
  });
  it('matches Python report parsing of nonfinite JSON constants', () => {
    const bytes = Buffer.from(
      '{"type":"finding","severity":"minor","fileName":"x","comment":[NaN,Infinity,-Infinity]}\n',
    );
    expect(renderLocalReviewFindings(bytes, meta, classification)).toContain(
      '[nan, inf, -inf]\n```',
    );
  });
  it('retains ambiguous ownership and emits no dry-run event', async () => {
    const x = setup();
    const result = await harvestLocalReviewExit(x.queue, x.item, true, 5, {
      ...x.effects,
      liveness: async () => 'ambiguous',
    });
    expect((result.queue.get('items') as JsonObject[])[0]!.get('wait_reason')).toContain(
      'capacity retained',
    );
    expect(x.calls).toEqual([]);
  });
  it('reads exit but performs no harvest writes in dry mode', async () => {
    const x = setup();
    const result = await harvestLocalReviewExit(x.queue, x.item, true, 5, x.effects);
    expect(result.message).toBe('would harvest run');
    expect(x.calls).toEqual(['liveness', 'exit']);
  });
  it('writes classification, report and event before durable completion and cleanup', async () => {
    const x = setup();
    const result = await harvestLocalReviewExit(x.queue, x.item, false, 5, x.effects);
    expect(result.message).toBe('item: done; receipt receipt');
    expect(x.calls).toEqual([
      'liveness',
      'exit',
      'next',
      'meta',
      'stream',
      'classify',
      'classification',
      'findings',
      'review_finished',
      'complete',
      'cleanup',
    ]);
  });
  it('applies rate cooldown before completion and records cleanup failure', async () => {
    const x = setup();
    let received: JsonObject | undefined;
    const result = await harvestLocalReviewExit(x.queue, x.item, false, 5, {
      ...x.effects,
      classify: () =>
        doc(
          '{"outcome":"rate_limited","counted":false,"findings":1,"severity_counts":{"major":1},"wait_seconds":120}',
        ),
      complete: async (q, current, run, cls, at, code, stream) => {
        received = q;
        return x.effects.complete(q, current, run, cls, at, code, stream);
      },
      cleanup: async () => {
        throw new LocalReviewCleanupError('cleanup failed');
      },
    });
    expect(received?.get('cooldown_until')).toBe('2026-11-14T12:02:00Z');
    expect(result.message).toBe('item: done; receipt receipt');
    expect(x.calls.at(-1)).toBe('local_review_cleanup_failed');
  });
});
