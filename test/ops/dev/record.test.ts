// record.ts unit tests — the dev-record format (deterministic serialize,
// strict parse), the branch-path safety, the fs store round trip, and the
// readiness assembly matrix (the dev.ready / pr.open shared core).
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  assembleReadiness,
  branchPathFault,
  DEV_LEDGER_VERSION,
  devLedgerPath,
  parseDevLedger,
  pathDevLedgerStore,
  serializeDevLedger,
} from '../../../src/ops/dev/record.js';
import type {
  DevCycleRecord,
  DevCheckRecord,
  DevDispositionRecord,
  DevLedgerFile,
  DevReuseRecord,
} from '../../../src/ops/dev/record.js';
import { findReusableCycle } from '../../../src/ops/dev/record.js';
import { BASE, BRANCH, checkRecord, cycleRecord, dispositionRecord, HEAD } from './fakes.js';

/** The affirmative no-fresh blocked reason exactly as decideCompletion records it. */
const NO_FRESH_REASON =
  'reviewer completed \'review_completed\' with an AFFIRMATIVE no-fresh/skipped notice ' +
  '("No fresh detailed file review was performed in this run.") — a fresh detailed review never ran';

/** A reuse record naming the fixture cycle (fakes.ts c001-aaaaaaaa at the fixture identity). */
function reuseRecord(overrides: Partial<DevReuseRecord> = {}): DevReuseRecord {
  const base: DevReuseRecord = {
    kind: 'reuse',
    reuseId: 'r001-aaaaaaaa',
    cycleId: 'c001-aaaaaaaa',
    basis: 'exact-terminal',
    target: 'merge-queue',
    base: BASE,
    head: HEAD,
    dirtySha256: 'dirty',
    scope: 'full',
    reviewer: 'coderabbit',
    logPath: '/tmp/reuse-log',
    at: '2026-10-17T00:30:00.000Z',
  };
  return { ...base, ...overrides } as DevReuseRecord;
}

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------

