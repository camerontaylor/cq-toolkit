// Differential run: the same triage rows, jobs and retained events through Python's real
// `bounded.require_canonical_delivery` (written_back form; oracle:
// test/helpers/repairCanonicalDeliveryOracle.py) and the TS port. The outcome (return, or
// exception class and text) must be equal. The fixtures are files in a throwaway directory;
// `retained` is a declared list or a declared raise, so no store, forge or network is read.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalDelivery } from '../../../src/adapters/crq/repairCanonicalDelivery.js';
import {
  parseJsonValue,
  pythonNonFinite,
  toPlainJson,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import { LedgerIntegrityError } from '../../../src/policy/crq/ledger.js';
import { PyError, type PyErrorKind } from '../../../src/queue-runner/pyErrors.js';

const ORACLE = fileURLToPath(
  new URL('../../helpers/repairCanonicalDeliveryOracle.py', import.meta.url),
);
const APPS = fileURLToPath(new URL('../../../apps/crq-python', import.meta.url));
const FID = 'a'.repeat(64);
const TASK = 'crq-job-1';
let base: string;
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'crq-canon-'));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

type Retained = null | { events: string } | { raise: PyErrorKind };
interface Case {
  name: string;
  job?: string;
  /** The triage row's bytes; `absent` writes nothing, `dir` makes a directory. */
  row?: string | Buffer | 'absent' | 'dir';
  retained?: Retained;
}

const jobText = (extra = '') => `{"job":"${TASK}","canonical_finding_id":"${FID}"${extra}}`;
const row = (status: string, receipt = `{"repair_task":"${TASK}"}`, extra = '') =>
  `{"status":"${status}","receipt":${receipt}${extra}}`;
const event = (over: Record<string, string> = {}) => {
  const f = {
    id: '"e1"',
    event_type: '"finding-event"',
    source_key: '"repair-outcome:x"',
    payload: `{"actor":"crq-repair","finding_id":"${FID}","action":"fixed","evidence":{"repair_task":"${TASK}"}}`,
    ...over,
  };
  return `{${Object.entries(f)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `"${k}":${v}`)
    .join(',')}}`;
};
const payload = (over: Record<string, string> = {}) => {
  const f = {
    actor: '"crq-repair"',
    finding_id: `"${FID}"`,
    action: '"fixed"',
    evidence: `{"repair_task":"${TASK}"}`,
    ...over,
  };
  return `{${Object.entries(f)
    .map(([k, v]) => `"${k}":${v}`)
    .join(',')}}`;
};
const fixedRow = row('fixed', undefined, ',"previous_event_id":"e1"');
const events = (...items: string[]): Retained => ({ events: `[${items.join(',')}]` });

