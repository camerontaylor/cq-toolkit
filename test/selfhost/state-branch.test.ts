// W1.2 slice A — tests for the durable settle-ledger store
// (src/selfhost/state-branch.ts, the RS-3 decision).
//
// The forge is an IN-MEMORY FAKE implementing just the git-data argv the
// store issues (refs, commits {tree, parents}, trees {path → content}),
// answering like gh: `{code, stdout, stderr}` with 404 as code 1 +
// 'gh: Not Found (HTTP 404)' and 422 as code 1 + 'HTTP 422'. Its PATCH
// enforces fast-forward (the current tip must be an ancestor of the new
// commit) unless force — the compare-and-swap the store relies on.
//
// Pinned here:
//   1. Absent branch → empty ledger, parentCommit null.
//   2. Bootstrap write creates a ROOT commit and the ref; the next write
//      fast-forwards with the previous tip as parent.
//   3. CAS: a writer whose parent is stale (another writer moved the tip)
//      gets ok:false and the tip is unchanged.
//   4. The file read is PINNED to the tip commit read first.
//   5. Malformed file → empty + discarded; a non-404 read failure throws;
//      an invalid owner/repo throws before any gh call.
//   6. The round-trip survives a simulated Actions-cache eviction: the
//      local journal dir is deleted, a fresh store instance reads the SAME
//      ledger back from the forge, settle still holds, and the store never
//      touches the filesystem.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { GhError } from '../../src/ops/review/gh.js';
import type { GhFn, GhResult } from '../../src/ops/review/gh.js';
import {
  emptySettleState,
  observe,
  settleStatus,
  type SettleTuple,
} from '../../src/selfhost/settle-state.js';
import {
  SETTLE_STATE_PATH,
  STATE_BRANCH,
  readSettleState,
  writeSettleState,
} from '../../src/selfhost/state-branch.js';

const OWNER = 'octo';
const REPO = 'widget';
const FULL = `${OWNER}/${REPO}`;
const PREFIX = `repos/${OWNER}/${REPO}/`;
const REF = `refs/heads/${STATE_BRANCH}`;
const T0 = Date.parse('2026-09-25T00:00:00.000Z');
const SETTLE_MS = 30 * 60_000;
const TUPLE: SettleTuple = { head: 'a'.repeat(40), base: 'b'.repeat(40), forcePushEpoch: 0 };

// ---------------------------------------------------------------------------
// The in-memory fake forge
// ---------------------------------------------------------------------------

const ok = (body: unknown): GhResult => ({ code: 0, stdout: JSON.stringify(body), stderr: '' });
const notFound = (): GhResult => ({ code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' });
const unprocessable = (msg: string): GhResult => ({
  code: 1,
  stdout: '',
  stderr: `gh: ${msg} (HTTP 422)`,
});
const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex');

/** The forge's durable storage — survives across store "instances". */
interface ForgeStore {
  refs: Map<string, string>;
  commits: Map<string, { tree: string; parents: string[]; message: string }>;
  trees: Map<string, Map<string, string>>;
}

const newStore = (): ForgeStore => ({ refs: new Map(), commits: new Map(), trees: new Map() });

/** Parsed gh argv: method, path, and the -f/-F fields in order. */
const parseArgv = (args: string[]) => {
  let method = 'GET';
  let path = '';
  const fields: [string, string][] = [];
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (arg === '-X') {
      method = args[(i += 1)] ?? '';
    } else if (arg === '-f' || arg === '-F') {
      const kv = args[(i += 1)] ?? '';
      const eq = kv.indexOf('=');
      fields.push([kv.slice(0, eq), kv.slice(eq + 1)]);
    } else {
      path = arg;
    }
  }
  const field = (name: string) => fields.find(([k]) => k === name)?.[1];
  const all = (name: string) => fields.filter(([k]) => k === name).map(([, v]) => v);
  return { method, path, field, all };
};

/** True iff `ancestor` is reachable from `commit` via parents. */
const reaches = (store: ForgeStore, commit: string, ancestor: string): boolean => {
  const queue = [commit];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const c = queue.shift() ?? '';
    if (c === ancestor) return true;
    if (seen.has(c)) continue;
    seen.add(c);
    queue.push(...(store.commits.get(c)?.parents ?? []));
  }
  return false;
};