describe('the dev-record format', () => {
  test('serialize is deterministic: schema key order, 2-space indent, one trailing newline', () => {
    const file: DevLedgerFile = {
      version: DEV_LEDGER_VERSION,
      branch: BRANCH,
      records: [dispositionRecord()],
    };
    const once = serializeDevLedger(file);
    const twice = serializeDevLedger({
      version: DEV_LEDGER_VERSION,
      branch: BRANCH,
      records: [dispositionRecord()],
    });
    expect(once).toBe(twice);
    expect(once.endsWith('\n')).toBe(true);
    expect(once.endsWith('\n\n')).toBe(false);
    expect(JSON.parse(once)).toHaveProperty('version', DEV_LEDGER_VERSION);
  });

  test('serialize refuses duplicate record ids (the store never collapses)', () => {
    const file: DevLedgerFile = {
      version: DEV_LEDGER_VERSION,
      branch: BRANCH,
      records: [cycleRecord(), cycleRecord()],
    };
    expect(() => serializeDevLedger(file)).toThrow(/duplicate record id/);
  });

  test('parse round-trips a serialized file', () => {
    const file: DevLedgerFile = {
      version: DEV_LEDGER_VERSION,
      branch: BRANCH,
      records: [cycleRecord(), checkRecord(), dispositionRecord(), reuseRecord()],
    };
    expect(parseDevLedger(serializeDevLedger(file))).toEqual(file);
  });

  test('a reuse record round-trips with the resolvesCycleId linkage kept verbatim', () => {
    const record = reuseRecord({
      basis: 'no-fresh-tail',
      resolvesCycleId: 'c002-aaaaaaaa',
    });
    const file: DevLedgerFile = {
      version: DEV_LEDGER_VERSION,
      branch: BRANCH,
      records: [record],
    };
    expect(parseDevLedger(serializeDevLedger(file))).toEqual(file);
  });

  test('a reuse record id collides in the ONE shared id space', () => {
    const file: DevLedgerFile = {
      version: DEV_LEDGER_VERSION,
      branch: BRANCH,
      records: [cycleRecord({ cycleId: 'r001-aaaaaaaa' }), reuseRecord()],
    };
    expect(() => serializeDevLedger(file)).toThrow(/duplicate record id 'r001-aaaaaaaa'/);
    expect(() =>
      parseDevLedger(serializeDevLedger({ ...file, records: [reuseRecord(), reuseRecord()] })),
    ).toThrow(/duplicate record id/);
  });

  test('a hand-edited reuse record with an unknown basis or extra key refuses to parse', () => {
    expect(() =>
      parseDevLedger(
        JSON.stringify({
          version: DEV_LEDGER_VERSION,
          branch: BRANCH,
          records: [reuseRecord({ basis: 'something-else' as never })],
        }),
      ),
    ).toThrow(/schema violation/);
    expect(() =>
      parseDevLedger(
        JSON.stringify({
          version: DEV_LEDGER_VERSION,
          branch: BRANCH,
          records: [{ ...reuseRecord(), mystery: true }],
        }),
      ),
    ).toThrow(/schema violation/);
    expect(() =>
      parseDevLedger(
        JSON.stringify({
          version: DEV_LEDGER_VERSION,
          branch: BRANCH,
          records: [
            // exact-terminal with a resolvesCycleId linkage is a contradiction
            { ...reuseRecord(), resolvesCycleId: 'c002-aaaaaaaa' },
          ],
        }),
      ),
    ).toThrow(/schema violation/);
  });

  test('parse fails closed: bad JSON, wrong version, unknown kind', () => {
    expect(() => parseDevLedger('not json')).toThrow(/not valid JSON/);
    // Anything but the ONE accepted version refuses — including a FUTURE
    // version, whatever the constant is at this HEAD.
    expect(() =>
      parseDevLedger(JSON.stringify({ version: DEV_LEDGER_VERSION + 1, branch: 'b', records: [] })),
    ).toThrow(/schema violation/);
    expect(() =>
      parseDevLedger(JSON.stringify({ version: DEV_LEDGER_VERSION - 1, branch: 'b', records: [] })),
    ).toThrow(/schema violation/);
    expect(() =>
      parseDevLedger(
        JSON.stringify({
          version: DEV_LEDGER_VERSION,
          branch: 'b',
          records: [{ kind: 'mystery' }],
        }),
      ),
    ).toThrow(/schema violation/);
    expect(() =>
      parseDevLedger(
        JSON.stringify({
          version: DEV_LEDGER_VERSION,
          branch: 'b',
          records: [cycleRecord(), cycleRecord()],
        }),
      ),
    ).toThrow(/duplicate record id/);
  });

  test('parse rejects a disposition with an empty why', () => {
    const text = JSON.stringify({
      version: DEV_LEDGER_VERSION,
      branch: BRANCH,
      records: [dispositionRecord({ why: '  ' })],
    });
    expect(() => parseDevLedger(text)).toThrow(/schema violation/);
  });
});

// ---------------------------------------------------------------------------
// Branch-path safety
// ---------------------------------------------------------------------------

describe('branchPathFault', () => {
  test('a normal namespaced branch is safe and joins under .cq/dev/', () => {
    expect(branchPathFault('phase1/dev-commands')).toBeNull();
    // prefix of the flattened branch + '-' + 16-hex sha256 suffix, bounded.
    const encodedFirst = devLedgerPath('/repo', 'phase1/dev-commands').split('/').at(-1) ?? '';
    expect(encodedFirst).toMatch(/^phase1-dev-commands-[0-9a-f]{16}\.json$/);
    // Collision-free AND bounded: the full branch hashes into the name, so
    // distinct branches stay distinct (`a%2Fb` vs `a/b` hash apart), and a
    // git-maximal hierarchical ref stays under the 255-byte name limit.
    const fooPath = devLedgerPath('/repo', 'foo');
    const fooBarPath = devLedgerPath('/repo', 'foo.json/bar');
    expect(fooPath).not.toBe(fooBarPath);
    expect(fooPath.endsWith('.json')).toBe(true);
    const longBranch = Array.from({ length: 40 }, (_, i) => `segment${String(i)}`).join('/');
    const longPath = devLedgerPath('/repo', longBranch);
    const encoded = longPath.split('/').at(-1) ?? '';
    expect(encoded.length).toBeLessThanOrEqual(255);
    // Same branch → same path (stable); different → different.
    expect(devLedgerPath('/repo', longBranch)).toBe(longPath);
  });

  test('refusals: empty, absolute, .., leading dot, .lock suffix, spaces, backslash', () => {
    for (const branch of ['', '/abs', 'a/../b', '.hidden', 'x.lock', 'a b', 'a\\b']) {
      expect(branchPathFault(branch), branch).not.toBeNull();
    }
  });

  test('devLedgerPath throws on an unsafe branch (defense in depth)', () => {
    expect(() => devLedgerPath('/repo', '../escape')).toThrow(/path-safe refname/);
  });
});