const CASES: Case[] = [
  { name: 'delivered row', row: row('delivered') },
  { name: 'job without a canonical id returns', job: `{"job":"${TASK}"}` },
  { name: 'canonical id null', job: `{"job":"${TASK}","canonical_finding_id":null}` },
  { name: 'canonical id a number', job: `{"job":"${TASK}","canonical_finding_id":5}` },
  { name: 'canonical id short', job: `{"job":"${TASK}","canonical_finding_id":"abc"}` },
  {
    name: 'canonical id uppercase hex',
    job: `{"job":"${TASK}","canonical_finding_id":"${'A'.repeat(64)}"}`,
  },
  {
    name: 'canonical id with a trailing newline',
    job: `{"job":"${TASK}","canonical_finding_id":"${FID}\\n"}`,
  },
  { name: 'row missing', row: 'absent' },
  { name: 'row is a directory', row: 'dir' },
  { name: 'row not UTF-8', row: Buffer.from([0x7b, 0xff, 0x7d]) },
  { name: 'row with a BOM', row: `﻿${row('delivered')}` },
  { name: 'row malformed JSON', row: '{"status": ' },
  { name: 'row empty file', row: '' },
  { name: 'row with NaN is valid JSON to Python', row: row('delivered', undefined, ',"x":NaN') },
  { name: 'row a list', row: '[]' },
  { name: 'row null', row: 'null' },
  { name: 'row string', row: '"delivered"' },
  { name: 'status unknown', row: row('weird') },
  { name: 'status absent', row: `{"receipt":{"repair_task":"${TASK}"}}` },
  { name: 'status a list', row: `{"status":["delivered"],"receipt":{"repair_task":"${TASK}"}}` },
  { name: 'status delivered, receipt absent', row: '{"status":"delivered"}' },
  { name: 'receipt a list', row: row('delivered', '[]') },
  { name: 'receipt null', row: row('delivered', 'null') },
  { name: 'receipt names another task', row: row('delivered', '{"repair_task":"crq-job-9"}') },
  {
    name: 'receipt and job both lack the task (None == None)',
    job: `{"canonical_finding_id":"${FID}"}`,
    row: row('delivered', '{}'),
  },
  {
    name: 'receipt lacks the task, job has one',
    row: row('delivered', '{}'),
  },
  {
    name: 'job id 1 equals receipt task 1.0',
    job: `{"job":1,"canonical_finding_id":"${FID}"}`,
    row: row('delivered', '{"repair_task":1.0}'),
  },
  {
    name: 'job id true equals receipt task 1',
    job: `{"job":true,"canonical_finding_id":"${FID}"}`,
    row: row('delivered', '{"repair_task":1}'),
  },
  {
    name: 'job id 2**64 differs from 2**64+1',
    job: `{"job":18446744073709551616,"canonical_finding_id":"${FID}"}`,
    row: row('delivered', '{"repair_task":18446744073709551617}'),
  },
  {
    name: 'duplicate status key: the last wins',
    row: `{"status":"weird","status":"delivered","receipt":{"repair_task":"${TASK}"}}`,
  },
  { name: 'fixed row with no reader fails closed', row: fixedRow, retained: null },
  { name: 'fixed row, matching outcome event', row: fixedRow, retained: events(event()) },
  {
    name: 'needs-human row, matching outcome event',
    row: row('needs-human', undefined, ',"previous_event_id":"e1"'),
    retained: events(event({ payload: payload({ action: '"needs-human"' }) })),
  },
  {
    name: 'dismissed row, matching outcome event',
    row: row('dismissed', undefined, ',"previous_event_id":"e1"'),
    retained: events(event({ payload: payload({ action: '"dismissed"' }) })),
  },
  {
    name: 'needs-retriage row, matching outcome event',
    row: row('needs-retriage', undefined, ',"previous_event_id":"e1"'),
    retained: events(event({ payload: payload({ action: '"needs-retriage"' }) })),
  },
  { name: 'event list empty', row: fixedRow, retained: events() },
  { name: 'event with another id', row: fixedRow, retained: events(event({ id: '"e2"' })) },
  {
    name: 'event type wrong',
    row: fixedRow,
    retained: events(event({ event_type: '"other"' })),
  },
  {
    name: 'source key without the prefix',
    row: fixedRow,
    retained: events(event({ source_key: '"manual:x"' })),
  },
  {
    name: 'source key absent',
    row: fixedRow,
    retained: events(event({ source_key: '' })),
  },
  {
    name: 'source key null renders as None',
    row: fixedRow,
    retained: events(event({ source_key: 'null' })),
  },
  {
    name: 'source key a number',
    row: fixedRow,
    retained: events(event({ source_key: '12' })),
  },
  {
    name: 'source key a list',
    row: fixedRow,
    retained: events(event({ source_key: '["repair-outcome:x"]' })),
  },
  {
    name: 'actor wrong',
    row: fixedRow,
    retained: events(event({ payload: payload({ actor: '"operator"' }) })),
  },
  {
    name: 'finding id wrong',
    row: fixedRow,
    retained: events(event({ payload: payload({ finding_id: `"${'b'.repeat(64)}"` }) })),
  },
  {
    name: 'action differs from the row status',
    row: fixedRow,
    retained: events(event({ payload: payload({ action: '"dismissed"' }) })),
  },
  {
    name: 'evidence not a dict',
    row: fixedRow,
    retained: events(event({ payload: payload({ evidence: '[]' }) })),
  },
  {
    name: 'evidence names another task',
    row: fixedRow,
    retained: events(event({ payload: payload({ evidence: '{"repair_task":"crq-job-9"}' }) })),
  },
  {
    name: 'payload not a dict',
    row: fixedRow,
    retained: events(event({ payload: '"fixed"' })),
  },
  {
    name: 'payload absent',
    row: fixedRow,
    retained: events(`{"id":"e1","event_type":"finding-event","source_key":"repair-outcome:x"}`),
  },
  {
    name: 'no previous_event_id and an id-less event: None == None, then the fields decide',
    row: row('fixed'),
    retained: events(event({ id: '' })),
  },
  {
    name: 'no previous_event_id, events carry ids',
    row: row('fixed'),
    retained: events(event()),
  },
  {
    name: 'previous_event_id null matches an id-less event',
    row: row('fixed', undefined, ',"previous_event_id":null'),
    retained: events(event({ id: '' })),
  },
  {
    name: 'the first event with the id decides: bad first, good second',
    row: fixedRow,
    retained: events(event({ event_type: '"other"' }), event()),
  },
  {
    name: 'the first event with the id decides: good first, bad second',
    row: fixedRow,
    retained: events(event(), event({ event_type: '"other"' })),
  },
  {
    name: 'non-dict events are skipped',
    row: fixedRow,
    retained: events('1', 'null', '"e1"', '[]', event()),
  },
  {
    name: 'event id 1 matches previous_event_id 1.0',
    row: row('fixed', undefined, ',"previous_event_id":1.0'),
    retained: events(event({ id: '1' })),
  },
  {
    name: 'event id true matches previous_event_id 1',
    row: row('fixed', undefined, ',"previous_event_id":1'),
    retained: events(event({ id: 'true' })),
  },
  {
    name: 'event id 2**64 differs from previous_event_id 2**64+1',
    row: row('fixed', undefined, ',"previous_event_id":18446744073709551617'),
    retained: events(event({ id: '18446744073709551616' })),
  },
  { name: 'retained raises OSError', row: fixedRow, retained: { raise: 'OSError' } },
  { name: 'retained raises ValueError', row: fixedRow, retained: { raise: 'ValueError' } },
  { name: 'retained raises KeyError', row: fixedRow, retained: { raise: 'KeyError' } },
  { name: 'retained raises TypeError', row: fixedRow, retained: { raise: 'TypeError' } },
  {
    name: 'retained raises RuntimeError and it escapes',
    row: fixedRow,
    retained: { raise: 'RuntimeError' },
  },
  {
    name: 'retained is not read for a delivered row',
    row: row('delivered'),
    retained: { raise: 'RuntimeError' },
  },
  {
    name: 'a mismatching receipt is refused before retained is read',
    row: row('fixed', '{"repair_task":"crq-job-9"}'),
    retained: { raise: 'RuntimeError' },
  },
];

