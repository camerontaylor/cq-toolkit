// Differential run: the same synthetic state tree through Python's real
// `repair_tick.repair_provenance` (the oracle,
// test/helpers/publicationProvenanceOracle.py) and the TS provenance binding.
// The table lines must be equal, and a Python exception must coincide with a
// TS `PyError` of the same family. Valid review-ledger records are built by the
// Python ledger itself. Tmp state only: no network, git, forge, provider, queue
// or service state.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  filePublicationProvenance,
  type PublicationProvenance,
} from '../../../src/adapters/crq/publicationProvenance.js';
import { FixPrBacklog } from '../../../src/queue-runner/fixPrBacklog.js';
import { PyError } from '../../../src/queue-runner/pyErrors.js';
import {
  finalizePublication,
  type PublicationFinalizeEffects,
} from '../../../src/queue-runner/publicationFinalize.js';

const ORACLE = new URL('../../helpers/publicationProvenanceOracle.py', import.meta.url).pathname;
const APPS = new URL('../../../apps/crq-python', import.meta.url).pathname;
const SOURCE = new URL('../../../src/adapters/crq/publicationProvenance.ts', import.meta.url)
  .pathname;

/** `review_ledger.REPO`, the repository every Python-built review is for. */
const REPO = 'camerontaylor/cq-toolkit';
const RUN = 'run-1';

type Rec = Record<string, unknown>;
type FileSpec = string | { hex: string } | { dir: true };

interface Case {
  name: string;
  repo?: string;
  run?: unknown;
  record?: Rec;
  files?: Record<string, FileSpec>;
  outside?: Record<string, string>;
}
interface Outcome {
  ok?: unknown;
  error?: string;
}

const cleanups: string[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((dir) => rm(dir, { recursive: true, force: true })));
});

function runOracle(cases: unknown[]): Outcome[] {
  const stdout = execFileSync('python3', ['-I', ORACLE, APPS], {
    input: JSON.stringify({ cases }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? '' },
  });
  return (JSON.parse(stdout) as { results: Outcome[] }).results;
}

/** The oracle's wire form of a case. */
const wire = (item: Case): Rec => ({
  op: 'provenance',
  repo: item.repo ?? REPO,
  run: 'run' in item ? item.run : RUN,
  record: item.record ?? { jobs: [] },
  files: item.files ?? {},
  outside: item.outside ?? {},
});

async function layOut(base: string, files: Record<string, FileSpec> | undefined): Promise<void> {
  for (const [rel, spec] of Object.entries(files ?? {})) {
    const path = join(base, rel);
    if (typeof spec === 'object' && 'dir' in spec) {
      await mkdir(path, { recursive: true });
      continue;
    }
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, typeof spec === 'string' ? spec : Buffer.from(spec.hex, 'hex'));
  }
}

async function runTs(item: Case): Promise<Outcome> {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), 'crq-provenance-')));
  cleanups.push(tmp);
  const state = join(tmp, 'root', 'state');
  const outside = join(tmp, 'outside');
  await mkdir(state, { recursive: true });
  await mkdir(outside);
  const spec = JSON.parse(JSON.stringify(wire(item)).replaceAll('${OUT}', outside)) as {
    repo: string;
    run: string;
    record: Rec;
    files: Record<string, FileSpec>;
    outside: Record<string, FileSpec>;
  };
  await layOut(state, spec.files);
  await layOut(outside, spec.outside);
  const binding = filePublicationProvenance({ stateRoot: state, repo: spec.repo });
  try {
    return { ok: await binding.repairProvenance(spec.record, spec.run) };
  } catch (error) {
    return {
      error: error instanceof PyError ? error.kind : `JS ${String(error)}`,
    };
  }
}

