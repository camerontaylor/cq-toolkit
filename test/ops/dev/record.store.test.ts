// record.ts unit tests — the fs-backed dev ledger store: missing/corrupt files,
// save/load round trips, the mutate mutex, and the branch-ownership check.
// Split provenance: test/ops/dev/record.test.ts was split into record.format.test.ts,
// record.finding-schema.test.ts, record.branch-path.test.ts, record.store.test.ts,
// record.readiness.test.ts, record.reuse-selector.test.ts and
// record.readiness-reuse.test.ts.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  DEV_LEDGER_VERSION,
  devLedgerPath,
  pathDevLedgerStore,
  serializeDevLedger,
} from '../../../src/ops/dev/record.js';
import type { DevLedgerFile } from '../../../src/ops/dev/record.js';
import { BRANCH, checkRecord, dispositionRecord } from './fakes.js';

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('pathDevLedgerStore', () => {
  test('a missing ledger loads empty; save → load round-trips; mutate appends under the mutex', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cq-dev-record-'));
    tmpDirs.push(root);
    const store = pathDevLedgerStore(root, BRANCH);
    expect(store.load()).toEqual({ version: DEV_LEDGER_VERSION, branch: BRANCH, records: [] });
    store.save({
      version: DEV_LEDGER_VERSION,
      branch: BRANCH,
      records: [checkRecord()],
    });
    expect(store.load().records).toHaveLength(1);
    const value = await store.mutate((ledger) => ({
      ledger: { ...ledger, records: [...ledger.records, dispositionRecord()] },
      value: 'done',
    }));
    expect(value).toBe('done');
    expect(store.load().records).toHaveLength(2);
    // The persisted bytes parse back exactly.
    const onDisk = JSON.parse(await readFile(devLedgerPath(root, BRANCH), 'utf8')) as DevLedgerFile;
    expect(onDisk.records).toHaveLength(2);
  });

  test('an unsafe branch refuses the store outright', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cq-dev-record-'));
    tmpDirs.push(root);
    expect(() => pathDevLedgerStore(root, '../escape')).toThrow(/path-safe refname/);
  });

  test('a corrupt ledger file faults on load (never silently emptied)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cq-dev-record-'));
    tmpDirs.push(root);
    const path = devLedgerPath(root, BRANCH);
    await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    await writeFile(path, 'not json', 'utf8');
    expect(() => pathDevLedgerStore(root, BRANCH).load()).toThrow(/not valid JSON/);
  });

  test("a ledger recording ANOTHER branch refuses to load (never another branch's evidence)", async () => {
    const root = await mkdtemp(join(tmpdir(), 'cq-dev-record-'));
    tmpDirs.push(root);
    const path = devLedgerPath(root, BRANCH);
    await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    await writeFile(
      path,
      serializeDevLedger({ version: DEV_LEDGER_VERSION, branch: 'other/branch', records: [] }),
      'utf8',
    );
    expect(() => pathDevLedgerStore(root, BRANCH).load()).toThrow(
      /belongs to branch 'other\/branch'/,
    );
  });
});
