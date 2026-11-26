/**
 * Replays `apps/crq-python/fixtures/crq-repair-harvest-rest/cases.json`, emitted by
 * `repair_harvest_rest_vectors.py` from the PRODUCTION `repair_tick.finalize_publication`
 * (run with `crq.run`, `crq.gh_json`, `crq.new_item`, `crq.save_queue`, `crq.iso`), the
 * admission-history compaction log of `crq.save_queue` and the gitleaks block of
 * `crq.secret_scan_diff`, against `ghCreateRepairPr`, `fileRepairNewItem`,
 * `fileRepairSaveQueue` and `fileReviewGitleaks`.
 *
 * `gh` and `gitleaks` are fake scripts taken verbatim from the fixture, so both sides run
 * byte-identical binaries on a temporary PATH. Nothing here reaches a forge, a token or the
 * network. Queue, item, record and publication come from the lossless parse, so floats arrive
 * as `JsonNumber` wrappers exactly as the production loader produces them. Where the TS side
 * is deliberately stricter than Python (a gitleaks report Python reads loosely), the case is
 * pinned in `GITLEAKS_TS` rather than silently skipped.
 */
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fileRepairNewItem,
  fileRepairSaveQueue,
  ghCreateRepairPr,
  QueueCompaction,
  queueIdentity,
  type QueueIdentity,
} from '../../../src/adapters/crq/repairHarvestForge.js';
import { filePublicationEffects } from '../../../src/adapters/crq/publicationFiles.js';
import { forgePublicationReads } from '../../../src/adapters/crq/publicationForgeReads.js';
import { fileReviewGitleaks } from '../../../src/adapters/crq/reviewGitleaks.js';
import { makeGhRunner } from '../../../src/adapters/forge-github/gh.js';
import { parseJsonValue, toPlainJsonRetainingNumbers } from '../../../src/policy/crq/jsonValue.js';
import type { JsonObject } from '../../../src/policy/crq/jsonValue.js';
import { pythonJsonText } from '../../../src/policy/crq/pythonJson.js';
import { fromPlainJson } from '../../../src/policy/crq/queueDoc.js';
import { FixPrBacklog } from '../../../src/queue-runner/fixPrBacklog.js';
import {
  finalizePublication,
  type PublicationFinalizeEffects,
} from '../../../src/queue-runner/publicationFinalize.js';
import { PyError } from '../../../src/queue-runner/pyErrors.js';
import { oraclePython } from '../../helpers/oraclePython.js';

type Rec = Record<string, unknown>;
interface Spec {
  name: string;
  op: 'finalize' | 'compaction' | 'gitleaks' | 'timeout-text';
  queue_text?: string;
  item_index?: number;
  backlog?: { open: number | null; limit: number | null };
  fix_pr_cycles?: number | null;
  publication?: Rec;
  record?: Rec | null;
  gh?: Rec;
  pending?: 'fresh' | 'stale' | 'missing' | 'none';
  twice?: boolean;
  diff?: string;
  spec?: Rec;
  present?: boolean;
  argv?: string[];
}
interface Expected {
  error?: string | null;
  message?: string;
  backlog?: { open: number | null; limit: number | null };
  queue_bytes?: string | null;
  events?: string | null;
  body?: string | null;
  journal?: string | null;
  gh_log?: string[][];
  saves?: {
    error: string | null;
    message?: string;
    stderr: string;
    queue_bytes: string | null;
    pending_cleared: boolean;
  }[];
  ok?: boolean;
  status?: string;
  hits?: { rule: unknown; diff_line: unknown }[];
  invocation?: { argv: string[]; stdin: string } | null;
  text?: string;
}

const fixtureText = await readFile(
  new URL('../../../apps/crq-python/fixtures/crq-repair-harvest-rest/cases.json', import.meta.url),
  'utf8',
);
const document = JSON.parse(fixtureText) as {
  gh_script: string;
  gitleaks_script: string;
  cases: { name: string; scenario: Spec; expected: Expected }[];
};
const cases = document.cases;
const lossless = (parseJsonValue(fixtureText) as JsonObject).get('cases') as JsonObject[];
const field = (index: number, section: 'scenario' | 'expected', key: string): unknown => {
  const holder = lossless[index]!.get(section) as JsonObject;
  return holder.has(key) ? toPlainJsonRetainingNumbers(holder.get(key) as never) : undefined;
};
const text = (value: unknown): string =>
  pythonJsonText(fromPlainJson(value), {
    asciiOnly: true,
    sortKeys: true,
    keyOrder: 'code-point',
    indent: null,
  });