/**
 * A GhFn over `store`. `hook` runs before routing and may answer instead
 * (fault injection / mid-read races); every argv is recorded in `calls`.
 */
const makeForge = (store: ForgeStore, hook?: (args: string[]) => GhResult | undefined) => {
  const calls: string[][] = [];
  let counter = 0;
  const gh: GhFn = (args) => {
    calls.push(args);
    const hooked = hook?.(args);
    if (hooked !== undefined) return Promise.resolve(hooked);
    return Promise.resolve(route(args));
  };
  const route = (args: string[]): GhResult => {
    const { method, path, field, all } = parseArgv(args);
    if (args[0] !== 'api' || !path.startsWith(PREFIX)) return notFound();
    const rest = path.slice(PREFIX.length);
    if (method === 'GET' && rest.startsWith('git/ref/heads/')) {
      const sha = store.refs.get(`refs/heads/${rest.slice('git/ref/heads/'.length)}`);
      return sha === undefined ? notFound() : ok({ ref: REF, object: { sha, type: 'commit' } });
    }
    if (method === 'GET' && rest.startsWith('contents/')) {
      const [filePath = '', query = ''] = rest.slice('contents/'.length).split('?');
      const ref = new URLSearchParams(query).get('ref') ?? '';
      const commit = store.commits.get(ref);
      const content =
        commit === undefined ? undefined : store.trees.get(commit.tree)?.get(filePath);
      if (content === undefined) return notFound();
      // GitHub wraps base64 at 60 columns with newlines.
      const b64 = Buffer.from(content, 'utf8').toString('base64');
      return ok({
        type: 'file',
        encoding: 'base64',
        content: `${b64.replace(/(.{60})/g, '$1\n')}\n`,
      });
    }
    if (method === 'POST' && rest === 'git/trees') {
      const p = field('tree[][path]');
      const content = field('tree[][content]');
      if (p === undefined || content === undefined || field('tree[][mode]') !== '100644') {
        return unprocessable('Invalid tree');
      }
      const sha = sha1(`tree\0${p}\0${content}`);
      store.trees.set(sha, new Map([[p, content]]));
      return ok({ sha });
    }
    if (method === 'POST' && rest === 'git/commits') {
      const tree = field('tree') ?? '';
      const parents = all('parents[]');
      if (!store.trees.has(tree) || parents.some((p) => !store.commits.has(p))) {
        return unprocessable('Invalid commit');
      }
      counter += 1;
      const sha = sha1(
        `commit\0${tree}\0${parents.join(',')}\0${String(counter)}\0${String(Math.random())}`,
      );
      store.commits.set(sha, { tree, parents, message: field('message') ?? '' });
      return ok({ sha });
    }
    if (method === 'POST' && rest === 'git/refs') {
      const ref = field('ref') ?? '';
      const sha = field('sha') ?? '';
      if (store.refs.has(ref)) return unprocessable('Reference already exists');
      if (!store.commits.has(sha)) return unprocessable('Object does not exist');
      store.refs.set(ref, sha);
      return ok({ ref, object: { sha } });
    }
    if (method === 'PATCH' && rest.startsWith('git/refs/heads/')) {
      const ref = `refs/heads/${rest.slice('git/refs/heads/'.length)}`;
      const current = store.refs.get(ref);
      const sha = field('sha') ?? '';
      if (current === undefined) return unprocessable('Reference does not exist');
      if (!store.commits.has(sha)) return unprocessable('Object does not exist');
      if (field('force') !== 'true' && !reaches(store, sha, current)) {
        return unprocessable('Update is not a fast forward');
      }
      store.refs.set(ref, sha);
      return ok({ ref, object: { sha } });
    }
    return notFound();
  };
  return { gh, calls };
};