// ---------------------------------------------------------------------------
// The fs store
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Readiness assembly
// ---------------------------------------------------------------------------

function assemble(
  ledgerRecords: (DevCycleRecord | DevCheckRecord | DevDispositionRecord | DevReuseRecord)[],
  untracked: string[] = [],
) {
  return assembleReadiness({
    branch: BRANCH,
    target: 'merge-queue',
    identity: { base: BASE, head: HEAD, dirtySha256: 'dirty' },
    ledger: { version: DEV_LEDGER_VERSION, branch: BRANCH, records: ledgerRecords },
    untracked,
    nowIso: '2026-10-17T01:00:00.000Z',
  });
}

describe('assembleReadiness', () => {
  test('ready: ONE terminal full-scope cycle (D-J) + green check at the current identity', () => {
    const result = assemble([cycleRecord(), checkRecord()]);
    expect(result.ready).toBe(true);
    if (result.ready) {
      expect(result.record).toMatchObject({
        ready: true,
        evidenceClass: 'author',
        branch: BRANCH,
        cycleId: 'c001-aaaaaaaa',
        checkId: 'k001-aaaaaaaa',
        base: BASE,
        head: HEAD,
        dirtySha256: 'dirty',
      });
      expect(result.record.caveat).toContain('not verification');
      expect(result.record.caveat).toContain('candidate SHA');
    }
  });

  test('the anchor is the LATEST terminal full-scope cycle: an older match never rescues it', () => {
    const result = assemble([
      cycleRecord(),
      cycleRecord({ cycleId: 'c002-bbbbbbbb', head: 'newer-head' }),
      checkRecord(),
    ]);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.gaps.map((gap) => gap.field)).toEqual(['stale-review-identity']);
      expect(result.gaps[0]?.detail).toContain('c002-bbbbbbbb');
    }
  });

  test('no records: both gaps named', () => {
    const result = assemble([]);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      const fields = result.gaps.map((gap) => gap.field);
      expect(fields).toContain('terminal-review-cycle');
      expect(fields).toContain('green-check');
    }
  });

  test('an uncommitted-scope terminal cycle never satisfies readiness', () => {
    const result = assemble([cycleRecord({ scope: 'uncommitted' }), checkRecord()]);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      const gap = result.gaps.find((entry) => entry.field === 'terminal-review-cycle');
      expect(gap?.detail).toContain('uncommitted-scope');
    }
  });

  test('a blocked cycle never counts as the terminal cycle', () => {
    const result = assemble([
      cycleRecord({ completion: { kind: 'blocked', reason: 'cli exit 1' } }),
      checkRecord(),
    ]);
    expect(result.ready).toBe(false);
    if (!result.ready) expect(result.gaps.map((g) => g.field)).toContain('terminal-review-cycle');
  });

  test('a stale cycle identity is named field by field', () => {
    const result = assemble([
      cycleRecord({ head: 'older', dirtySha256: 'older-dirty' }),
      checkRecord(),
    ]);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      const stale = result.gaps.find((gap) => gap.field === 'stale-review-identity');
      expect(stale?.detail).toContain('head');
      expect(stale?.detail).toContain('working-tree diff changed');
    }
  });

  test('a blocking finding is open until fixed/rejected; deferred does NOT close it', () => {
    const cycle = cycleRecord({
      findings: [
        { id: 'c001-aaaaaaaa#f1', severity: 'critical' },
        { id: 'c001-aaaaaaaa#f2', severity: 'major', fileName: 'a.ts' },
        { id: 'c001-aaaaaaaa#f3', severity: 'minor' },
      ],
    });
    // Deferred f1, nothing for f2, fixed f3: f1 and f2 stay open.
    const result = assemble([
      cycle,
      checkRecord(),
      dispositionRecord({ findingId: 'c001-aaaaaaaa#f1', action: 'deferred' }),
      dispositionRecord({ findingId: 'c001-aaaaaaaa#f3', action: 'fixed' }),
    ]);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      const open = result.gaps.find((gap) => gap.field === 'open-blocking-findings');
      expect(open?.detail).toContain('#f1');
      expect(open?.detail).toContain('#f2');
      expect(open?.detail).not.toContain('#f3');
    }
  });

  test('fixed and rejected dispositions close blocking findings; minor never blocks', () => {
    const cycle = cycleRecord({
      findings: [
        { id: 'c001-aaaaaaaa#f1', severity: 'critical' },
        { id: 'c001-aaaaaaaa#f2', severity: 'major' },
        { id: 'c001-aaaaaaaa#f3', severity: 'trivial' },
      ],
    });
    const result = assemble([
      cycleRecord({ cycleId: 'c000-aaaaaaaa' }),
      cycle,
      checkRecord(),
      dispositionRecord({ findingId: 'c001-aaaaaaaa#f1', action: 'fixed' }),
      dispositionRecord({
        findingId: 'c001-aaaaaaaa#f2',
        action: 'rejected',
        why: 'false positive: mechanism cited',
      }),
    ]);
    expect(result.ready).toBe(true);
  });

  test('a red check is no check; a stale check identity is a gap', () => {
    const redOnly = assemble([cycleRecord(), checkRecord({ passed: false })]);
    expect(redOnly.ready).toBe(false);
    const stale = assemble([cycleRecord(), checkRecord({ base: 'older-base' })]);
    expect(stale.ready).toBe(false);
    if (!stale.ready) expect(stale.gaps.map((g) => g.field)).toContain('stale-check-identity');
  });

  test('a green check followed by a RED check at the same identity is NOT ready', () => {
    const result = assemble([
      cycleRecord(),
      checkRecord(),
      checkRecord({ checkId: 'k002-aaaaaaaa', passed: false }),
    ]);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      const gap = result.gaps.find((entry) => entry.field === 'red-check');
      expect(gap?.detail).toContain('k002-aaaaaaaa');
      expect(gap?.detail).toContain('RED');
    }
  });

  test("an uncommitted-scope cycle's blocking finding also requires a disposition", () => {
    const uncommitted = cycleRecord({
      scope: 'uncommitted',
      findings: [{ id: 'c001-aaaaaaaa#f1', severity: 'critical' }],
    });
    const result = assemble([uncommitted, cycleRecord(), checkRecord()]);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      const gap = result.gaps.find((entry) => entry.field === 'open-blocking-findings');
      expect(gap?.detail).toContain('c001-aaaaaaaa#f1');
    }
    const closed = assemble([
      uncommitted,
      cycleRecord({ cycleId: 'c000-aaaaaaaa' }),
      cycleRecord(),
      checkRecord(),
      dispositionRecord({ findingId: 'c001-aaaaaaaa#f1', action: 'fixed' }),
    ]);
    expect(closed.ready).toBe(true);
  });

  test('a later BLOCKED attempt invalidates readiness over an older terminal cycle', () => {
    const result = assemble([
      cycleRecord(),
      cycleRecord({
        cycleId: 'c002-aaaaaaaa',
        completion: { kind: 'blocked', reason: 'cli exit 1' },
      }),
      checkRecord(),
    ]);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      const gap = result.gaps.find((entry) => entry.field === 'latest-review-blocked');
      expect(gap?.detail).toContain('c002-aaaaaaaa');
      expect(gap?.detail).toContain('cli exit 1');
    }
  });

  test("an older cycle's open blocking finding stays open despite a clean newer cycle", () => {
    const older = cycleRecord({
      cycleId: 'c001-aaaaaaaa',
      findings: [{ id: 'c001-aaaaaaaa#f1', severity: 'major', fileName: 'a.ts' }],
    });
    const newer = cycleRecord({
      cycleId: 'c002-aaaaaaaa',
      findings: [], // the newer cycle reports nothing — it does not adjudicate the past
    });
    const result = assemble([older, newer, checkRecord()]);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      const gap = result.gaps.find((entry) => entry.field === 'open-blocking-findings');
      expect(gap?.detail).toContain('c001-aaaaaaaa#f1');
      expect(gap?.detail).toContain('earlier cycle');
    }
    // Recording the disposition closes it.
    const closed = assemble([
      older,
      newer,
      checkRecord(),
      dispositionRecord({ findingId: 'c001-aaaaaaaa#f1', action: 'fixed' }),
    ]);
    expect(closed.ready).toBe(true);
  });

  test('findings from a reviewer removed from cq.json still require disposition', () => {
    const removedReviewer = cycleRecord({
      cycleId: 'c000-aaaaaaaa',
      reviewer: 'agent:reviewer',
      findings: [{ id: 'c000-aaaaaaaa#f1', severity: 'critical' }],
    });
    const currentReviewer = cycleRecord({ findings: [] });
    const result = assembleReadiness({
      branch: BRANCH,
      target: 'merge-queue',
      identity: { base: BASE, head: HEAD, dirtySha256: 'dirty' },
      ledger: {
        version: DEV_LEDGER_VERSION,
        branch: BRANCH,
        records: [removedReviewer, currentReviewer, checkRecord()],
      },
      untracked: [],
      configuredReviewers: ['coderabbit'],
      nowIso: '2026-10-17T01:00:00.000Z',
    });
    expect(result.ready).toBe(false);
    if (!result.ready) {
      const gap = result.gaps.find((entry) => entry.field === 'open-blocking-findings');
      expect(gap?.detail).toContain('c000-aaaaaaaa#f1');
    }
  });

  test('untracked files are a gap with the names listed', () => {
    const result = assemble([cycleRecord(), checkRecord()], ['scratch/new.ts']);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      const gap = result.gaps.find((entry) => entry.field === 'untracked-files');
      expect(gap?.detail).toContain('scratch/new.ts');
    }
  });
});