/** The class a thrown value stands for; anything that is not a `PyError` is named, never mapped. */
function className(error: unknown): string {
  if (error instanceof PyError) return error.kind;
  return `unmapped:${error instanceof Error ? error.message : String(error)}`;
}

/** `datetime(2026, 11, 27, 1, 2, 3, 999000, UTC)`, the emitter's frozen `crq.now`. */
const FROZEN = new Date('2026-11-27T01:02:03.999Z');

/**
 * Where `fileReviewGitleaks` is deliberately stricter than Python's loose read of the report:
 * it reads the report through a size-bounded, schema-checked parse and throws one opaque error
 * that never carries scanner output (`reviewGitleaks.ts`). Python lets the raw exception out
 * or accepts the loose value. Each of these cases is pinned to the TS answer here.
 */
const OPAQUE = { error: 'unmapped:gitleaks execution or report failed' } as const;
const GITLEAKS_TS: Record<string, Record<string, unknown>> = {
  'gitleaks: exit 0 with no report file': OPAQUE,
  'gitleaks: exit 0 with an empty report file': OPAQUE,
  'gitleaks: a string line number': OPAQUE,
  'gitleaks: a zero line number': OPAQUE,
  'gitleaks: a non-string rule': OPAQUE,
  'gitleaks: a non-dict finding': OPAQUE,
  'gitleaks: a null report': OPAQUE,
  'gitleaks: an object report': OPAQUE,
  'gitleaks: a malformed report': OPAQUE,
};

/**
 * Where the TS orchestration words an error differently from CPython, class unchanged: the
 * subscript of a non-dict queue entry (`publicationFinalize.ts` names the value, CPython the
 * operation).
 */
const FINALIZE_TS_MESSAGE: Record<string, string> = {
  'a non-dict queue entry fails the enroll': 'item must be a dict',
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'repair-harvest-rest-'));
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const hex = (path: string): Promise<string | null> =>
  readFile(path).then(
    (bytes) => bytes.toString('hex'),
    () => null,
  );
const writeScript = async (path: string, source: string): Promise<void> => {
  await writeFile(path, source);
  await chmod(path, 0o755);
};
const norm = (value: string): string => value.split(root).join('/T');

async function runFinalize(spec: Spec): Promise<Expected & Rec> {
  const state = join(root, 'state');
  const clone = join(root, 'clone');
  const bin = join(root, 'bin');
  const fake = join(root, 'fake');
  for (const dir of [join(state, 'repair', 'crq-job-a'), clone, bin, fake])
    await mkdir(dir, { recursive: true });
  await writeFile(join(state, 'queue.json'), spec.queue_text!);
  await writeScript(join(bin, 'gh'), document.gh_script);
  await writeFile(join(fake, 'spec.json'), JSON.stringify(spec.gh));
  const q = toPlainJsonRetainingNumbers(parseJsonValue(spec.queue_text!) as never) as Rec;
  const item = (q.items as Rec[])[spec.item_index!] as Rec;
  // Production shape: the queue and its items keep `JsonNumber`s (the loader's parse); a
  // publication comes from `readJournal` or `publish` and a record from the repair state file,
  // both plain JSON values.
  const publication = structuredClone(spec.publication) as Rec;
  const record: Rec = structuredClone(spec.record) ?? {
    jobs: ['crq-job-a'],
    state: 'ready',
    verdicts: [{ job: 'crq-job-a', verdict: 'FIXED', reason: 'ok' }],
  };
  const backlog = new FixPrBacklog();
  backlog.open = spec.backlog!.open;
  backlog.limit = spec.backlog!.limit;
  const env = { PATH: `${bin}:${process.env.PATH ?? ''}`, GH_FAKE_DIR: fake };
  const ghBin = join(bin, 'gh');
  const reads = forgePublicationReads({
    repo: 'o/r',
    clone,
    ghFor: (request) =>
      makeGhRunner({ bin: ghBin, env, cwd: request.cwd, timeoutMs: request.timeoutMs }),
  });
  const files = filePublicationEffects({ stateRoot: state });
  const effects: PublicationFinalizeEffects = {
    repo: 'o/r',
    ...(spec.fix_pr_cycles === null || spec.fix_pr_cycles === undefined
      ? {}
      : { fixPrCycles: spec.fix_pr_cycles }),
    iso: () => `${FROZEN.toISOString().slice(0, 19)}Z`,
    listBranchPrs: (branch) => reads.listBranchPrs(branch),
    repairProvenance: async () => [],
    writeFixPrBody: (jobId, body) => files.writeFixPrBody(jobId, body),
    writeJournal: (jobId, value) => files.writeJournal(jobId, value),
    saveQueue: fileRepairSaveQueue({
      stateRoot: state,
      compaction: new QueueCompaction(),
      stderr: () => undefined,
    }),
    createPr: ghCreateRepairPr({
      repo: 'o/r',
      gh: makeGhRunner({ bin: ghBin, env, timeoutMs: 600_000 }),
    }),
    newItem: fileRepairNewItem({ stateRoot: state, now: () => FROZEN }),
  };
  const out: Rec = { error: null };
  try {
    await finalizePublication(effects, backlog, q, item, 'run-a', record, publication);
  } catch (error) {
    out.error = className(error);
    if (error instanceof PyError) out.message = norm(error.message);
  }
  out.backlog = { open: backlog.open, limit: backlog.limit };
  out.queue = norm(text(q));
  out.item = norm(text(item));
  out.record = norm(text(record));
  out.publication = norm(text(publication));
  out.queue_bytes = await hex(join(state, 'queue.json'));
  out.events = await hex(join(state, 'events.jsonl'));
  out.body = await hex(join(state, 'repair', 'crq-job-a', 'fix-pr.md'));
  out.journal = await hex(join(state, 'repair', 'crq-job-a', 'publication.json'));
  const log = join(fake, 'log.jsonl');
  out.gh_log = existsSync(log)
    ? (await readFile(log, 'utf8'))
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => (JSON.parse(line) as string[]).map(norm))
    : [];
  return out;
}

