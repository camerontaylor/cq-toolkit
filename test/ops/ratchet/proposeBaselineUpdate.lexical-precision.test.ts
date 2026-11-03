// The baseline FILE's lexical precision: raw "value" tokens, LAST-WINS
// duplicate keys, and in-string keys that never pose as the value token
// (PR reviews #4304483877, #4305217670, #4305217673, #4305894806).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parseBaseline } from '../../../src/ops/ratchet/format.js';
import { createProposeBaselineUpdate } from '../../../src/ops/ratchet/proposeBaselineUpdate.js';
import {
  BASELINE_CAPTURED_AT,
  CAPTURED_AT,
  makeFakeEffects,
  METRIC,
  proposeInput,
  seedRawBaseline,
  TARGET,
  ws,
} from './proposeBaselineUpdate.helpers.js';

describe('proposeBaselineUpdate', () => {
  test('LEXICAL file precision: a raw "value": 94.20 speaks two decimals — 94.29 proposes 94.29, 94.2 absorbs', async () => {
    // parseBaseline reads 94.20 as the canonical number 94.2, but the FILE
    // writes two decimals, so two is the precision the proposal rounding
    // owns: the raw 94.29 measurement floors at two decimals to itself — a
    // genuine tighten of the file's 94.2. A canonical-scale fallback would
    // have hidden the tighten behind a one-decimal floor to 94.2.
    const rel = await seedRawBaseline(
      TARGET,
      METRIC,
      [
        '{',
        '  "schemaVersion": 1,',
        `  "target": "${TARGET}",`,
        `  "metric": "${METRIC}",`,
        '  "direction": "higher-is-better",',
        '  "value": 94.20,',
        `  "capturedAt": "${BASELINE_CAPTURED_AT}"`,
        '}',
        '',
      ].join('\n'),
    );
    const effects = makeFakeEffects();
    const result = await createProposeBaselineUpdate(effects)(
      proposeInput({
        improvements: [{ target: TARGET, metric: METRIC, value: 94.29, capturedAt: CAPTURED_AT }],
      }),
    );
    expect(result).toMatchObject({
      status: 'ok',
      value: { proposal: 'created', applied: [{ path: rel, oldValue: 94.2, newValue: 94.29 }] },
    });
    expect(effects.prs.values().next().value?.files[0]?.content).toContain('"value": 94.29');
    // The boundary absorbs: 94.2 is already at or coarser than two decimals.
    const absorbed = makeFakeEffects();
    await expect(
      createProposeBaselineUpdate(absorbed)(
        proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 94.2 }] }),
      ),
    ).resolves.toMatchObject({ status: 'ok', value: { proposal: 'none', applied: [] } });
    expect(absorbed.upsertCalls()).toBe(0);
  });

  test('a target string containing a fake "value": key never poses as the value token', async () => {
    // The target's raw JSON encoding carries an escaped in-string
    // `\"value\": 8.8` — one decimal. The scan consumes strings atomically,
    // so the real top-level 94.20 token (two decimals) governs and 94.29
    // proposes at two decimals; a scanner fooled by the in-string token
    // would have floored to 94.2 and absorbed the tighten.
    const hostile = 'x "value": 8.8';
    const rawFile = [
      '{',
      '  "schemaVersion": 1,',
      `  "target": ${JSON.stringify(hostile)},`,
      `  "metric": "${METRIC}",`,
      '  "direction": "higher-is-better",',
      '  "value": 94.20,',
      `  "capturedAt": "${BASELINE_CAPTURED_AT}"`,
      '}',
      '',
    ].join('\n');
    await seedRawBaseline(hostile, METRIC, rawFile);
    const effects = makeFakeEffects();
    const result = await createProposeBaselineUpdate(effects)(
      proposeInput({
        improvements: [{ target: hostile, metric: METRIC, value: 94.29, capturedAt: CAPTURED_AT }],
      }),
    );
    expect(result).toMatchObject({
      status: 'ok',
      value: { proposal: 'created', applied: [{ oldValue: 94.2, newValue: 94.29 }] },
    });
  });

  test('duplicate top-level "value" keys are LAST-WINS, matching JSON.parse (PR review #4304483877)', async () => {
    // parseBaseline reads the LAST occurrence: {"value": 94, "value": 94.20}
    // parses to 94.2 — so the file speaks two decimals and 94.29 proposes at
    // two decimals. A first-wins scanner would read the integer 94 (zero
    // decimals) and wrongly absorb the tighten.
    const lastWins = await seedRawBaseline(
      TARGET,
      METRIC,
      [
        '{',
        '  "schemaVersion": 1,',
        `  "target": "${TARGET}",`,
        `  "metric": "${METRIC}",`,
        '  "direction": "higher-is-better",',
        '  "value": 94,',
        '  "value": 94.20,',
        `  "capturedAt": "${BASELINE_CAPTURED_AT}"`,
        '}',
        '',
      ].join('\n'),
    );
    expect(parseBaseline(await readFile(join(ws, lastWins), 'utf8')).value).toBe(94.2);
    const effects = makeFakeEffects();
    await expect(
      createProposeBaselineUpdate(effects)(
        proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 94.29 }] }),
      ),
    ).resolves.toMatchObject({
      status: 'ok',
      value: { proposal: 'created', applied: [{ oldValue: 94.2, newValue: 94.29 }] },
    });
    // Mirror ordering: the last key is the integer 94 — the parsed value is
    // 94 and the file speaks ZERO decimals, so 94.29 absorbs (never a
    // proposal at the coarser-than-file precision a first-wins scan of
    // 94.20 would have produced).
    const intLast = await seedRawBaseline(
      'dup-int-last',
      METRIC,
      [
        '{',
        '  "schemaVersion": 1,',
        '  "target": "dup-int-last",',
        `  "metric": "${METRIC}",`,
        '  "direction": "higher-is-better",',
        '  "value": 94.20,',
        '  "value": 94,',
        `  "capturedAt": "${BASELINE_CAPTURED_AT}"`,
        '}',
        '',
      ].join('\n'),
    );
    expect(parseBaseline(await readFile(join(ws, intLast), 'utf8')).value).toBe(94);
    const absorbed = makeFakeEffects();
    await expect(
      createProposeBaselineUpdate(absorbed)(
        proposeInput({ improvements: [{ target: 'dup-int-last', metric: METRIC, value: 94.29 }] }),
      ),
    ).resolves.toMatchObject({ status: 'ok', value: { proposal: 'none', applied: [] } });
    expect(absorbed.upsertCalls()).toBe(0);
  });

  test('an escaped last value key is honored: "value": 94.20, "\\u0076alue": 94.2 speaks one decimal (PR review #4305217673)', async () => {
    // JSON.parse decodes "\u0076alue" as value, so it is the LAST value key:
    // the effective token is 94.2 (one decimal) and 94.29 absorbs. Reading
    // only the raw plain key would keep the first token's two decimals.
    const rel = await seedRawBaseline(
      TARGET,
      METRIC,
      [
        '{',
        '  "schemaVersion": 1,',
        `  "target": "${TARGET}",`,
        `  "metric": "${METRIC}",`,
        '  "direction": "higher-is-better",',
        '  "value": 94.20,',
        '  "\\u0076alue": 94.2,',
        `  "capturedAt": "${BASELINE_CAPTURED_AT}"`,
        '}',
        '',
      ].join('\n'),
    );
    expect(parseBaseline(await readFile(join(ws, rel), 'utf8')).value).toBe(94.2);
    const effects = makeFakeEffects();
    await expect(
      createProposeBaselineUpdate(effects)(
        proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 94.29 }] }),
      ),
    ).resolves.toMatchObject({ status: 'ok', value: { proposal: 'none', applied: [] } });
    expect(effects.upsertCalls()).toBe(0);
  });

  test('a superseded NON-NUMERIC value key does not abort the last-wins scan (PR review #4305894806)', async () => {
    const rel = await seedRawBaseline(
      TARGET,
      METRIC,
      [
        '{',
        '  "schemaVersion": 1,',
        `  "target": "${TARGET}",`,
        `  "metric": "${METRIC}",`,
        '  "direction": "higher-is-better",',
        '  "value": "obsolete",',
        '  "value": 94.20,',
        `  "capturedAt": "${BASELINE_CAPTURED_AT}"`,
        '}',
        '',
      ].join('\n'),
    );
    expect(parseBaseline(await readFile(join(ws, rel), 'utf8')).value).toBe(94.2);
    const effects = makeFakeEffects();
    // The effective token is 94.20 (two decimals), so 94.29 is a genuine
    // tighten — not absorbed at the canonical one-decimal fallback.
    await expect(
      createProposeBaselineUpdate(effects)(
        proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 94.29 }] }),
      ),
    ).resolves.toMatchObject({
      status: 'ok',
      value: { proposal: 'created', applied: [{ oldValue: 94.2, newValue: 94.29 }] },
    });
  });
});
