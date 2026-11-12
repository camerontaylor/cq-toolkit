// I1 conformance suite — op subcommands (split from test/cli/i1.test.ts; helpers in ./i1-helpers.ts).
//
// The full CLI contract is exercised end-to-end over the pure-op fixture
// family (test/fixtures/cli-ops — DI'd via the {opsRoot} override, never the
// repo's src/ops):
//   1. The I1 stream contract: stdout carries exactly ONE JSON artifact;
//      stderr carries failures-only `cq:` narration (human mode) and stays
//      EMPTY in --json mode.
//   2. Exit codes {0,1,2,3}: the frozen taxonomy maps mechanically
//      (ok→0; failed/indeterminate→1; needs-human/budget-exhausted→3),
//      usage errors (unknown subcommand/flag, positional tokens,
//      schema-invalid input) are CLI-detected → 2, runtime throws → 1.
//   3. run-plan goes through the governed kernel composition: reports parse
//      against RunReportSchema; ALL INPUT defects are usage errors (→2) —
//      a --plan path that is missing or not a regular file, corrupted plan
//      FILE CONTENT, and the kernel's own input-validation class ('runPlan: '
//      — duplicate job ids, resume without a journal dir, caps without
//      governance, and the ledger refusals: governed history without
//      governance, unaccounted v1 dispatches, a cap raise; 'journal: runId must match ' — the
//      runId filename-safety assert on a schema-valid but journal-unsafe plan
//      id, e.g. 'bad/id', under --journal-dir) — while genuine RUNTIME throws
//      (a journal-dir pointing at a regular file) narrate 'run-plan threw:'
//      and exit 1. stdout stays empty on every non-artifact path.
//   4. Round-trip parity: invoking the op DIRECTLY through the registry and
//      through the CLI yields byte-identical results.
//   5. The narration contract is LINE-based: narrate() flattens embedded
//      newlines to the literal two-character `\n` escape (one prefixed line
//      always), and the direct-dispatch result-validation gate (CX1) keeps a
//      taxonomy-invalid or non-finite op result off stdout entirely.
// Deterministic throughout: no timers, no network, tmp dirs cleaned up.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parseFlags } from '../../src/cli/main.js';
import type { OpResult } from '../../src/kernel/types.js';
import { get, list } from '../../src/registry/index.js';
import { capture, makeTmpOpsRoot, opsRoot } from './i1-helpers.js';