test('a blocked attempt keeps its major findings open after a later terminal cycle', () => {
  const blocked = cycleRecord({
    cycleId: 'c000-aaaaaaaa',
    completion: { kind: 'blocked', reason: 'CLI error' },
    findings: [{ id: 'c000-aaaaaaaa#f1', severity: 'major' }],
  });
  const records = [blocked, cycleRecord(), checkRecord()];
  const open = assemble(records);
  expect(open.ready).toBe(false);
  if (!open.ready)
    expect(
      open.gaps.some(
        (gap) => gap.field === 'open-blocking-findings' && gap.detail.includes('c000-aaaaaaaa#f1'),
      ),
    ).toBe(true);
  expect(assemble([...records, dispositionRecord({ findingId: 'c000-aaaaaaaa#f1' })]).ready).toBe(
    true,
  );
});

// ---------------------------------------------------------------------------
// Q4 (#485): the reuse selector and the readiness resolution
// ---------------------------------------------------------------------------

const REQUEST = {
  target: 'merge-queue',
  base: BASE,
  head: HEAD,
  dirtySha256: 'dirty',
  scope: 'full' as const,
  reviewer: 'coderabbit',
};

describe('findReusableCycle', () => {
  test('selects the exact terminal cycle at the identical identity', () => {
    const selection = findReusableCycle([cycleRecord()], REQUEST);
    expect(selection).not.toBeNull();
    expect(selection).toMatchObject({ basis: 'exact-terminal', cycleId: 'c001-aaaaaaaa' });
  });

  test('no terminal cycle: null (dispatch a fresh cycle)', () => {
    expect(
      findReusableCycle([cycleRecord({ completion: { kind: 'blocked', reason: 'cli exit 1' } })], REQUEST),
    ).toBeNull();
    expect(findReusableCycle([], REQUEST)).toBeNull();
  });

  test('dirty scope mismatch never reuses', () => {
    expect(findReusableCycle([cycleRecord()], { ...REQUEST, dirtySha256: 'other-dirty' })).toBeNull();
  });

  test('changed target at the same merge-base never reuses', () => {
    expect(findReusableCycle([cycleRecord()], { ...REQUEST, target: 'main' })).toBeNull();
  });

  test('changed head or base never reuses', () => {
    expect(findReusableCycle([cycleRecord()], { ...REQUEST, head: 'd'.repeat(40) })).toBeNull();
    expect(findReusableCycle([cycleRecord()], { ...REQUEST, base: 'e'.repeat(40) })).toBeNull();
  });

  test('a different reviewer or scope never reuses', () => {
    expect(findReusableCycle([cycleRecord()], { ...REQUEST, reviewer: 'agent:reviewer' })).toBeNull();
    expect(findReusableCycle([cycleRecord()], { ...REQUEST, scope: 'uncommitted' })).toBeNull();
  });

  test('an uncommitted-scope terminal cycle is never a reuse anchor', () => {
    expect(
      findReusableCycle([cycleRecord({ scope: 'uncommitted' })], {
        ...REQUEST,
        scope: 'uncommitted',
      }),
    ).toBeNull();
  });

  test('the LATEST same-identity no-fresh tail yields the resolution with its id', () => {
    const selection = findReusableCycle(
      [
        cycleRecord(),
        cycleRecord({
          cycleId: 'c002-aaaaaaaa',
          completion: { kind: 'blocked', reason: NO_FRESH_REASON },
        }),
      ],
      REQUEST,
    );
    expect(selection).not.toBeNull();
    expect(selection).toMatchObject({
      basis: 'no-fresh-tail',
      cycleId: 'c001-aaaaaaaa',
      resolvesCycleId: 'c002-aaaaaaaa',
    });
  });

  test('a genuine later blocker (error/auth/kill) refuses reuse even with an earlier terminal', () => {
    for (const reason of [
      'reviewer stream carried an error event',
      'reviewer requested action (usage-limit confirmation class) — the cycle never reviewed',
      'the reviewer CLI timed out after 1500000ms and was stopped — no review completed',
      'reviewer stream was MALFORMED — 1 line(s) were unparsable or of an unrecognized event type',
    ]) {
      const selection = findReusableCycle(
        [
          cycleRecord(),
          cycleRecord({
            cycleId: 'c002-aaaaaaaa',
            completion: { kind: 'blocked', reason },
          }),
        ],
        REQUEST,
      );
      expect(selection, reason).toBeNull();
    }
  });

  test('a no-fresh-shaped reason that deviates from the recorded verdict wording refuses', () => {
    expect(
      findReusableCycle(
        [
          cycleRecord(),
          cycleRecord({
            cycleId: 'c002-aaaaaaaa',
            completion: { kind: 'blocked', reason: 'no fresh review' },
          }),
        ],
        REQUEST,
      ),
    ).toBeNull();
  });

  test('a terminal cycle NEWER than the selected one is never papered over', () => {
    expect(
      findReusableCycle(
        [
          cycleRecord(),
          cycleRecord({ cycleId: 'c002-aaaaaaaa', head: 'newer-head' }),
        ],
        REQUEST,
      ),
    ).toBeNull();
  });

  test('an earlier no-fresh tail that a newer same-identity terminal supersedes selects exact-terminal', () => {
    const selection = findReusableCycle(
      [
        cycleRecord(),
        cycleRecord({
          cycleId: 'c002-aaaaaaaa',
          completion: { kind: 'blocked', reason: NO_FRESH_REASON },
        }),
        cycleRecord({ cycleId: 'c003-aaaaaaaa' }),
      ],
      REQUEST,
    );
    expect(selection).toMatchObject({ basis: 'exact-terminal', cycleId: 'c003-aaaaaaaa' });
  });
});

