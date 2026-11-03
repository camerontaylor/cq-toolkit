// Op contract and input validation: the op input is plain data, the
// DEFAULT_PR_TOKEN doctrine marker, arg-error verdicts for malformed
// input, the empty zero fast path, and the markdown-inert PR body
// render.
import { match } from '../../helpers/matchers.js';
import { describe, expect, test } from 'vitest';
import { parseBaseline } from '../../../src/ops/ratchet/format.js';
import {
  createProposeBaselineUpdate,
  DEFAULT_PR_TOKEN,
} from '../../../src/ops/ratchet/proposeBaselineUpdate.js';
import type { ProposeInput } from '../../../src/ops/ratchet/proposeBaselineUpdate.js';
import {
  CAPTURED_AT,
  makeFakeEffects,
  METRIC,
  proposeInput,
  seedBaseline,
  TARGET,
} from './proposeBaselineUpdate.helpers.js';

describe('proposeBaselineUpdate', () => {
  test('the op input is plain data: structuredClone-safe (kernel makeManifest clones Job.input)', () => {
    expect(() =>
      structuredClone(
        proposeInput({ improvements: [{ target: TARGET, metric: METRIC, value: 7 }] }),
      ),
    ).not.toThrow();
  });

  test('DEFAULT_PR_TOKEN is the CQ_AUTOMATION_TOKEN doctrine marker', () => {
    expect(DEFAULT_PR_TOKEN).toBe('CQ_AUTOMATION_TOKEN');
  });

  test('the PR body renders hostile identity fields inert (backticks/newlines stripped for markdown only)', async () => {
    const hostile = 'we`ird\ninject';
    await seedBaseline(hostile, METRIC, 10);
    const effects = makeFakeEffects();
    const result = await createProposeBaselineUpdate(effects)(
      proposeInput({
        improvements: [{ target: hostile, metric: METRIC, value: 7, capturedAt: CAPTURED_AT }],
      }),
    );
    const pr = effects.prs.values().next().value;
    // The body line carries the STRIPPED identity — the backtick and newline
    // cannot break out of the markdown backticks — while the applied outcome
    // and the committed FILE keep the raw identity.
    expect(pr?.body).not.toContain('we`ird');
    expect(pr?.body).toContain('(weirdinject / typecheck-count): 10 → 7 (lower-is-better)');
    expect(result).toMatchObject({
      status: 'ok',
      value: { applied: [{ target: hostile, metric: METRIC }] },
    });
    const content = pr?.files[0]?.content ?? '';
    expect((parseBaseline(content) as { target?: string }).target).toBe(hostile);
  });

  test('input validation: null input, non-string ws/base, non-finite value → failed verdicts', async () => {
    const propose = createProposeBaselineUpdate(makeFakeEffects());
    await expect(propose(null as unknown as ProposeInput)).resolves.toEqual({
      status: 'failed',
      error: 'ratchet: invalid input — expected a non-null object',
    });
    await expect(propose(proposeInput({ ws: 42 as unknown as string }))).resolves.toEqual({
      status: 'failed',
      error: "ratchet: invalid input — 'ws' must be a string",
    });
    await expect(propose(proposeInput({ base: undefined as unknown as string }))).resolves.toEqual({
      status: 'failed',
      error: "ratchet: invalid input — 'base' must be a string",
    });
    // 10 ** 400 overflows to Infinity — the crafted-non-finite probe.
    await expect(
      propose(
        proposeInput({
          improvements: [{ target: TARGET, metric: METRIC, value: 10 ** 400 }],
        }),
      ),
    ).resolves.toEqual({
      status: 'failed',
      error: 'ratchet: invalid input — improvements[0].value must be a finite number',
    });
    // The remaining boundary guards, each pinned with its arg-error wording.
    await expect(
      propose(proposeInput({ improvements: 'nope' as unknown as ProposeInput['improvements'] })),
    ).resolves.toEqual({
      status: 'failed',
      error: "ratchet: invalid input — 'improvements' must be an array",
    });
    await expect(
      propose(
        proposeInput({ improvements: [42 as unknown as ProposeInput['improvements'][number]] }),
      ),
    ).resolves.toEqual({
      status: 'failed',
      error: 'ratchet: invalid input — improvements[0] must be an object',
    });
    await expect(
      propose(
        proposeInput({
          improvements: [{ target: 42 as unknown as string, metric: METRIC, value: 1 }],
        }),
      ),
    ).resolves.toEqual({
      status: 'failed',
      error: 'ratchet: invalid input — improvements[0].target must be a string',
    });
    await expect(
      propose(
        proposeInput({
          improvements: [{ target: TARGET, metric: 42 as unknown as string, value: 1 }],
        }),
      ),
    ).resolves.toEqual({
      status: 'failed',
      error: 'ratchet: invalid input — improvements[0].metric must be a string',
    });
    await expect(
      propose(
        proposeInput({
          improvements: [{ target: TARGET, metric: METRIC, value: 1, capturedAt: 'not-a-date' }],
        }),
      ),
    ).resolves.toEqual({
      status: 'failed',
      error: match.stringMatching(
        /improvements\[0\]\.capturedAt must be a strict ISO-8601 instant/,
      ),
    });
  });

  test('an empty improvements list is the zero fast path: none, zero effects calls', async () => {
    await seedBaseline(TARGET, METRIC, 10);
    const effects = makeFakeEffects();
    await expect(createProposeBaselineUpdate(effects)(proposeInput())).resolves.toEqual({
      status: 'ok',
      value: {
        proposal: 'none',
        prNumber: null,
        prUrl: null,
        head: null,
        applied: [],
        skipped: [],
      },
    });
    expect(effects.findCalls()).toBe(0);
    expect(effects.upsertCalls()).toBe(0);
  });
});
