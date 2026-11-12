// src/cli/output.ts contract (lossless parity pin + line-based narration) — split from test/cli/i1.test.ts (pure move). Suite header: op-subcommands.test.ts; helpers: ./i1-helpers.ts.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  narrate,
  reportError,
  usageSummaryOfThrown,
  type CliIo,
  type CliErrorArtifact,
} from '../../src/cli/output.js';
import { KnownUsageSummarySchema, RunReportSchema } from '../../src/kernel/schema.js';
import { capture, makeTmpOpsRoot, opsRoot, writePlanFile } from './i1-helpers.js';

// Lossless PARITY PIN (r3 F3): src/cli/output.ts's assertJsonLossless and the
// kernel runner's pre-journal walk (src/kernel/runner.ts) are deliberate
// line-identical mirrors — the direct-dispatch gate and the plan-path gate
// must keep REJECTING the same values, or the two dispatch paths disagree
// about what may become an artifact/journal line. This suite holds them
// together behaviorally: every corpus member must be rejected by BOTH layers
// (corpus statuses verified against both walks before inclusion — e.g.
// `Object.create(null)` carrying only a string member is ACCEPTED by both
// (the documented null-prototype normalization) and is therefore excluded;
// the null-proto member below carries a Map so both walks reject it).
describe('lossless parity pin: the CLI walk and the kernel walk reject the same corpus', () => {
  test('every lossy member: direct dispatch → exit 1 with empty stdout; run-plan → failed rows', async () => {
    const corpus = [
      { name: 'lossmap', expr: 'new Map()', pattern: "non-plain object of type 'Map'" },
      { name: 'lossdate', expr: 'new Date(0)', pattern: "non-plain object of type 'Date'" },
      { name: 'lossset', expr: 'new Set([1])', pattern: "non-plain object of type 'Set'" },
      {
        name: 'lossnullproto',
        expr: 'Object.assign(Object.create(null), { m: new Map() })',
        pattern: "non-plain object of type 'Map'",
      },
      // The hidden-key family (PR #31 review, Codex P1 + review-debt #76):
      // the member walk sees only enumerable string-keyed values, so these
      // shapes passed while JSON.stringify disagreed with the walk — a
      // symbol key is DROPPED by stringify; a non-enumerable 'toJSON' is
      // INVOKED by it (the journal/artifact would reconstruct the hook's
      // output); any non-enumerable member is invisible data.
      {
        name: 'losssymbolkey',
        expr: "{ x: 1, [Symbol('hidden')]: 2 }",
        pattern: 'symbol-keyed own member',
      },
      {
        name: 'losshiddentojson',
        expr: "(() => { const o = { x: 1 }; Object.defineProperty(o, 'toJSON', { value: () => ({ x: 2 }), enumerable: false }); return o; })()",
        pattern: "non-enumerable own 'toJSON'",
      },
      // The array-side family (PR #103 review, Codex P1): arrays carrying
      // anything but indices and length diverge from stringify the same
      // ways objects do.
      {
        name: 'lossarrtojson',
        expr: "(() => { const a = [1]; Object.defineProperty(a, 'toJSON', { value: () => ({ x: 2 }), enumerable: false }); return a; })()",
        pattern: "own 'toJSON' on an array",
      },
      {
        name: 'lossarrextra',
        expr: "(() => { const a = [1]; a.extra = 'gone'; return a; })()",
        pattern: "non-index own member 'extra' on an array",
      },
      {
        name: 'lossarrsymbol',
        expr: "(() => { const a = [1]; a[Symbol('leak')] = 2; return a; })()",
        pattern: 'symbol-keyed own member',
      },
      {
        name: 'losshiddenmember',
        expr: "(() => { const o = { x: 1 }; Object.defineProperty(o, 'hidden', { value: 3, enumerable: false }); return o; })()",
        pattern: "non-enumerable own member 'hidden'",
      },
      // -0 is finite, so the stringify probe passes it, but JSON.stringify
      // writes it as `0` — the artifact/journal would silently drop the sign
      // (review finding 1ed17a53, ceres backfill). Both walks must reject it
      // identically or the two dispatch paths would disagree about -0.
      {
        name: 'lossnegzero',
        expr: '{ x: Math.round(-0.4) }',
        pattern: "negative zero — JSON.stringify writes it as '0'",
      },
    ];
    const tmp = await makeTmpOpsRoot('cq-i1-parity-');
    await mkdir(join(tmp, 'parityfam'), { recursive: true });
    await writeFile(
      join(tmp, 'parityfam', 'registry.js'),
      [
        "import { z } from 'zod';",
        'export const registry = [',
        ...corpus.map(
          (member) =>
            `  { name: '${member.name}', inputSchema: z.object({}).strict(), importer: async () => async () => ({ status: 'ok', value: ${member.expr} }) },`,
        ),
        '];',
        '',
      ].join('\n'),
    );

    // (a) Direct dispatch — the CLI-side walk rejects every member BEFORE any
    // stdout artifact: exit 1 (thrown class), stdout empty.
    for (const member of corpus) {
      const { code, out, err } = await capture([member.name], { opsRoot: tmp });
      expect(code, member.name).toBe(1);
      expect(out, member.name).toBe('');
      expect(err, member.name).toMatch(new RegExp(`${member.name} returned an invalid result`));
      expect(err, member.name).toMatch(new RegExp(member.pattern));
    }

    // (b) Plan path — the same ops through run-plan hit the kernel runner's
    // pre-journal walk (the other copy): each job records an honest failed
    // row instead of journaling a lossy result.
    const plan = {
      id: 'i1-parity',
      jobs: corpus.map((member, index) => ({ id: `p${index}`, op: member.name, input: {} })),
    };
    const { planPath } = await writePlanFile(plan);
    const { code, out } = await capture(['run-plan', `--plan=${planPath}`, `--ops-root=${tmp}`]);
    expect(code).toBe(1); // failed rows map to 1
    const report = RunReportSchema.parse(JSON.parse(out));
    expect(report.jobs).toHaveLength(corpus.length);
    expect(report.counts.failed).toBe(corpus.length);
    for (let index = 0; index < corpus.length; index++) {
      const row = report.jobs[index];
      expect(row?.op, `job ${index}`).toBe(corpus[index]?.name);
      expect(row?.result.status, `job ${index}`).toBe('failed');
      const error = row?.result.status === 'failed' ? row.result.error : '';
      // The runner's non-serializable-result marker naming the same walk
      // defect the direct path named above.
      expect(error, `job ${index}`).toMatch(/returned a non-serializable result/);
      expect(error, `job ${index}`).toMatch(new RegExp(corpus[index]?.pattern ?? ''));
    }
  });
});