describe('assembleReadiness reuse resolution (no-fresh tail)', () => {
  const blockedTail = () =>
    cycleRecord({
      cycleId: 'c002-aaaaaaaa',
      completion: { kind: 'blocked', reason: NO_FRESH_REASON },
    });

  test('a blocked tail with a resolution record settles ready and names the reuse', () => {
    const result = assemble([
      cycleRecord(),
      blockedTail(),
      reuseRecord({ basis: 'no-fresh-tail', resolvesCycleId: 'c002-aaaaaaaa' }),
      checkRecord(),
    ]);
    expect(result.ready).toBe(true);
    if (result.ready) expect(result.record.reuse).toBe('r001-aaaaaaaa');
  });

  test('the same tail WITHOUT the resolution record stays a latest-review-blocked gap', () => {
    const result = assemble([cycleRecord(), blockedTail(), checkRecord()]);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      const gap = result.gaps.find((entry) => entry.field === 'latest-review-blocked');
      expect(gap?.detail).toContain('c002-aaaaaaaa');
      expect(gap?.detail).toContain('AFFIRMATIVE no-fresh');
    }
  });

  test('a resolution record that names the WRONG tail or wrong anchor never resolves', () => {
    for (const mismatched of [
      reuseRecord({ basis: 'no-fresh-tail', resolvesCycleId: 'c009-aaaaaaaa' }),
      reuseRecord({ basis: 'no-fresh-tail', resolvesCycleId: 'c002-aaaaaaaa', cycleId: 'c009-aaaaaaaa' }),
    ]) {
      const result = assemble([cycleRecord(), blockedTail(), mismatched, checkRecord()]);
      expect(result.ready).toBe(false);
      if (!result.ready)
        expect(result.gaps.some((gap) => gap.field === 'latest-review-blocked')).toBe(true);
    }
  });

  test('a tail at a DIFFERENT identity (stale drift) is a real blocker, never resolved', () => {
    const staleTail = cycleRecord({
      cycleId: 'c002-aaaaaaaa',
      completion: { kind: 'blocked', reason: NO_FRESH_REASON },
      dirtySha256: 'older-dirty',
    });
    const result = assemble([
      cycleRecord(),
      staleTail,
      reuseRecord({ basis: 'no-fresh-tail', resolvesCycleId: 'c002-aaaaaaaa' }),
      checkRecord(),
    ]);
    expect(result.ready).toBe(false);
    if (!result.ready)
      expect(result.gaps.some((gap) => gap.field === 'latest-review-blocked')).toBe(true);
  });

  test('a NON-no-fresh blocked tail is a real gap even with a resolution record present', () => {
    const result = assemble([
      cycleRecord(),
      cycleRecord({
        cycleId: 'c002-aaaaaaaa',
        completion: { kind: 'blocked', reason: 'reviewer stream carried an error event' },
      }),
      reuseRecord({ basis: 'no-fresh-tail', resolvesCycleId: 'c002-aaaaaaaa' }),
      checkRecord(),
    ]);
    expect(result.ready).toBe(false);
    if (!result.ready)
      expect(result.gaps.some((gap) => gap.field === 'latest-review-blocked')).toBe(true);
  });

  test('a no-fresh tail from an UNCONFIGURED reviewer is not resolved', () => {
    const agentTail = cycleRecord({
      cycleId: 'c002-aaaaaaaa',
      reviewer: 'agent:unreviewer',
      completion: { kind: 'blocked', reason: NO_FRESH_REASON },
    });
    const result = assembleReadiness({
      branch: BRANCH,
      target: 'merge-queue',
      identity: { base: BASE, head: HEAD, dirtySha256: 'dirty' },
      ledger: {
        version: DEV_LEDGER_VERSION,
        branch: BRANCH,
        records: [
          cycleRecord(),
          agentTail,
          reuseRecord({ basis: 'no-fresh-tail', resolvesCycleId: 'c002-aaaaaaaa' }),
          checkRecord(),
        ],
      },
      untracked: [],
      configuredReviewers: ['coderabbit'],
      nowIso: '2026-10-17T01:00:00.000Z',
    });
    expect(result.ready).toBe(false);
    if (!result.ready)
      expect(result.gaps.some((gap) => gap.field === 'latest-review-blocked')).toBe(true);
  });

  test('blocking findings on the tail still block readiness through the resolution', () => {
    const result = assemble([
      cycleRecord(),
      blockedTail(),
      reuseRecord({ basis: 'no-fresh-tail', resolvesCycleId: 'c002-aaaaaaaa' }),
      checkRecord(),
      cycleRecord({
        cycleId: 'c000-aaaaaaaa',
        findings: [{ id: 'c000-aaaaaaaa#f1', severity: 'critical' }],
      }),
    ]);
    expect(result.ready).toBe(false);
    if (!result.ready)
      expect(
        result.gaps.some(
          (gap) => gap.field === 'open-blocking-findings' && gap.detail.includes('c000-aaaaaaaa#f1'),
        ),
      ).toBe(true);
  });

  test('reuse evidence rides the ready record verbatim: the caveat stays authoritative', () => {
    const result = assemble([
      cycleRecord(),
      blockedTail(),
      reuseRecord({ basis: 'no-fresh-tail', resolvesCycleId: 'c002-aaaaaaaa' }),
      checkRecord(),
    ]);
    expect(result.ready).toBe(true);
    if (result.ready) {
      expect(result.record.evidenceClass).toBe('author');
      expect(result.record.caveat).toContain('not verification');
      expect(result.record.cycleId).toBe('c001-aaaaaaaa');
    }
  });
});