interface Outcome {
  ok?: true;
  error?: string;
  message?: string;
}

async function lay(item: Case, index: number): Promise<string> {
  const root = join(base, `case-${index}`);
  const dir = join(root, 'state/backfill/findings/triage');
  await mkdir(dir, { recursive: true });
  const target = join(dir, `${FID}.json`);
  const body = item.row ?? row('delivered');
  if (body === 'dir') await mkdir(target);
  else if (body !== 'absent') await writeFile(target, body);
  return root;
}

function toEvents(retained: Retained): (() => Promise<JsonValue[]>) | undefined {
  if (retained === null) return undefined;
  if ('raise' in retained) {
    return () => Promise.reject(new PyError(retained.raise, 'boom'));
  }
  return () =>
    Promise.resolve(
      parseJsonValue(retained.events, { parseConstant: pythonNonFinite }) as JsonValue[],
    );
}

async function runTs(item: Case, root: string): Promise<Outcome> {
  const retained = toEvents(item.retained === undefined ? { events: '[]' } : item.retained);
  const effects = canonicalDelivery({ root, ...(retained === undefined ? {} : { retained }) });
  const job = toPlainJson(
    parseJsonValue(item.job ?? jobText(), { parseConstant: pythonNonFinite }),
    {
      bigints: true,
    },
  ) as Record<string, unknown>;
  try {
    await effects.requireCanonicalDelivery(job);
    return { ok: true };
  } catch (error) {
    if (error instanceof PyError) return { error: error.kind, message: error.message };
    throw error;
  }
}

const runPython = (cases: object[]): Outcome[] =>
  (
    JSON.parse(
      execFileSync('python3', ['-I', ORACLE, APPS], {
        input: JSON.stringify({ cases }),
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: { PATH: process.env.PATH ?? '' },
      }),
    ) as { results: Outcome[] }
  ).results;

describe('canonicalDelivery (written_back form) against Python bounded.require_canonical_delivery', () => {
  it('matches Python on every case', async () => {
    const roots = await Promise.all(CASES.map(lay));
    const python = runPython(
      CASES.map((item, index) => ({
        root: roots[index],
        job_text: item.job ?? jobText(),
        written_back: true,
        retained:
          item.retained === undefined
            ? { events_text: '[]' }
            : item.retained === null
              ? null
              : 'raise' in item.retained
                ? item.retained
                : { events_text: item.retained.events },
      })),
    );
    const seen = new Set<string>();
    for (const [index, item] of CASES.entries()) {
      const ts = await runTs(item, roots[index] as string);
      expect(ts, item.name).toEqual(python[index]);
      seen.add(`${ts.error ?? 'ok'}: ${ts.message ?? ''}`);
    }
    // The cases must reach every refusal the harvest branches on, not only the happy path.
    expect([...seen].sort()).toEqual([
      'RuntimeError: boom',
      'ValueError: canonical delivery state unavailable',
      "ValueError: canonical finding disposition is not this repair task's outcome",
      'ValueError: canonical finding is not delivered to this repair task',
      'ValueError: invalid canonical finding identity',
      'ok: ',
    ]);
  });

  it('a retained failure of a ledger class is unavailable, any other error propagates', async () => {
    const root = await lay({ name: 'x', row: fixedRow }, 901);
    const unavailable = canonicalDelivery({
      root,
      retained: () => Promise.reject(new LedgerIntegrityError('corrupt')),
    });
    await expect(
      unavailable.requireCanonicalDelivery(JSON.parse(jobText()) as Record<string, unknown>),
    ).rejects.toMatchObject({
      kind: 'ValueError',
      message: 'canonical delivery state unavailable',
    });
    const escaping = canonicalDelivery({
      root,
      retained: () => Promise.reject(new RangeError('x')),
    });
    await expect(
      escaping.requireCanonicalDelivery(JSON.parse(jobText()) as Record<string, unknown>),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