const deps = (gh: GhFn) => ({ gh, owner: OWNER, repo: REPO });

// ---------------------------------------------------------------------------

describe('readSettleState', () => {
  test('absent branch → empty ledger, parentCommit null', async () => {
    const { gh } = makeForge(newStore());
    expect(await readSettleState(deps(gh))).toEqual({
      state: emptySettleState(FULL),
      parentCommit: null,
      discarded: [],
    });
  });

  test('branch present but file missing → empty ledger at that tip', async () => {
    const store = newStore();
    store.trees.set('t'.repeat(40), new Map());
    store.commits.set('c'.repeat(40), { tree: 't'.repeat(40), parents: [], message: '' });
    store.refs.set(REF, 'c'.repeat(40));
    const { gh } = makeForge(store);
    expect(await readSettleState(deps(gh))).toEqual({
      state: emptySettleState(FULL),
      parentCommit: 'c'.repeat(40),
      discarded: [],
    });
  });

  test('the file read is pinned to the tip commit read first', async () => {
    const store = newStore();
    const { gh: writer } = makeForge(store);
    const first = observe(emptySettleState(FULL), 7, TUPLE, T0, 'self-merge-prs:observe');
    const w1 = await writeSettleState(deps(writer), { state: first, parentCommit: null }, 'one');
    if (!w1.ok) throw new Error(w1.reason);
    // Between the ref read and the contents read, another writer lands.
    let raced = false;
    const { gh, calls } = makeForge(store, (args) => {
      if (!raced && (args[1] ?? '').includes('/contents/')) {
        raced = true;
        // Synchronous so the move lands before the contents read routes.
        store.trees.set('e'.repeat(40), new Map([[SETTLE_STATE_PATH, '{}']]));
        store.commits.set('d'.repeat(40), {
          tree: 'e'.repeat(40),
          parents: [w1.commit],
          message: '',
        });
        store.refs.set(REF, 'd'.repeat(40));
      }
      return undefined;
    });
    const snap = await readSettleState(deps(gh));
    expect(raced).toBe(true);
    expect(store.refs.get(REF)).not.toBe(w1.commit);
    expect(snap.parentCommit).toBe(w1.commit);
    expect(snap.state).toEqual(first);
    expect(calls[1]).toEqual(['api', `${PREFIX}contents/${SETTLE_STATE_PATH}?ref=${w1.commit}`]);
  });

  test('malformed file → empty ledger plus a discarded reason', async () => {
    const store = newStore();
    store.trees.set('t'.repeat(40), new Map([[SETTLE_STATE_PATH, '{not json']]));
    store.commits.set('c'.repeat(40), { tree: 't'.repeat(40), parents: [], message: '' });
    store.refs.set(REF, 'c'.repeat(40));
    const { gh } = makeForge(store);
    const snap = await readSettleState(deps(gh));
    expect(snap.state).toEqual(emptySettleState(FULL));
    expect(snap.parentCommit).toBe('c'.repeat(40));
    expect(snap.discarded).toHaveLength(1);
  });

  test('a foreign-repo ledger is discarded', async () => {
    const store = newStore();
    const text = JSON.stringify({ version: 1, repo: 'evil/fork', prs: {} });
    store.trees.set('t'.repeat(40), new Map([[SETTLE_STATE_PATH, text]]));
    store.commits.set('c'.repeat(40), { tree: 't'.repeat(40), parents: [], message: '' });
    store.refs.set(REF, 'c'.repeat(40));
    const { gh } = makeForge(store);
    const snap = await readSettleState(deps(gh));
    expect(snap.state).toEqual(emptySettleState(FULL));
    expect(snap.discarded[0]).toMatch(/repo/);
  });

  test('a non-404 read failure throws (ref read and contents read)', async () => {
    const boom: GhResult = { code: 1, stdout: '', stderr: 'gh: Server Error (HTTP 502)' };
    const { gh } = makeForge(newStore(), () => boom);
    await expect(readSettleState(deps(gh))).rejects.toBeInstanceOf(GhError);

    const store = newStore();
    const { gh: writer } = makeForge(store);
    await writeSettleState(
      deps(writer),
      { state: emptySettleState(FULL), parentCommit: null },
      'x',
    );
    const { gh: flaky } = makeForge(store, (args) =>
      (args[1] ?? '').includes('/contents/') ? boom : undefined,
    );
    await expect(readSettleState(deps(flaky))).rejects.toBeInstanceOf(GhError);
  });

  test('an invalid owner/repo throws before any gh call', async () => {
    const { gh, calls } = makeForge(newStore());
    await expect(readSettleState({ gh, owner: '..', repo: REPO })).rejects.toThrow(/charset/);
    await expect(
      writeSettleState(
        { gh, owner: OWNER, repo: 'a/b' },
        { state: emptySettleState(FULL), parentCommit: null },
        'x',
      ),
    ).rejects.toThrow(/charset/);
    expect(calls).toHaveLength(0);
  });
});