describe('op subcommands (I1 stream + exit-code contract)', () => {
  test('optional report envelopes preserve all statuses, reject unknown keys and lossy evidence', async () => {
    const tmp = await makeTmpOpsRoot('cq-i1-report-');
    await mkdir(join(tmp, 'reports'));
    const expressions = [
      ['reportok', "{status:'ok',value:1,report:{tasks:[]}}", 0],
      ['reportfail', "{status:'failed',error:'failed',report:{tasks:[]}}", 1],
      ['reporthuman', "{status:'needs-human',reason:'review',report:{tasks:[]}}", 3],
      ['reportextra', "{status:'failed',error:'failed',report:{},unexpected:1}", 1],
      ['reportundefined', "{status:'failed',error:'failed',report:undefined}", 1],
      ['reportnan', "{status:'failed',error:'failed',report:{tokens:NaN}}", 1],
      ['reportfunction', "{status:'failed',error:'failed',report:{run:()=>1}}", 1],
    ] as const;
    await writeFile(
      join(tmp, 'reports', 'registry.js'),
      "import {z} from 'zod';\nexport const registry=[" +
        expressions
          .map(
            ([name, expression]) =>
              `{name:'${name}',inputSchema:z.object({}).strict(),importer:async()=>async()=>(${expression})}`,
          )
          .join(',') +
        '];\n',
    );
    for (const [name, , code] of expressions) {
      const result = await capture([name, '--json'], { opsRoot: tmp });
      expect(result.code, result.out).toBe(code);
      const artifact = JSON.parse(result.out) as {
        report?: unknown;
        error: { kind: string; message: string };
      };
      if (['reportok', 'reportfail', 'reporthuman'].includes(name))
        expect(artifact.report).toEqual({ tasks: [] });
      else {
        expect(artifact.error.kind, name).toBe('invalid-result');
        expect(artifact.error.message).toMatch(
          /unrecognized|unexpected|undefined|non-finite|function/i,
        );
      }
    }
  });

  test('typed top-level usage summaries preserve all result statuses and reject malformed envelopes', async () => {
    const tmp = await makeTmpOpsRoot('cq-i1-usage-summary-');
    await mkdir(join(tmp, 'summaries'));
    const summary =
      '{knownCount:1,unknownCount:1,unpricedCount:1,usage:{input:3,output:2,cacheRead:0,cacheWrite:0},costUSD:0.25}';
    const valid = [
      ['summaryok', `{status:'ok',value:{done:true},usageSummary:${summary}}`, 0],
      ['summaryfailed', `{status:'failed',error:'failed',usageSummary:${summary}}`, 1],
      ['summaryhuman', `{status:'needs-human',reason:'review',usageSummary:${summary}}`, 3],
      ['summarybudget', `{status:'budget-exhausted',usageSummary:${summary}}`, 3],
      [
        'summaryindeterminate',
        `{status:'indeterminate',detail:'lost',usageSummary:${summary},report:{note:'retained'}}`,
        1,
      ],
    ] as const;
    const invalid = [
      ['summaryundefined', "{status:'failed',error:'failed',usageSummary:undefined}"],
      [
        'summarynegative',
        "{status:'failed',error:'failed',usageSummary:{knownCount:-1,unknownCount:0,unpricedCount:0}}",
      ],
      [
        'summaryunsafe',
        "{status:'failed',error:'failed',usageSummary:{knownCount:Number.MAX_SAFE_INTEGER+1,unknownCount:0,unpricedCount:0}}",
      ],
      [
        'summarycost',
        "{status:'failed',error:'failed',usageSummary:{knownCount:0,unknownCount:0,unpricedCount:0,costUSD:Infinity}}",
      ],
      [
        'summaryunknown',
        "{status:'failed',error:'failed',usageSummary:{knownCount:0,unknownCount:0,unpricedCount:0,extra:1}}",
      ],
      ['summarytoplevel', `({status:'failed',error:'failed',usageSummary:${summary},extra:1})`],
      [
        'summaryhidden',
        "{status:'failed',error:'failed',usageSummary:Object.defineProperty({knownCount:0,unknownCount:0,unpricedCount:0},'hidden',{value:1})}",
      ],
      [
        'summaryreportnan',
        `{status:'failed',error:'failed',usageSummary:${summary},report:{x:NaN}}`,
      ],
      ['summarynovalue', `{status:'ok',value:undefined,usageSummary:${summary}}`],
      ['summaryvaluemap', `{status:'ok',value:new Map(),usageSummary:${summary}}`],
    ] as const;
    await writeFile(
      join(tmp, 'summaries', 'registry.js'),
      "import {z} from 'zod';\nexport const registry=[" +
        [...valid, ...invalid]
          .map(
            ([name, expression]) =>
              `{name:'${name}',inputSchema:z.object({}).strict(),importer:async()=>async()=>(${expression})}`,
          )
          .join(',') +
        '];\n',
    );
    for (const [name, , exitCode] of valid) {
      const { code, out, err } = await capture([name, '--json'], { opsRoot: tmp });
      expect(code, name).toBe(exitCode);
      const artifact = JSON.parse(out) as Record<string, unknown>;
      expect(out).toBe(`${JSON.stringify(artifact, null, 2)}\n`);
      expect(artifact['usageSummary']).toEqual({
        knownCount: 1,
        unknownCount: 1,
        unpricedCount: 1,
        usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 },
        costUSD: 0.25,
      });
      if (name === 'summaryindeterminate') expect(artifact['report']).toEqual({ note: 'retained' });
      expect(err).toBe('');
    }
    for (const [name] of invalid) {
      const { code, out, err } = await capture([name, '--json'], { opsRoot: tmp });
      expect(code, name).toBe(1);
      const artifact = JSON.parse(out) as { error: { kind: string; exitCode: number } };
      expect(out).toBe(`${JSON.stringify(artifact, null, 2)}\n`);
      expect(artifact.error).toMatchObject({ kind: 'invalid-result', exitCode: 1 });
      expect(err).toBe('');
    }
  });
  test('pure op, ok: one JSON artifact on stdout, silent stderr, exit 0', async () => {
    const { code, out, err } = await capture(['echo', '--msg=hello'], { opsRoot });
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ status: 'ok', value: { echo: 'hello' } });
    expect(err).toBe(''); // failures-only narration: ok rows are silent
  });

  test('taxonomy → exit codes: failed/indeterminate → 1, needs-human/budget → 3', async () => {
    const cases = [
      { name: 'boom', status: 'failed', code: 1 },
      { name: 'indet', status: 'indeterminate', code: 1 },
      { name: 'needshuman', status: 'needs-human', code: 3 },
      { name: 'budget', status: 'budget-exhausted', code: 3 },
    ] as const;
    for (const c of cases) {
      const { code, out, err } = await capture([c.name], { opsRoot });
      expect(code).toBe(c.code);
      expect(JSON.parse(out)).toMatchObject({ status: c.status });
      // Human-mode narration: one `cq: <name>: <status> — <detail>` line.
      expect(err).toContain(`cq: ${c.name}: ${c.status} — `);
    }
  });

  test('--json mode: narration suppressed (stderr empty), artifact unchanged, exit 1 on failed', async () => {
    const { code, out, err } = await capture(['boom', '--json'], { opsRoot });
    expect(code).toBe(1);
    expect(err).toBe(''); // machine mode: stderr stays EMPTY
    expect(JSON.parse(out)).toMatchObject({ status: 'failed' });
  });

  test('unknown subcommand: exit 2, no stdout, narrated to stderr', async () => {
    const { code, out, err } = await capture(['no-such-op'], { opsRoot });
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toMatch(/unknown subcommand/);
  });

  test('unknown flag and positional tokens: exit 2, stdout empty', async () => {
    // echo's schema is .strict(): an unrecognized key is schema-invalid input → 2.
    const flagged = await capture(['echo', '--msg=x', '--nope=1'], { opsRoot });
    expect(flagged.code).toBe(2);
    expect(flagged.out).toBe('');
    // A positional (non-flag) token is a usage error the CLI detects itself → 2.
    const positional = await capture(['echo', 'positional'], { opsRoot });
    expect(positional.code).toBe(2);
    expect(positional.out).toBe('');
  });

  test('missing required field: exit 2 (no op ever ran)', async () => {
    const { code, out, err } = await capture(['echo'], { opsRoot }); // no --msg
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toMatch(/invalid input for 'echo'/);
  });

  test('global --help lists subcommands incl. run-plan; exits 0', async () => {
    const { code, out } = await capture(['--help'], { opsRoot });
    expect(code).toBe(0);
    expect(out).toContain('run-plan');
  });

  test('op subcommand --help renders the exact schema keys plus the reserved --json/--help flags', async () => {
    const { code, out } = await capture(['echo', '--help'], { opsRoot });
    expect(code).toBe(0);
    expect(out).toContain('--msg=');
    // --json is accepted for EVERY subcommand (it drives narration mode) and
    // is listed in op help alongside --help (PR 64 r1 fix).
    expect(out).toContain('--json');
    expect(out).toContain('--help');
  });

  test('dev.review help lists the cycle fields only', async () => {
    const { code, out } = await capture(['dev.review', '--help'], {
      opsRoot: fileURLToPath(new URL('../../src/ops/', import.meta.url)),
    });
    expect(code).toBe(0);
    for (const flag of [
      '--repoRoot=',
      '--action=',
      '--target=',
      '--base=',
      '--reviewer=',
      '--uncommitted=',
      '--includeIntegration=',
      '--testFiles=',
    ])
      expect(out).toContain(flag);
    // S2b-ii retired the author-admission branch: no admission flags survive.
    expect(out).not.toContain('--requestId=');
    expect(out).not.toContain('--cycle=');
    expect(out).not.toContain('input alternative');
    expect(out).not.toContain('does not expose a field list');
  });

  test('--ops-root on an OP subcommand: reserved run-plan flag → exit 2, stdout empty', async () => {
    // Op inputs own their schema keys — no hidden flag collision: the flag is
    // rejected as a usage error BEFORE input validation, whatever the schema.
    const { code, out, err } = await capture(['echo', '--msg=x', '--ops-root=/tmp/whatever'], {
      opsRoot,
    });
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toMatch(/--ops-root is a run-plan flag/);
  });

  test('run-plan --help renders kebab-case canonical flag forms', async () => {
    const { code, out } = await capture(['run-plan', '--help'], { opsRoot });
    expect(code).toBe(0);
    expect(out).toContain('--plan=');
    expect(out).toContain('--ops-root=');
  });
});