async function runCompaction(spec: Spec): Promise<Expected & Rec> {
  const state = join(root, 'state');
  await mkdir(state);
  const queuePath = join(state, 'queue.json');
  await writeFile(queuePath, spec.queue_text!);
  const compaction = new QueueCompaction();
  if (spec.pending !== 'none') compaction.note(await queueIdentity(queuePath));
  if (spec.pending === 'stale') await writeFile(queuePath, `${spec.queue_text!} `);
  if (spec.pending === 'missing') await unlink(queuePath);
  let stderr = '';
  const save = fileRepairSaveQueue({
    stateRoot: state,
    compaction,
    stderr: (line) => {
      stderr += line;
    },
  });
  const saves: Rec[] = [];
  for (let n = 0; n < (spec.twice === true ? 2 : 1); n += 1) {
    stderr = '';
    const entry: Rec = { error: null };
    try {
      const q = toPlainJsonRetainingNumbers(parseJsonValue(spec.queue_text!) as never);
      await save(q as Rec);
    } catch (error) {
      entry.error = className(error);
      if (error instanceof PyError) entry.message = error.message;
    }
    entry.stderr = stderr;
    entry.queue_bytes = await hex(queuePath);
    entry.pending_cleared = compaction.pending === null;
    saves.push(entry);
  }
  return { saves } as Expected & Rec;
}

async function runGitleaks(spec: Spec): Promise<Expected & Rec> {
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'spec.json'), JSON.stringify(spec.spec));
  const python = spawnSync(oraclePython(), ['-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8',
  }).stdout.trim();
  await symlink(python, join(bin, 'python3'));
  if (spec.present === true) await writeScript(join(bin, 'gitleaks'), document.gitleaks_script);
  const scratch = join(root, 'scratch');
  await mkdir(scratch);
  const scan = fileReviewGitleaks({ path: bin, scratchRoot: scratch });
  const out: Rec = { error: null };
  try {
    const result = await scan(Buffer.from(spec.diff!, 'hex').toString('utf8'));
    if (result.kind === 'not-run') {
      Object.assign(out, { ok: true, status: 'not-run', hits: [] });
    } else if (result.code !== 0 || result.hits === null) {
      Object.assign(out, {
        ok: false,
        status: `exit ${String(result.code)}`,
        hits: [{ rule: 'gitleaks-error', diff_line: null }],
      });
    } else {
      Object.assign(out, {
        ok: result.hits.length === 0,
        status: `exit ${String(result.code)}`,
        hits: result.hits.map((hit) => ({ rule: hit.rule, diff_line: hit.diffLine })),
      });
    }
  } catch (error) {
    out.error = className(error);
  }
  const log = join(bin, 'log.json');
  out.invocation = existsSync(log) ? (JSON.parse(await readFile(log, 'utf8')) as Rec) : null;
  return out;
}