describe('writeSettleState', () => {
  test('bootstrap creates a root commit; the next write fast-forwards with a parent', async () => {
    const store = newStore();
    const { gh, calls } = makeForge(store);
    const s1 = observe(emptySettleState(FULL), 7, TUPLE, T0, 'self-merge-prs:observe');
    const w1 = await writeSettleState(deps(gh), { state: s1, parentCommit: null }, 'bootstrap');
    if (!w1.ok) throw new Error(w1.reason);
    expect(store.refs.get(REF)).toBe(w1.commit);
    expect(store.commits.get(w1.commit)?.parents).toEqual([]);
    expect(calls.some((c) => c.includes('PATCH'))).toBe(false);
    // The tree has exactly the one ledger file.
    const tree = store.trees.get(store.commits.get(w1.commit)?.tree ?? '');
    expect([...(tree?.keys() ?? [])]).toEqual([SETTLE_STATE_PATH]);

    const snap = await readSettleState(deps(gh));
    expect(snap).toEqual({ state: s1, parentCommit: w1.commit, discarded: [] });
    const s2 = observe(snap.state, 7, TUPLE, T0 + SETTLE_MS, 'self-merge-prs:recheck');
    const w2 = await writeSettleState(deps(gh), { state: s2, parentCommit: w1.commit }, 'recheck');
    if (!w2.ok) throw new Error(w2.reason);
    expect(store.refs.get(REF)).toBe(w2.commit);
    expect(store.commits.get(w2.commit)?.parents).toEqual([w1.commit]);
    const patch = calls.find((c) => c.includes('PATCH'));
    // The exact argv PAIR: `-F force=false` (a typed boolean), adjacent.
    const forceAt = patch?.indexOf('force=false') ?? -1;
    expect(forceAt).toBeGreaterThan(0);
    expect(patch?.slice(forceAt - 1, forceAt + 1)).toEqual(['-F', 'force=false']);
    expect((await readSettleState(deps(gh))).state).toEqual(s2);
  });

  test('CAS conflict: a stale parent after another writer moved the tip → ok:false, tip unchanged', async () => {
    const store = newStore();
    const { gh } = makeForge(store);
    const base = await writeSettleState(
      deps(gh),
      { state: emptySettleState(FULL), parentCommit: null },
      'bootstrap',
    );
    if (!base.ok) throw new Error(base.reason);
    const mine = await readSettleState(deps(gh));
    const theirs = await readSettleState(deps(gh));
    const other = await writeSettleState(
      deps(gh),
      { state: observe(theirs.state, 8, TUPLE, T0, 'other'), parentCommit: theirs.parentCommit },
      'other writer',
    );
    if (!other.ok) throw new Error(other.reason);
    const stale = await writeSettleState(
      deps(gh),
      { state: observe(mine.state, 7, TUPLE, T0, 'mine'), parentCommit: mine.parentCommit },
      'stale writer',
    );
    expect(stale.ok).toBe(false);
    expect(stale.ok ? '' : stale.reason).toMatch(/concurrent writer/);
    expect(store.refs.get(REF)).toBe(other.commit);
  });

  test('concurrent bootstrap: the loser gets ok:false', async () => {
    const store = newStore();
    const { gh } = makeForge(store);
    const empty = { state: emptySettleState(FULL), parentCommit: null };
    const first = await writeSettleState(deps(gh), empty, 'a');
    const second = await writeSettleState(deps(gh), empty, 'b');
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.ok ? '' : second.reason).toMatch(/concurrent bootstrap/);
    expect(store.refs.get(REF)).toBe(first.ok ? first.commit : '');
  });

  test('any other transport failure resolves ok:false with a capped one-line reason', async () => {
    const { gh } = makeForge(newStore(), () => ({
      code: 1,
      stdout: '',
      stderr: `gh: Server Error (HTTP 500) ${'x'.repeat(2000)}\nsecond line`,
    }));
    const result = await writeSettleState(
      deps(gh),
      { state: emptySettleState(FULL), parentCommit: null },
      'x',
    );
    expect(result.ok).toBe(false);
    const reason = result.ok ? '' : result.reason;
    expect(reason.length).toBeLessThanOrEqual(500);
    expect(reason).not.toContain('\n');
    expect(reason).toMatch(/HTTP 500/);
  });
});