describe('line-based narration (embedded newlines flatten to the literal escape)', () => {
  test('narrate: one call is exactly ONE `cq:` line, newlines flattened to literal \\n', () => {
    const errChunks: string[] = [];
    const io: CliIo = { stdout: () => {}, stderr: (chunk) => errChunks.push(chunk) };
    narrate(io, 'line1\nline2');
    // The two-character escape `\n` (backslash + n), not a real newline.
    expect(errChunks.join('')).toBe('cq: line1\\nline2\n');
  });

  test('e2e: the boom two-line error text narrates as ONE stderr line', async () => {
    const { err } = await capture(['boom'], { opsRoot });
    const lines = err.split('\n');
    expect(lines).toHaveLength(2); // exactly one content line + the trailing newline
    expect(lines[1]).toBe('');
    expect(lines[0]).toBe(
      'cq: boom: failed — boom: deliberate fixture failure\\nsecond line of the failure',
    );
  });
});

// #1195: spend on every exit where it is known — the machine-mode ERROR
// artifact carries a THROWN value's validated usage carrier inside `error`,
// and `usageSummaryOfThrown` is the one validator every thrown site funnels.
describe('error artifact usage envelope (#1195)', () => {
  const CARRIER = {
    usage: { input: 120, output: 40, cacheRead: 8, cacheWrite: 0 },
    knownCount: 1,
    unknownCount: 0,
    unpricedCount: 1,
  };

  test('reportError json mode: a validated usageSummary rides INSIDE error, kind and exitCode unchanged', () => {
    const chunks: string[] = [];
    const io: CliIo = { stdout: (chunk) => chunks.push(chunk), stderr: () => {} };
    const code = reportError(io, 'json', 'thrown', 'spendthrow', 'boom', 1, CARRIER);
    expect(code).toBe(1);
    const artifact = JSON.parse(chunks.join('')) as CliErrorArtifact;
    // The envelope is schema-valid (the kernel's own validator) and exact.
    const summary = KnownUsageSummarySchema.parse(artifact.error.usageSummary);
    expect(summary).toEqual(CARRIER);
    // The four contract keys are untouched; the artifact stays single-keyed.
    expect(artifact.error).toMatchObject({
      kind: 'thrown',
      subcommand: 'spendthrow',
      message: 'boom',
      exitCode: 1,
    });
    expect(Object.hasOwn(artifact, 'status')).toBe(false);
  });

  test('reportError json mode: no usageSummary → the key is ABSENT, the artifact byte-shaped as before', () => {
    const chunks: string[] = [];
    const io: CliIo = { stdout: (chunk) => chunks.push(chunk), stderr: () => {} };
    reportError(io, 'json', 'usage', null, 'no such subcommand', 2);
    const artifact = JSON.parse(chunks.join('')) as CliErrorArtifact;
    expect(Object.hasOwn(artifact.error, 'usageSummary')).toBe(false);
    expect(artifact.error).toEqual({
      kind: 'usage',
      subcommand: null,
      message: 'no such subcommand',
      exitCode: 2,
    });
  });

  test('reportError human mode: a usage carrier changes NOTHING (narration only, stdout empty)', () => {
    const outChunks: string[] = [];
    const errChunks: string[] = [];
    const io: CliIo = {
      stdout: (chunk) => outChunks.push(chunk),
      stderr: (chunk) => errChunks.push(chunk),
    };
    const code = reportError(io, 'human', 'thrown', 'op', 'it threw', 1, CARRIER);
    expect(code).toBe(1);
    expect(outChunks).toEqual([]);
    expect(errChunks.join('')).toBe('cq: it threw\n');
  });

  test('usageSummaryOfThrown: a valid carrier passes; every corrupt shape contributes nothing', () => {
    const err = new Error('threw');
    expect(usageSummaryOfThrown(Object.assign(err, { usageSummary: CARRIER }))).toEqual(CARRIER);
    // A frozen error still reads (assignment failure is attach-side, not read-side).
    const frozen = Object.freeze(Object.assign(new Error('frozen'), { usageSummary: CARRIER }));
    expect(usageSummaryOfThrown(frozen)).toEqual(CARRIER);
    // Schema-rejected carriers are omitted whole, never trusted in part.
    expect(
      usageSummaryOfThrown(
        Object.assign(new Error('neg'), {
          usageSummary: { ...CARRIER, knownCount: -1 },
        }),
      ),
    ).toBeUndefined();
    expect(
      usageSummaryOfThrown(
        Object.assign(new Error('extra'), { usageSummary: { ...CARRIER, extra: true } }),
      ),
    ).toBeUndefined();
    // No carrier, a non-object carrier, or a thrown primitive: undefined.
    expect(usageSummaryOfThrown(new Error('bare'))).toBeUndefined();
    expect(
      usageSummaryOfThrown(Object.assign(new Error('wrongtype'), { usageSummary: 7 })),
    ).toBeUndefined();
    expect(usageSummaryOfThrown('a thrown string')).toBeUndefined();
    expect(usageSummaryOfThrown(null)).toBeUndefined();
    expect(usageSummaryOfThrown(undefined)).toBeUndefined();
  });
});