describe('repair-harvest remaining effects against the Python oracle', () => {
  it('replays every case', () => {
    expect(cases.length).toBeGreaterThan(80);
    const ops = new Set(cases.map((c) => c.scenario.op));
    expect([...ops].sort()).toEqual(['compaction', 'finalize', 'gitleaks', 'timeout-text']);
  });

  for (const [index, { name, scenario: spec, expected }] of cases.entries()) {
    it(name, async () => {
      if (spec.op === 'finalize') {
        const got = await runFinalize(spec);
        expect(got.error).toBe(expected.error ?? null);
        expect(got.message).toBe(FINALIZE_TS_MESSAGE[name] ?? expected.message);
        expect(got.gh_log).toEqual(expected.gh_log);
        expect(got.backlog).toEqual(expected.backlog);
        for (const key of ['queue_bytes', 'events', 'body', 'journal'] as const)
          expect(got[key], key).toBe(expected[key]);
        for (const key of ['queue', 'item', 'record', 'publication'] as const)
          expect(got[key], key).toBe(norm(text(field(index, 'expected', key))));
      } else if (spec.op === 'compaction') {
        const got = await runCompaction(spec);
        expect(got.saves).toEqual(expected.saves);
      } else if (spec.op === 'gitleaks') {
        const got = await runGitleaks(spec);
        const pinned = GITLEAKS_TS[name];
        if (pinned !== undefined) {
          expect(got.error).toBe(pinned.error);
          // Python raised or accepted a loose report; the scanner was still invoked identically.
          expect(got.invocation).toEqual(expected.invocation);
        } else {
          expect(got.error).toBe(expected.error ?? null);
          expect(got.ok).toBe(expected.ok);
          expect(got.status).toBe(expected.status);
          expect(got.hits).toEqual(expected.hits);
          expect(got.invocation).toEqual(expected.invocation);
        }
      } else {
        const request = {
          base: 'main',
          head: 'b',
          title: 't',
          bodyFile: '/T/p.md',
        };
        const create = ghCreateRepairPr({
          repo: 'o/r',
          gh: async () => ({ code: 124, stdout: '', stderr: 'gh timed out after 600000ms' }),
        });
        const error = await create(request).then(
          () => null,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(PyError);
        expect((error as PyError).kind).toBe('OSError');
        expect((error as PyError).message).toBe(expected.text);
      }
    });
  }

  it('pins what the fixture can only show through Python: a float line number', () => {
    const index = cases.findIndex((c) => c.name === 'gitleaks: a float line number');
    const hits = field(index, 'expected', 'hits') as { diff_line: { kind: string } }[];
    // Python keeps 5.0 as a float; the TS report parse reads it as the integer 5.
    expect(hits[0]!.diff_line.kind).toBe('float');
    expect(cases[index]!.expected.hits![0]!.diff_line).toBe(5);
  });

  it('a missing gh binary through the real runner is the ENOENT OSError', async () => {
    const create = ghCreateRepairPr({
      repo: 'o/r',
      gh: makeGhRunner({ bin: join(root, 'absent', 'gh'), timeoutMs: 600_000 }),
    });
    const error = await create({ base: 'main', head: 'b', title: 't', bodyFile: '/T/p.md' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PyError);
    expect(className(error)).toBe('OSError');
  });

  describe('the compaction identity guard is pinned field by field', () => {
    const marked = '{"backfill_admission_history_version": 1, "items": []}';
    const attempt = async (tweak: (id: QueueIdentity) => QueueIdentity): Promise<string> => {
      const state = join(root, 'state');
      await mkdir(state);
      const queuePath = join(state, 'queue.json');
      await writeFile(queuePath, marked);
      const compaction = new QueueCompaction();
      compaction.note(tweak(await queueIdentity(queuePath)));
      let stderr = '';
      await fileRepairSaveQueue({
        stateRoot: state,
        compaction,
        stderr: (line) => {
          stderr += line;
        },
      })(JSON.parse(marked) as Rec);
      return stderr;
    };

    it('logs when every field matches', async () => {
      expect(await attempt((id) => id)).toMatch(
        /^admission compaction v1: before_bytes=\d+ after_bytes=\d+\n$/,
      );
    });

    for (const field of ['path', 'dev', 'ino', 'size', 'mtimeNs'] as const) {
      it(`stays silent when only ${field} differs`, async () => {
        const tweaked = await attempt((id) => ({
          ...id,
          [field]: field === 'path' ? `${id.path}.other` : (id[field] as bigint) + 1n,
        }));
        expect(tweaked).toBe('');
      });
    }
  });

  it('pins the unmodelled float order: fileRepairNewItem throws where Python enrolls', async () => {
    const state = join(root, 'state');
    await mkdir(state);
    const newItem = fileRepairNewItem({ stateRoot: state, now: () => FROZEN });
    const q = toPlainJsonRetainingNumbers(
      parseJsonValue('{"items": [{"id": "x", "order": 3.0, "state": "pending"}]}') as never,
    ) as Rec;
    await expect(newItem(q, { id: 'y', kind: 'open' })).rejects.toThrow(
      'unsupported item order representation',
    );
  });
});