describe('durability', () => {
  test('state branch round-trip survives a simulated Actions-cache eviction', async () => {
    const forge = newStore();
    // Run 1: the workflow's journal dir lives in the Actions cache.
    const journalRoot = mkdtempSync(join(tmpdir(), 'cq-journal-'));
    mkdirSync(join(journalRoot, 'runs'), { recursive: true });
    writeFileSync(join(journalRoot, 'runs', 'run-1.json'), '{"note":"cached journal"}\n');
    const run1 = makeForge(forge);
    let snap = await readSettleState(deps(run1.gh));
    let state = observe(snap.state, 7, TUPLE, T0, 'self-merge-prs:observe');
    const w1 = await writeSettleState(
      deps(run1.gh),
      { state, parentCommit: snap.parentCommit },
      'observe',
    );
    expect(w1.ok).toBe(true);

    // The Actions cache is evicted: the whole journal dir is gone.
    rmSync(journalRoot, { recursive: true, force: true });
    expect(existsSync(journalRoot)).toBe(false);

    // Run 2: a FRESH store instance with only the forge.
    const run2 = makeForge(forge);
    snap = await readSettleState(deps(run2.gh));
    expect(snap.state).toEqual(state);
    state = observe(snap.state, 7, TUPLE, T0 + SETTLE_MS, 'self-merge-prs:recheck');
    const w2 = await writeSettleState(
      deps(run2.gh),
      { state, parentCommit: snap.parentCommit },
      'recheck',
    );
    expect(w2.ok).toBe(true);

    // Run 3: another fresh instance still reads the settled ledger.
    const run3 = makeForge(forge);
    const final = await readSettleState(deps(run3.gh));
    expect(final.state).toEqual(state);
    expect(settleStatus(final.state.prs['7'], TUPLE, T0 + SETTLE_MS, SETTLE_MS)).toEqual({
      settled: true,
      firstObservedAt: new Date(T0).toISOString(),
      elapsedMs: SETTLE_MS,
    });
    // The store never touched the filesystem: the evicted dir stays absent.
    expect(existsSync(journalRoot)).toBe(false);
  });
});
