// The ONE-PR rule (header pin 1): exactly one PR per run carrying the
// byte-deterministic rebuilt baselines, and the proposal never writes
// to the workspace.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { match } from '../../helpers/matchers.js';
import { describe, expect, test } from 'vitest';
import { parseBaseline, renderBaseline } from '../../../src/ops/ratchet/format.js';
import type { BaselineFile } from '../../../src/ops/ratchet/format.js';
import { createProposeBaselineUpdate } from '../../../src/ops/ratchet/proposeBaselineUpdate.js';
import {
  CAPTURED_AT,
  makeFakeEffects,
  METRIC,
  proposeInput,
  REL,
  seedBaseline,
  TARGET,
  ws,
} from './proposeBaselineUpdate.helpers.js';

describe('proposeBaselineUpdate', () => {
  test('an improvement proposes exactly ONE PR carrying the tightened baseline bytes', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    const effects = makeFakeEffects();
    const propose = createProposeBaselineUpdate(effects);
    await expect(
      propose(
        proposeInput({
          improvements: [{ target: TARGET, metric: METRIC, value: 7, capturedAt: CAPTURED_AT }],
        }),
      ),
    ).resolves.toEqual({
      status: 'ok',
      value: {
        proposal: 'created',
        prNumber: 1,
        prUrl: 'https://github.com/acme/repo/pull/1',
        head: match.stringMatching(/^ratchet\/propose-[0-9a-f]{12}$/),
        applied: [{ path: REL, target: TARGET, metric: METRIC, oldValue: 10, newValue: 7 }],
        skipped: [],
      },
    });
    // Exactly one PR exists, created by exactly one upsert.
    expect(effects.prs.size).toBe(1);
    expect(effects.findCalls()).toBe(1);
    expect(effects.upsertCalls()).toBe(1);
    const pr = effects.prs.values().next().value;
    expect(pr?.base).toBe('main');
    expect(pr?.title).toBe('chore(ratchet): tighten baselines (1 metric)');
    expect(pr?.commitMessage).toBe('chore(ratchet): tighten baselines (proposeBaselineUpdate)');
    expect(pr?.files).toHaveLength(1);
    // The file bytes are the byte-deterministic renderBaseline output of the
    // REBUILT baseline: direction and unit from the committed baseline,
    // value tightened, capturedAt from the improvement.
    const expected: BaselineFile = {
      schemaVersion: 1,
      target: TARGET,
      metric: METRIC,
      direction: 'lower-is-better',
      value: 7,
      capturedAt: CAPTURED_AT,
    };
    expect(pr?.files[0]?.path).toBe(REL);
    expect(pr?.files[0]?.content).toBe(renderBaseline(expected));
    expect(pr?.body).toContain(`- \`${REL}\` (${TARGET} / ${METRIC}): 10 → 7 (lower-is-better)`);
  });

  test('the proposal NEVER writes to the workspace — the committed baseline stays byte-identical', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    const before = await readFile(join(ws, REL), 'utf8');
    const effects = makeFakeEffects();
    await createProposeBaselineUpdate(effects)(
      proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 7 }] }),
    );
    expect(await readFile(join(ws, REL), 'utf8')).toBe(before);
  });

  test('the improvement capturedAt defaults to the clock (parses as ISO-8601)', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    const effects = makeFakeEffects();
    await createProposeBaselineUpdate(effects)(
      proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 7 }] }),
    );
    const content = effects.prs.values().next().value?.files[0]?.content ?? '';
    const onPr = JSON.parse(content) as { capturedAt?: string };
    expect(Number.isNaN(Date.parse(onPr.capturedAt ?? 'x'))).toBe(false);
    // The clock-default bytes must be FULLY committed-evidence shaped: the
    // strict parser accepts them, not merely a lenient Date.parse.
    expect(() => parseBaseline(content)).not.toThrow();
    expect(parseBaseline(content).capturedAt).toBe(onPr.capturedAt);
  });

  test('a tightening preserves the baseline unit ("errors" rides into the committed proposal bytes)', async () => {
    await seedBaseline(TARGET, METRIC, 10, 'lower-is-better', 'errors');
    const effects = makeFakeEffects();
    const result = await createProposeBaselineUpdate(effects)(
      proposeInput({
        improvements: [{ target: TARGET, metric: METRIC, value: 7, capturedAt: CAPTURED_AT }],
      }),
    );
    const pr = effects.prs.values().next().value;
    const expected: BaselineFile = {
      schemaVersion: 1,
      target: TARGET,
      metric: METRIC,
      direction: 'lower-is-better',
      value: 7,
      unit: 'errors',
      capturedAt: CAPTURED_AT,
    };
    // Byte-render matches renderBaseline with the unit intact, and the
    // proposal file parses back carrying that unit.
    expect(pr?.files[0]?.content).toBe(renderBaseline(expected));
    expect(parseBaseline(pr?.files[0]?.content ?? '').unit).toBe('errors');
    expect(result).toMatchObject({
      status: 'ok',
      value: { proposal: 'created', applied: [{ oldValue: 10, newValue: 7 }] },
    });
  });

  test('a mixed batch groups ALL tightenings into ONE PR with every file', async () => {
    const relA = await seedBaseline(TARGET, METRIC, 10);
    const relB = await seedBaseline('bundle-size', 'kb-total', 512, 'lower-is-better');
    const effects = makeFakeEffects();
    const result = await createProposeBaselineUpdate(effects)(
      proposeInput({
        improvements: [
          { target: 'bundle-size', metric: 'kb-total', value: 480, capturedAt: CAPTURED_AT },
          { target: TARGET, metric: METRIC, value: 7, capturedAt: CAPTURED_AT },
        ],
      }),
    );
    expect(result).toMatchObject({
      status: 'ok',
      value: {
        proposal: 'created',
        prNumber: 1,
        applied: [
          { path: relB, target: 'bundle-size', metric: 'kb-total', oldValue: 512, newValue: 480 },
          { path: relA, target: TARGET, metric: METRIC, oldValue: 10, newValue: 7 },
        ],
        skipped: [],
      },
    });
    expect(effects.prs.size).toBe(1);
    const pr = effects.prs.values().next().value;
    expect(pr?.title).toBe('chore(ratchet): tighten baselines (2 metrics)');
    expect(pr?.files).toHaveLength(2);
    expect(pr?.files.map((f) => f.path)).toEqual([relB, relA]);
    expect(pr?.body).toContain(
      `- \`${relB}\` (bundle-size / kb-total): 512 → 480 (lower-is-better)`,
    );
    expect(pr?.body).toContain(`- \`${relA}\` (${TARGET} / ${METRIC}): 10 → 7 (lower-is-better)`);
  });
});