/** The per-run tmp directory differs between the two sides; compare it as `<TMP>`. */
function normalize(outcome: Outcome): Outcome {
  if (!Array.isArray(outcome.ok)) return outcome;
  const tmp = /\/[^\s`|]*crq-provenance(?:-oracle)?-[A-Za-z0-9_]+/g;
  return { ok: (outcome.ok as string[]).map((line) => line.replace(tmp, '<TMP>')) };
}

/** Run every case through both implementations and require agreement. */
async function expectParity(cases: Case[]): Promise<Outcome[]> {
  const oracle = runOracle(cases.map(wire)).map(normalize);
  for (const [index, item] of cases.entries()) {
    const python = oracle[index] as Outcome;
    expect(normalize(await runTs(item)), `${item.name}: python ${JSON.stringify(python)}`).toEqual(
      python,
    );
  }
  return oracle;
}

/** Python acts on the case; the TS binding refuses it on purpose. */
async function expectNarrowed(item: Case): Promise<void> {
  const [python] = runOracle([wire(item)]);
  expect(python?.error, `${item.name}: Python succeeds`).toBeUndefined();
  const ts = await runTs(item);
  expect(ts.ok, `${item.name}: TS refuses`).toBeUndefined();
  expect(ts.error, item.name).toBeDefined();
}

const lines = (outcome: Outcome | undefined): string[] => outcome?.ok as string[];
const rows = (outcome: Outcome | undefined): string[] => lines(outcome).slice(5);

// -------------------------------------------------------------- fixtures

const inbox = (id: string): string => `repair/inbox/${id}.json`;
const jobFiles = (jobs: Record<string, unknown>): Record<string, FileSpec> =>
  Object.fromEntries(
    Object.entries(jobs).map(([id, body]) => [
      inbox(id),
      typeof body === 'string' ? body : JSON.stringify(body),
    ]),
  );
/** A case whose record lists exactly the given jobs, in order. */
const jobCase = (name: string, jobs: Record<string, unknown>, extra: Partial<Case> = {}): Case => ({
  name,
  record: { jobs: Object.keys(jobs) },
  ...extra,
  files: { ...jobFiles(jobs), ...extra.files },
});

const ROLLOUT = {
  operational_ruling: 'ruling',
  no_live_run_verification: true,
  owner_branch_ruleset_evidence: 'evidence',
  durable_artifact_root: '/artifacts',
  runner_identity: 'crq-runner-app',
  publisher_spool: { ssh_alias: 'runner@example.com', key: '/key' },
};
const rollout = (patch: Rec = {}): FileSpec => JSON.stringify({ ...ROLLOUT, ...patch });
const PENDING = 'backfill/publication/pending';

interface Built {
  record: Rec & { id: string };
  finding_ids: string[];
}
let built: { a: Built; b: Built } | undefined;
/** Two schema-valid reviews from the Python ledger: run-1 (two findings) and run-2 (one). */
function reviews(): { a: Built; b: Built } {
  if (built === undefined) {
    const out = runOracle([
      { op: 'review', source: 'run-1', findings: [{ title: 'one' }, { title: 'two' }] },
      { op: 'review', source: 'run-2', findings: [{ title: 'three' }] },
    ]);
    built = { a: out[0]?.ok as Built, b: out[1]?.ok as Built };
  }
  return built;
}
const pendingFile = (review: Rec & { id: string }): [string, FileSpec] => [
  `${PENDING}/${review.id}.json`,
  JSON.stringify(review),
];
const ledgerUrl = (id: string): string =>
  `[ledger review](https://github.com/${REPO}/blob/cq/review-ledger/records/2026/10/${id}.json)`;

/** A canonical-finding job over review A and its finished state tree. */
function reviewed(
  name: string,
  patch: { job?: Rec; files?: Record<string, FileSpec>; repo?: string } = {},
): Case {
  const { a } = reviews();
  return jobCase(
    name,
    { 'crq-r': { canonical_finding_id: a.finding_ids[0], review_id: a.record.id, ...patch.job } },
    {
      ...(patch.repo === undefined ? {} : { repo: patch.repo }),
      files: {
        'backfill-rollout.json': rollout(),
        ...Object.fromEntries([pendingFile(a.record)]),
        ...patch.files,
      },
    },
  );
}

// ----------------------------------------------------------------- tests

describe('repairProvenance parity: table text and ordering', () => {
  it('no jobs is the header alone, exactly as Python writes it', async () => {
    const [out] = await expectParity([{ name: 'empty', record: { jobs: [] } }]);
    expect(lines(out)).toEqual([
      '',
      'Source run: `run-1`',
      '',
      '| finding ID | source ledger/review | source |',
      '|---|---|---|',
    ]);
  });

  it('one row per job, in record order, with the exact cell text', async () => {
    const [out] = await expectParity([
      jobCase('two jobs', {
        'crq-b': { finding: { id: 'F-b' }, pr: 12 },
        'crq-a': { finding: { id: 'F-a' } },
      }),
    ]);
    expect(rows(out)).toEqual([
      '| `F-b` | `run-1` | https://github.com/camerontaylor/cq-toolkit/pull/12 |',
      '| `F-a` | `run-1` | threadless; local source `state/repair/inbox/crq-a.json` |',
    ]);
  });

  it('the finding id: canonical, finding.id, finding.source_id, source.id, source.source_id, job id', async () => {
    const [out] = await expectParity([
      jobCase('fid chain', {
        'crq-j1': {},
        'crq-j2': { finding: { id: 'F-id', source_id: 'F-src' }, source: { id: 'S-id' } },
        'crq-j3': { finding: { source_id: 'F-src' } },
        'crq-j4': { finding: { id: '' }, source: { id: 'S-id', source_id: 'S-src' } },
        'crq-j5': { source: { source_id: 'S-src' } },
        'crq-j6': { finding: {}, source: {} },
        'crq-j7': { finding: { id: 0, source_id: false }, source: { id: null, source_id: [] } },
        'crq-j8': { finding: { id: 7 } },
        'crq-j9': { finding: { id: 1.5 } },
        'crq-j10': { finding: { id: true } },
        'crq-j11': '{"finding":{"id":7.0}}',
        'crq-j12': '{"finding":{"id":12345678901234567890}}',
      }),
    ]);
    expect(rows(out).map((row) => row.split('`')[1])).toEqual([
      'crq-j1',
      'F-id',
      'F-src',
      'S-id',
      'S-src',
      'crq-j6',
      'crq-j7',
      '7',
      '1.5',
      'True',
      '7.0',
      '12345678901234567890',
    ]);
  });

  it('the source cell: review_id, source.review_id, source.run, run, then the record run', async () => {
    const [out] = await expectParity([
      jobCase('origin chain', {
        'crq-o1': { review_id: 'R', source: { review_id: 'SR', run: 'sr' }, run: 'jr' },
        'crq-o2': { source: { review_id: 'SR', run: 'sr' }, run: 'jr' },
        'crq-o3': { source: { run: 'sr' }, run: 'jr' },
        'crq-o4': { run: 'jr' },
        'crq-o5': { review_id: '', source: { review_id: '', run: '' }, run: '' },
        'crq-o6': { review_id: 0, source: { review_id: null, run: false }, run: null },
        'crq-o7': { review_id: 5 },
        'crq-o8': { review_id: 2.5 },
      }),
    ]);
    expect(rows(out).map((row) => row.split('`')[3])).toEqual([
      'R',
      'SR',
      'sr',
      'jr',
      'run-1',
      'run-1',
      '5',
      '2.5',
    ]);
  });

  it('the link cell: a truthy pr is the PR URL with Python str() of the value, else threadless', async () => {
    const [out] = await expectParity([
      jobCase('pr links', {
        'crq-p1': { pr: 0 },
        'crq-p2': { pr: '9' },
        'crq-p3': { pr: '' },
        'crq-p4': '{"pr":7.0}',
        'crq-p5': { pr: true },
        'crq-p6': { pr: null },
        'crq-p7': '{"pr":12345678901234567890}',
        'crq-p8': { pr: 1.5 },
        'crq-p9': '{"pr":1e22}',
        'crq-p10': { pr: false },
        'crq-p11': { pr: 'x/y' },
      }),
    ]);
    expect(rows(out).map((row) => row.split('| ')[3]?.replace(/ \|$/, '').trim())).toEqual([
      'threadless; local source `state/repair/inbox/crq-p1.json`',
      `https://github.com/${REPO}/pull/9`,
      'threadless; local source `state/repair/inbox/crq-p3.json`',
      `https://github.com/${REPO}/pull/7.0`,
      `https://github.com/${REPO}/pull/True`,
      'threadless; local source `state/repair/inbox/crq-p6.json`',
      `https://github.com/${REPO}/pull/12345678901234567890`,
      `https://github.com/${REPO}/pull/1.5`,
      `https://github.com/${REPO}/pull/1e+22`,
      'threadless; local source `state/repair/inbox/crq-p10.json`',
      `https://github.com/${REPO}/pull/x/y`,
    ]);
  });

  it('the repository in a PR link is the binding repository, not the ledger one', async () => {
    const [out] = await expectParity([
      jobCase('other repo', { 'crq-a': { pr: 3 } }, { repo: 'o/r' }),
    ]);
    expect(rows(out)).toEqual(['| `crq-a` | `run-1` | https://github.com/o/r/pull/3 |']);
  });

  it('Unicode and markup in ids are copied verbatim, including backticks and pipes', async () => {
    await expectParity([
      jobCase('verbatim', {
        'crq-u1': { finding: { id: 'é`|\\u2028 😀' }, review_id: 'a|b`c' },
        'crq-u2': { finding: { id: '\n\r\t' }, run: 'x' },
      }),
    ]);
  });
});

describe('repairProvenance parity: the local source locator', () => {
  it('the raw review.ndjson of the source run when it exists, else the job file', async () => {
    const [out] = await expectParity([
      jobCase(
        'raw review',
        {
          'crq-l1': {},
          'crq-l2': { source: { run: 'other' } },
          'crq-l3': { run: 'jr' },
          'crq-l4': { source: { run: 'missing' }, run: 'jr' },
          'crq-l5': { source: { run: 'dir' } },
        },
        {
          files: {
            'runs/run-1/review.ndjson': '',
            'runs/other/review.ndjson': '{}\n',
            'runs/jr/review.ndjson': '{}\n',
            'runs/dir/review.ndjson': { dir: true },
          },
        },
      ),
    ]);
    expect(rows(out).map((row) => row.split('`').at(-2))).toEqual([
      'state/runs/run-1/review.ndjson',
      'state/runs/other/review.ndjson',
      'state/runs/jr/review.ndjson',
      'state/repair/inbox/crq-l4.json',
      'state/runs/dir/review.ndjson',
    ]);
  });

  it('pathlib joining: dots, empty segments and trailing slashes drop; .. stays; absolute replaces', async () => {
    await expectParity([
      jobCase(
        'lexical',
        {
          'crq-d1': { source: { run: './run-1' } },
          'crq-d2': { source: { run: 'run-1/' } },
          'crq-d3': { source: { run: 'run-1//' } },
          'crq-d4': { source: { run: '.' } },
          'crq-d5': { source: { run: 'x/../run-1' } },
          'crq-d6': { source: { run: '/nonexistent-crq-run' } },
          'crq-d7': { source: { run: '//nonexistent-crq-run' } },
          'crq-d8': { source: { run: 'a/./b//c' } },
          'crq-d9': { source: { run: '..' } },
          'crq-d10': { source: { run: 'run\u00001' } },
        },
        {
          files: {
            'runs/run-1/review.ndjson': '',
            'runs/x': { dir: true },
            'runs/review.ndjson': '',
          },
        },
      ),
    ]);
  });

  it('a source run outside the repository root: relative_to raises unless a PR link is used', async () => {
    const outside = { 'review.ndjson': '{}\n' };
    const [bare, linked] = await expectParity([
      jobCase('outside, threadless', { 'crq-a': { source: { run: '${OUT}' } } }, { outside }),
      jobCase('outside, pr link', { 'crq-a': { source: { run: '${OUT}' }, pr: 4 } }, { outside }),
    ]);
    expect(bare?.error).toBe('ValueError');
    expect(rows(linked)).toEqual([
      `| \`crq-a\` | \`<TMP>/outside\` | https://github.com/${REPO}/pull/4 |`,
    ]);
  });

  it('a stat failure under the run directory reads as absent, not an error', async () => {
    await expectParity([
      jobCase(
        'stat failures',
        {
          'crq-a': { source: { run: 'file' } },
          'crq-b': { source: { run: 'long' + 'x'.repeat(5000) } },
        },
        { files: { 'runs/file': 'not a directory' } },
      ),
    ]);
  });

  it('a canonical finding uses its triage row when it exists, else the job file', async () => {
    const [out] = await expectParity([
      jobCase(
        'triage rows',
        {
          'crq-t1': { canonical_finding_id: 'F-1', run: 'jr' },
          'crq-t2': { canonical_finding_id: 'F-2' },
          'crq-t3': { canonical_finding_id: 'F-3', pr: 8 },
          'crq-t4': { canonical_finding_id: 'F-dir' },
        },
        {
          files: {
            'backfill/findings/triage/F-1.json': '{}',
            'backfill/findings/triage/F-3.json': '{}',
            'backfill/findings/triage/F-dir.json': { dir: true },
            'runs/jr/review.ndjson': '',
          },
        },
      ),
    ]);
    expect(rows(out).map((row) => row.split('`').at(-2))).toEqual([
      'state/backfill/findings/triage/F-1.json',
      'state/repair/inbox/crq-t2.json',
      'state/backfill/findings/triage/F-3.json',
      'state/backfill/findings/triage/F-dir.json',
    ]);
    // The raw review of crq-t1's run is not consulted once a canonical id is set.
    expect(rows(out)[0]).not.toContain('review.ndjson');
  });

  it('a canonical finding id is joined as a path: separators, dots and absolute ids', async () => {
    await expectParity([
      jobCase(
        'canonical id as path',
        {
          'crq-a': { canonical_finding_id: 'a/b' },
          'crq-b': { canonical_finding_id: '../x' },
          'crq-c': { canonical_finding_id: '/abs' },
          'crq-d': { canonical_finding_id: '.' },
          'crq-e': { canonical_finding_id: 'F\u0000x' },
          'crq-f': { canonical_finding_id: '' },
        },
        { files: { 'backfill/findings/triage/a/b.json': '{}', 'backfill/findings/x.json': '{}' } },
      ),
    ]);
  });
});

describe('repairProvenance parity: the retained review lookup and ledger link', () => {
  it('a validated review of this repository that holds the finding links to its recorded-date path', async () => {
    const { a } = reviews();
    const [out] = await expectParity([reviewed('ledger link')]);
    expect(rows(out)).toEqual([
      `| \`${a.finding_ids[0]}\` | \`${a.record.id}\` | ${ledgerUrl(a.record.id)} |`,
    ]);
  });

  it('the review is found by review_id, then source.review_id; the second finding links too', async () => {
    const { a } = reviews();
    const [viaSource, viaFallthrough, second] = await expectParity([
      reviewed('source.review_id', {
        job: { review_id: undefined, source: { review_id: a.record.id } },
      }),
      reviewed('falsy review_id falls through', {
        job: { review_id: '', source: { review_id: a.record.id } },
      }),
      reviewed('second finding', { job: { canonical_finding_id: a.finding_ids[1] } }),
    ]);
    for (const out of [viaSource, viaFallthrough, second]) {
      expect(rows(out)[0]).toContain(ledgerUrl(a.record.id));
    }
  });

  it('a ledger link replaces the PR link and the lookup runs once for many jobs', async () => {
    const { a, b } = reviews();
    const [out] = await expectParity([
      jobCase(
        'several canonical jobs',
        {
          'crq-1': { canonical_finding_id: a.finding_ids[0], review_id: a.record.id, pr: 5 },
          'crq-2': { finding: { id: 'plain' } },
          'crq-3': { canonical_finding_id: b.finding_ids[0], review_id: b.record.id },
          'crq-4': { canonical_finding_id: 'unknown', review_id: a.record.id },
        },
        {
          files: {
            'backfill-rollout.json': rollout(),
            ...Object.fromEntries([pendingFile(a.record), pendingFile(b.record)]),
          },
        },
      ),
    ]);
    expect(rows(out)[0]).toContain(ledgerUrl(a.record.id));
    expect(rows(out)[1]).toContain('threadless; local source `state/repair/inbox/crq-2.json`');
    expect(rows(out)[2]).toContain(ledgerUrl(b.record.id));
    expect(rows(out)[3]).toContain('threadless; local source `state/repair/inbox/crq-4.json`');
  });

  it('an unvalidated, foreign, unrelated or unknown review keeps the local locator', async () => {
    const { a, b } = reviews();
    const tampered = structuredClone(a.record) as Rec & { id: string };
    (tampered.payload as Rec).subject_id = 'forged';
    const emptySchema = structuredClone(a.record) as Rec & { id: string };
    delete emptySchema.payload;
    const out = await expectParity([
      reviewed('repo mismatch', { repo: 'o/r' }),
      reviewed('finding absent from review', { job: { canonical_finding_id: 'not-there' } }),
      reviewed('review of another run', {
        job: { review_id: b.record.id },
        files: Object.fromEntries([pendingFile(b.record)]),
      }),
      reviewed('review id unknown', { job: { review_id: 'f'.repeat(64) } }),
      reviewed('no review id at all', { job: { review_id: undefined } }),
      reviewed('review id not a string', { job: { review_id: 1 } }),
      reviewed('review id float', { job: { review_id: 1.5 } }),
      reviewed('review id true', { job: { review_id: true } }),
      reviewed('tampered record fails validation', {
        files: Object.fromEntries([[`${PENDING}/${a.record.id}.json`, JSON.stringify(tampered)]]),
      }),
      reviewed('record without payload', {
        files: Object.fromEntries([
          [`${PENDING}/${a.record.id}.json`, JSON.stringify(emptySchema)],
        ]),
      }),
    ]);
    for (const [index, result] of out.entries()) {
      expect(rows(result)[0], `case ${index}`).toContain('threadless; local source');
    }
  });

  it('only review events count; non-objects and other events are skipped, the later duplicate wins', async () => {
    const { a } = reviews();
    const tampered = structuredClone(a.record);
    (tampered.payload as Rec).subject_id = 'forged';
    const [skipped, duplicate, laterWins] = await expectParity([
      reviewed('skipped records', {
        files: {
          [`${PENDING}/0-list.json`]: '[]',
          [`${PENDING}/0-null.json`]: 'null',
          [`${PENDING}/0-str.json`]: '"x"',
          [`${PENDING}/0-other.json`]: '{"event_type":"ack"}',
          [`${PENDING}/0-id-only.json`]: '{"id":"x"}',
          [`${PENDING}/9-note.txt`]: 'not json',
          [`${PENDING}/9.json.bak`]: 'not json',
        },
      }),
      reviewed('duplicate id, later is valid', {
        files: { [`${PENDING}/0-dup.json`]: JSON.stringify(tampered) },
      }),
      reviewed('duplicate id, later is tampered', {
        files: { [`${PENDING}/zz-dup.json`]: JSON.stringify({ ...tampered, id: a.record.id }) },
      }),
    ]);
    expect(rows(skipped)[0]).toContain('[ledger review]');
    expect(rows(duplicate)[0]).toContain('[ledger review]');
    expect(rows(laterWins)[0]).toContain('threadless');
  });

  it('files sort by name in code point order, so the later duplicate is the one a sort picks', async () => {
    const { a } = reviews();
    const forged = { ...structuredClone(a.record), payload: { forged: true } };
    const names = ['B', 'a', 'é', '', '😀', ' ', '0', '.hidden'];
    const out = await expectParity(
      names.map((name) =>
        reviewed(`duplicate named ${JSON.stringify(name)}`, {
          files: { [`${PENDING}/${name}.json`]: JSON.stringify(forged) },
        }),
      ),
    );
    // Whichever file sorts last wins; the real record's name is a 64-digit hex string.
    expect(new Set(out.map((o) => rows(o)[0]?.includes('[ledger review]'))).size).toBeGreaterThan(
      1,
    );
  });

  it('every failure of the lookup (OSError, ValueError, KeyError) collapses to the local locator', async () => {
    const { a } = reviews();
    const record = pendingFile(a.record);
    const cases: Case[] = [
      reviewed('no rollout file', { files: { 'backfill-rollout.json': undefined as never } }),
      reviewed('rollout is a directory', { files: { 'backfill-rollout.json': { dir: true } } }),
      reviewed('rollout malformed JSON', { files: { 'backfill-rollout.json': '{' } }),
      reviewed('rollout empty', { files: { 'backfill-rollout.json': '' } }),
      reviewed('rollout invalid UTF-8', { files: { 'backfill-rollout.json': { hex: 'ff' } } }),
      reviewed('rollout holds a float', {
        files: { 'backfill-rollout.json': rollout({ n: 1.5 }) },
      }),
      reviewed('rollout duplicate key', {
        files: { 'backfill-rollout.json': '{"a":1,"a":2}' },
      }),
      reviewed('rollout missing a field', {
        files: { 'backfill-rollout.json': rollout({ operational_ruling: '' }) },
      }),
      reviewed('rollout runner identity', {
        files: { 'backfill-rollout.json': rollout({ runner_identity: 'someone' }) },
      }),
      reviewed('rollout spool shape', {
        files: { 'backfill-rollout.json': rollout({ publisher_spool: { ssh_alias: 'x' } }) },
      }),
      reviewed('rollout durable root falsy', {
        files: { 'backfill-rollout.json': rollout({ durable_artifact_root: '' }) },
      }),
      reviewed('rollout durable root has a NUL', {
        files: { 'backfill-rollout.json': rollout({ durable_artifact_root: '/a\u0000b' }) },
      }),
      reviewed('no pending directory', { files: { [record[0]]: undefined as never } }),
      reviewed('pending is a file', {
        files: { [record[0]]: undefined as never, 'backfill/publication/pending': 'x' },
      }),
      reviewed('malformed record before the valid one', {
        files: { [`${PENDING}/0-bad.json`]: '{' },
      }),
      reviewed('malformed record after the valid one', {
        files: { [`${PENDING}/zz-bad.json`]: '{' },
      }),
      reviewed('record with a float', { files: { [`${PENDING}/0-f.json`]: '{"x":1.5}' } }),
      reviewed('record with invalid UTF-8', { files: { [`${PENDING}/0-u.json`]: { hex: 'ff' } } }),
      reviewed('a directory named .json', { files: { [`${PENDING}/0-dir.json`]: { dir: true } } }),
      reviewed('review without an id', {
        files: { [`${PENDING}/0-noid.json`]: '{"event_type":"review"}' },
      }),
      reviewed('review without an id after the valid one', {
        files: { [`${PENDING}/zz-noid.json`]: '{"event_type":"review"}' },
      }),
    ];
    const out = await expectParity(cases.map(dropUndefinedFiles));
    for (const [index, result] of out.entries()) {
      expect(rows(result)[0], cases[index]?.name).toContain('threadless; local source');
    }
  });

  it('only a canonical job reads the rollout: plain jobs never see a broken one', async () => {
    const [out] = await expectParity([
      jobCase(
        'plain jobs',
        { 'crq-a': { finding: { id: 'F' } }, 'crq-b': { pr: 2 } },
        { files: { 'backfill-rollout.json': '[]' } },
      ),
    ]);
    expect(lines(out)).toHaveLength(7);
  });
});

describe('repairProvenance parity: errors that escape the lookup', () => {
  it('a rollout that is not an object is an AttributeError, not a collapsed lookup', async () => {
    const out = await expectParity(
      ['[]', '"x"', 'null', '5', 'true'].map((text) =>
        reviewed(`rollout ${text}`, { files: { 'backfill-rollout.json': text } }),
      ),
    );
    expect(out.map((o) => o.error)).toEqual(Array(5).fill('AttributeError'));
  });

  it('a durable root that is not a string is a TypeError', async () => {
    const out = await expectParity(
      [5, true, ['/a'], { a: 1 }].map((root) =>
        reviewed(`durable root ${JSON.stringify(root)}`, {
          files: { 'backfill-rollout.json': rollout({ durable_artifact_root: root }) },
        }),
      ),
    );
    expect(out.map((o) => o.error)).toEqual(Array(4).fill('TypeError'));
  });

  it('an unhashable review id in a retained record is a TypeError, a missing one is collapsed', async () => {
    const [unhashable, missingFirst, unhashableFirst] = await expectParity([
      reviewed('unhashable id', {
        files: { [`${PENDING}/0-list.json`]: '{"event_type":"review","id":[1]}' },
      }),
      reviewed('missing id sorts before the unhashable one', {
        files: {
          [`${PENDING}/0-a.json`]: '{"event_type":"review"}',
          [`${PENDING}/0-b.json`]: '{"event_type":"review","id":[1]}',
        },
      }),
      reviewed('unhashable id sorts before the missing one', {
        files: {
          [`${PENDING}/0-a.json`]: '{"event_type":"review","id":{"x":1}}',
          [`${PENDING}/0-b.json`]: '{"event_type":"review"}',
        },
      }),
    ]);
    expect(unhashable?.error).toBe('TypeError');
    expect(missingFirst?.error).toBeUndefined();
    expect(unhashableFirst?.error).toBe('TypeError');
  });

  it('an unhashable review_id lookup key is a TypeError, even when the lookup collapsed', async () => {
    const out = await expectParity([
      reviewed('list review_id', { job: { review_id: ['x'] } }),
      reviewed('dict review_id', { job: { review_id: { a: 1 } } }),
      reviewed('list source.review_id', { job: { review_id: '', source: { review_id: [1] } } }),
      reviewed('falsy list is the last term', {
        job: { review_id: '', source: { review_id: [] } },
      }),
      reviewed('falsy dict is the last term', { job: { review_id: 0, source: { review_id: {} } } }),
      reviewed('collapsed lookup, list key', {
        job: { review_id: ['x'] },
        files: { 'backfill-rollout.json': '{' },
      }),
      reviewed('truthy review_id shields the unhashable one', {
        job: { source: { review_id: ['x'] } },
      }),
    ]);
    expect(out.map((o) => o.error)).toEqual([
      'TypeError',
      'TypeError',
      'TypeError',
      'TypeError',
      'TypeError',
      'TypeError',
      undefined,
    ]);
  });

  it('a canonical id that is not a string cannot name a triage row: TypeError', async () => {
    const out = await expectParity(
      [5, true, ['x'], { a: 1 }, 1.5].map((id) =>
        jobCase(`canonical id ${JSON.stringify(id)}`, { 'crq-a': { canonical_finding_id: id } }),
      ),
    );
    expect(out.map((o) => o.error)).toEqual(Array(5).fill('TypeError'));
  });
});

describe('repairProvenance parity: missing and malformed inputs', () => {
  it('a missing, unreadable or malformed job file aborts the whole table', async () => {
    const out = await expectParity([
      { name: 'missing job file', record: { jobs: ['crq-a'] } },
      jobCase(
        'job file is a directory',
        { 'crq-a': { finding: { id: 'x' } } },
        {
          files: { [inbox('crq-a')]: { dir: true } },
        },
      ),
      jobCase('empty file', { 'crq-a': '' }),
      jobCase('truncated', { 'crq-a': '{"finding":' }),
      jobCase('trailing garbage', { 'crq-a': '{} x' }),
      jobCase('BOM', { 'crq-a': '﻿{}' }),
      jobCase('NaN is accepted by json', { 'crq-a': '{"finding":{"id":NaN}}' }),
      jobCase(
        'invalid UTF-8',
        {},
        {
          record: { jobs: ['crq-a'] },
          files: { [inbox('crq-a')]: { hex: '7b2266223a22ff227d' } },
        },
      ),
      jobCase(
        'second job missing, first fine',
        { 'crq-a': {} },
        {
          record: { jobs: ['crq-a', 'crq-b'] },
        },
      ),
      jobCase('second job malformed, first fine', { 'crq-a': {}, 'crq-b': 'nope' }),
      jobCase('integer over 4300 digits', { 'crq-a': `{"pr":${'9'.repeat(4301)}}` }),
    ]);
    expect(out.map((o) => o.error)).toEqual([
      'OSError',
      'OSError',
      'ValueError',
      'ValueError',
      'ValueError',
      'ValueError',
      undefined,
      'ValueError',
      'OSError',
      'ValueError',
      'ValueError',
    ]);
  });

  it('a job file that is not an object is an AttributeError at the first .get', async () => {
    const out = await expectParity(
      ['[]', '[{}]', 'null', '"x"', '7', 'true', '1.5'].map((text) =>
        jobCase(`job ${text}`, { 'crq-a': text }),
      ),
    );
    expect(out.map((o) => o.error)).toEqual(Array(7).fill('AttributeError'));
  });

  it('a null or non-object finding/source is only an error where Python dereferences it', async () => {
    const out = await expectParity([
      jobCase('finding null, canonical set', {
        'crq-a': { canonical_finding_id: 'F', finding: null },
      }),
      jobCase('finding null, id from source', { 'crq-a': { finding: null, source: { id: 'S' } } }),
      jobCase('finding string, canonical set', {
        'crq-a': { canonical_finding_id: 'F', finding: 'x' },
      }),
      jobCase('finding null', { 'crq-a': { finding: null } }),
      jobCase('finding string', { 'crq-a': { finding: 'x' } }),
      jobCase('finding list', { 'crq-a': { finding: [] } }),
      jobCase('finding number', { 'crq-a': { finding: 0 } }),
      jobCase('source null', { 'crq-a': { source: null } }),
      jobCase('source string', { 'crq-a': { source: 'x' } }),
      jobCase('source list', { 'crq-a': { source: [] } }),
      jobCase('source false', { 'crq-a': { source: false } }),
      jobCase('source null, everything else set', {
        'crq-a': { canonical_finding_id: 'F', review_id: 'R', pr: 1, source: null },
      }),
      jobCase('finding string but its id is never reached', {
        'crq-a': { canonical_finding_id: 'F', review_id: 'R', pr: 1, finding: 'x' },
      }),
    ]);
    expect(out.map((o) => o.error)).toEqual([
      undefined,
      'AttributeError',
      undefined,
      'AttributeError',
      'AttributeError',
      'AttributeError',
      'AttributeError',
      'AttributeError',
      'AttributeError',
      'AttributeError',
      'AttributeError',
      'AttributeError',
      undefined,
    ]);
  });

  it('record.jobs: missing is a KeyError, null or a number a TypeError, entries must be strings', async () => {
    const out = await expectParity([
      { name: 'no jobs key', record: {} },
      { name: 'jobs null', record: { jobs: null } },
      { name: 'jobs number', record: { jobs: 3 } },
      { name: 'jobs true', record: { jobs: true } },
      { name: 'job id number', record: { jobs: [5] } },
      { name: 'job id null', record: { jobs: [null] } },
      { name: 'job id list', record: { jobs: [['crq-a']] } },
    ]);
    expect(out.map((o) => o.error)).toEqual([
      'KeyError',
      'TypeError',
      'TypeError',
      'TypeError',
      'TypeError',
      'TypeError',
      'TypeError',
    ]);
  });

  it('a run that is not a string is a TypeError before anything is read, even with no jobs', async () => {
    const out = await expectParity(
      [5, null, ['x'], { a: 1 }, true, 1.5].map((run) => ({
        name: `run ${JSON.stringify(run)}`,
        run,
        record: { jobs: [] },
      })),
    );
    expect(out.map((o) => o.error)).toEqual(Array(6).fill('TypeError'));
  });

  it('an empty or odd run string is printed as is', async () => {
    const out = await expectParity([
      { name: 'empty run', run: '' },
      { name: 'markup run', run: 'a`b|c\n' },
      jobCase('empty run, fallback', { 'crq-a': {} }, { run: '' }),
    ]);
    expect(lines(out[0])[1]).toBe('Source run: ``');
  });
});

describe('repairProvenance: where the binding refuses what Python would do', () => {
  it('a job id that is not one repair job id never reaches a path', async () => {
    await Promise.all(
      ['../outside', 'a/b', '/abs/job', '', '.', 'crq-', 'crq-a b', 'crq-a\n', 'job-1'].map(
        async (id) => {
          const item: Case = {
            name: `job id ${JSON.stringify(id)}`,
            record: { jobs: [id] },
            files: { 'repair/outside.json': '{}', 'repair/inbox/a/b.json': '{}' },
          };
          const ts = await runTs(item);
          expect(ts.error, item.name).toBe('ValueError');
        },
      ),
    );
    // Python reads whatever the path names: that is what the narrowing prevents.
    const [python] = runOracle([
      wire({
        name: 'traversal',
        record: { jobs: ['../outside'] },
        files: { 'repair/outside.json': '{}', 'repair/inbox/keep.json': '{}' },
      }),
    ]);
    expect(python?.error).toBeUndefined();
  });

  it('a jobs value that is a string or object (iterated as characters or keys) is refused', async () => {
    await expectNarrowed({
      name: 'jobs is an object of ids',
      record: { jobs: {} },
    });
    const [python] = runOracle([wire({ name: 'jobs string', record: { jobs: '' } })]);
    expect(python?.error).toBeUndefined();
    expect((await runTs({ name: 'jobs string', record: { jobs: '' } })).error).toBeDefined();
  });

  it('a PR that is a list or object (str() of a container) is refused', async () => {
    await expectNarrowed(jobCase('pr list', { 'crq-a': { pr: [1] } }));
    await expectNarrowed(jobCase('pr dict', { 'crq-a': { pr: { n: 1 } } }));
    await expectNarrowed(jobCase('finding id list', { 'crq-a': { finding: { id: [1] } } }));
    await expectNarrowed(jobCase('review_id list in the cell', { 'crq-a': { review_id: ['x'] } }));
  });
});

describe('composition with the publication orchestrator', () => {
  it('is assignable to the finalize effect declaration and imports no orchestrator code', async () => {
    const binding = filePublicationProvenance({ stateRoot: '/nonexistent', repo: REPO });
    const asFinalize: Pick<PublicationFinalizeEffects, 'repairProvenance'> = binding;
    const asOwn: PublicationProvenance = binding;
    expect([asFinalize, asOwn]).toHaveLength(2);
    const source = await readFile(SOURCE, 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.filter((specifier) => specifier?.includes('queue-runner/'))).toEqual([
      '../../queue-runner/pyErrors.js',
    ]);
  });

  it('finalizePublication appends the table after the verdict rows, before the body is written', async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), 'crq-provenance-')));
    cleanups.push(tmp);
    const state = join(tmp, 'state');
    await mkdir(join(state, 'repair', 'inbox'), { recursive: true });
    await writeFile(
      join(state, inbox('job-1')),
      JSON.stringify({ finding: { id: 'F-1' }, pr: 21 }),
    );
    const provenance = filePublicationProvenance({ stateRoot: state, repo: 'o/r' });
    const bodies: string[] = [];
    const calls: string[] = [];
    const listed = new Map<string, unknown[]>();
    const effects: PublicationFinalizeEffects = {
      repo: 'o/r',
      iso: () => 'now',
      listBranchPrs: async (branch) => (listed.get(branch) ?? []) as never,
      repairProvenance: async (record, run) => {
        calls.push('provenance');
        return provenance.repairProvenance(record, run);
      },
      writeFixPrBody: async (_jobId, text) => {
        calls.push('write-body');
        bodies.push(text);
        return '/body.md';
      },
      writeJournal: async () => undefined,
      saveQueue: async () => undefined,
      createPr: async (request) => {
        listed.set(request.head, [{ number: 101, url: 'u', state: 'OPEN', headRefOid: 'h1' }]);
      },
      newItem: async () => undefined,
    };
    const record: Rec = {
      jobs: ['job-1'],
      state: 'ready',
      verdicts: [{ job: 'job-1', verdict: 'FIXED', reason: 'ok' }],
    };
    const publication: Rec = {
      head: 'h1',
      target: 't',
      branch: 'crq/fix-run-1',
      commits: ['c1'],
      open_pr: false,
    };
    // `job-1` is not a repair job id: the binding refuses before the body is written.
    await expect(
      finalizePublication(
        effects,
        new FixPrBacklog(),
        { items: [] },
        { id: 'x', pr: 0, kind: 'merged', state: 'repairing' },
        'run-1',
        record,
        publication,
      ),
    ).rejects.toMatchObject({ kind: 'ValueError' });
    expect(calls).toEqual(['provenance']);

    // The same table with a valid job id lands between the verdicts and the write.
    await writeFile(
      join(state, inbox('crq-job')),
      JSON.stringify({ finding: { id: 'F-1' }, pr: 21 }),
    );
    record.jobs = ['crq-job'];
    record.verdicts = [{ job: 'crq-job', verdict: 'FIXED', reason: 'ok' }];
    calls.length = 0;
    await finalizePublication(
      effects,
      new FixPrBacklog(),
      { items: [] },
      { id: 'x', pr: 0, kind: 'merged', state: 'repairing' },
      'run-1',
      record,
      publication,
    );
    expect(calls.slice(0, 2)).toEqual(['provenance', 'write-body']);
    expect(bodies).toEqual([
      [
        'Verified CodeRabbit repairs from run-1',
        '',
        '| finding | verdict | reason |',
        '|---|---|---|',
        '| crq-job | FIXED | ok |',
        '',
        'Source run: `run-1`',
        '',
        '| finding ID | source ledger/review | source |',
        '|---|---|---|',
        '| `F-1` | `run-1` | https://github.com/o/r/pull/21 |',
        '',
      ].join('\n'),
    ]);
  });
});

/** Cases mark a file to remove with `undefined`; drop those entries from a wire case. */
function dropUndefinedFiles(item: Case): Case {
  const files = Object.fromEntries(
    Object.entries(item.files ?? {}).filter(([, spec]) => spec !== undefined),
  );
  return { ...item, files };
}
