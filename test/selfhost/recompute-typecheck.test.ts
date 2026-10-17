// Residual R1 — cq-verify's in-process typecheck recompute
// (src/selfhost/recompute-typecheck.ts). The op itself is
// test/ops/ratchet/recomputeTypecheck.test.ts's; this file pins the carrier:
// the op's own schema over strict argv and the output contract cq-verify's
// compute step validates (a numeric `.value.count` on an ok result).
import { describe, expect, test } from 'vitest';
import type { OpResult } from '../../src/kernel/types.js';
import type {
  RecomputeTypecheckInput,
  RecomputeTypecheckOutcome,
} from '../../src/ops/ratchet/recomputeTypecheck.js';
import { RecomputeTypecheckCommandInputSchema as RegistrySchema } from '../../src/ops/ratchet/registry.js';
import { RecomputeTypecheckCommandInputSchema } from '../../src/ops/ratchet/recomputeTypecheckInput.js';
import {
  mainWith,
  parseRecomputeArgs,
  RecomputeArgsSchema,
} from '../../src/selfhost/recompute-typecheck.js';

const SUBJECT = 'c'.repeat(40);

/** cq-verify's compute argv. */
const ARGV = ['--repo=trust', `--subject=${SUBJECT}`, '--scratch=/tmp/cq-recompute'];

const OUTCOME: RecomputeTypecheckOutcome = {
  count: 3,
  subject: SUBJECT,
  files: 10,
  skipped: 0,
  exitCode: 2,
};

function harness(result: OpResult<RecomputeTypecheckOutcome> = { status: 'ok', value: OUTCOME }) {
  const inputs: RecomputeTypecheckInput[] = [];
  const lines: string[] = [];
  return {
    inputs,
    lines,
    deps: {
      recompute: (input: RecomputeTypecheckInput) => {
        inputs.push(input);
        return Promise.resolve(result);
      },
      write: (line: string) => lines.push(line),
    },
  };
}

describe('parseRecomputeArgs', () => {
  test('accepts the cq-verify compute argv, and a decimal timeout', () => {
    expect(parseRecomputeArgs(ARGV)).toEqual({
      repo: 'trust',
      subject: SUBJECT,
      scratch: '/tmp/cq-recompute',
    });
    expect(parseRecomputeArgs([...ARGV, '--timeoutMs=60000'])).toMatchObject({ timeoutMs: 60000 });
  });

  test.each([['--timeoutMs=0'], ['--timeoutMs=1e9'], ['--count=0'], ['--scratch=']])(
    '%s is refused',
    (flag) => {
      const name = flag.slice(2, flag.indexOf('='));
      const argv = [...ARGV.filter((a) => !a.startsWith(`--${name}=`)), flag];
      expect(() => parseRecomputeArgs(argv)).toThrow();
    },
  );

  test("the schema is the op's own: the registry re-exports the shared object", () => {
    expect(RegistrySchema).toBe(RecomputeTypecheckCommandInputSchema);
    expect(Object.keys(RecomputeArgsSchema.shape).sort()).toEqual(
      Object.keys(RecomputeTypecheckCommandInputSchema.shape).sort(),
    );
  });
});

describe('mainWith', () => {
  test('writes exactly one JSON line with the OpResult (the shape cq-verify validates)', async () => {
    const h = harness();
    expect(await mainWith(ARGV, h.deps)).toBe(0);
    expect(h.inputs).toEqual([parseRecomputeArgs(ARGV)]);
    expect(h.lines).toHaveLength(1);
    expect(JSON.parse(h.lines[0] ?? '')).toEqual({ status: 'ok', value: OUTCOME });
  });

  test('a failed recompute is exit 1 and carries no count', async () => {
    const h = harness({ status: 'failed', error: 'scratch is not empty' });
    expect(await mainWith(ARGV, h.deps)).toBe(1);
    expect(JSON.parse(h.lines[0] ?? '')).toEqual({
      status: 'failed',
      error: 'scratch is not empty',
    });
  });

  test('bad arguments are a failed result, exit 2 (I1), and nothing is recomputed', async () => {
    const h = harness();
    expect(await mainWith(['--bogus=1'], h.deps)).toBe(2);
    expect(h.inputs).toEqual([]);
    expect(JSON.parse(h.lines[0] ?? '')).toMatchObject({ status: 'failed' });
  });
});