describe('flag parsing + round-trip parity', () => {
  test('parseFlags: JSON-parsed values, verbatim keys, positionals, duplicate rejection', () => {
    expect(parseFlags(['--msg=hello'])).toEqual({ flags: { msg: 'hello' }, unknown: [] });
    expect(parseFlags(['--max-usd=2'])).toEqual({ flags: { 'max-usd': 2 }, unknown: [] });
    expect(parseFlags(['--tags=["a","b"]'])).toEqual({ flags: { tags: ['a', 'b'] }, unknown: [] });
    expect(parseFlags(['--flag'])).toEqual({ flags: { flag: true }, unknown: [] });
    expect(parseFlags(['positional'])).toEqual({ flags: {}, unknown: ['positional'] });
    expect(() => parseFlags(['--a=1', '--a=2'])).toThrow(/duplicate flag/);
  });

  test('duplicate flag e2e: usage error (2), stdout empty — op and run-plan alike', async () => {
    // parseFlags rejects duplicate keys as a usage error at the dispatcher
    // level (before any schema or op runs): narrated, exit 2, no artifact.
    const op = await capture(['echo', '--msg=a', '--msg=b'], { opsRoot });
    expect(op.code).toBe(2);
    expect(op.out).toBe('');
    expect(op.err).toMatch(/duplicate flag --msg/);
    const runPlan = await capture(['run-plan', '--plan=p', '--plan=p'], { opsRoot });
    expect(runPlan.code).toBe(2);
    expect(runPlan.out).toBe('');
    expect(runPlan.err).toMatch(/duplicate flag --plan/);
  });

  test('round-trip parity: the op invoked directly and via the CLI agree exactly', async () => {
    // Registry entries cover every op name (invariant the scaffold asserts).
    expect((await list({ opsRoot })).map((entry) => entry.name)).toContain('echo');
    const entry = await get('echo', { opsRoot });
    if (entry === undefined) throw new Error('fixture family: no registry entry named echo');
    const op = await entry.importer();
    const direct: OpResult<unknown> = await op({ msg: 'hello' });

    const viaCli = await capture(['echo', '--msg=hello'], { opsRoot });
    expect(viaCli.code).toBe(0);
    const cliResult: unknown = JSON.parse(viaCli.out);
    // The echo fixture op is deterministic — the two results must be
    // byte-identical JSON (status equal, value deep-equal, nothing modulo).
    expect(cliResult).toEqual(direct);
    expect(JSON.stringify(cliResult)).toBe(JSON.stringify(direct));
  });
});
