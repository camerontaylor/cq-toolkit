// Analyze lane G3 — test evidence for the playbook registry + dispatch:
// the acceptance flow end to end over INJECTED runners and stores (no
// ast-grep binary, no real fs). Pinned here: register refuses duplicates;
// an unknown id fails naming the population; a QUARANTINED playbook is
// refused before anything runs (needs-human — lifting is explicit); a
// verifier PASS verifies; a verifier FAIL writes the quarantine record and
// the dispatch honestly reports remediation-applied-but-verifier-failed;
// an INDETERMINATE verifier is honest indeterminate, quarantines NOTHING,
// and still returns the trace record; the engine's own faults (collision,
// containment) fail closed without touching the ledger.
//
// Split provenance: test/ops/analyze/playbooks/registry.test.ts was split into
// registry.register.test.ts, registry.dispatch.test.ts,
// registry.dispatch-faults.test.ts, registry.withDispatch.test.ts,
// registry.holds.test.ts, registry.hold-identity.test.ts,
// registry.quarantine-list.test.ts, registry.rollback.test.ts,
// registry.lock-fault.test.ts and registry.approved-apply.test.ts; shared
// fixtures live in registry.helpers.ts.
import { describe, expect, test } from 'vitest';
import type { AnalyzeFileStore } from '../../../../src/ops/analyze/analysisStore.js';
import type { ApprovalAuthority } from '../../../../src/ops/analyze/approval.js';
import { makePlaybookDispatchOp } from '../../../../src/ops/analyze/playbooks/registry.js';
import {
  FIXTURE,
  approvedAuthority,
  dispatchEvidence,
  harness,
  playbookOf,
} from './registry.helpers.js';

describe('hold identity and mutation admission across containment roots and interleavings', () => {
  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve = (_value: T): void => {};
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  function faultingStore(
    store: AnalyzeFileStore,
    afterWrite: () => Promise<void> = async () => {},
  ): AnalyzeFileStore {
    let writes = 0;
    return {
      ...store,
      writeBytes: async (file, bytes) => {
        if (writes++ === 0) {
          await store.writeBytes(file, bytes);
          await afterWrite();
        }
        throw new Error('offline partial write and restore fault');
      },
    };
  }

  for (const [seedDir, seedFile, retryDir, retryFile] of [
    ['/ws', 'src/a.ts', '/ws/src', 'a.ts'],
    ['/ws/src', 'a.ts', '/ws', 'src/a.ts'],
  ]) {
    test(`a stranded hold from ${seedDir} follows the same file through ${retryDir}`, async () => {
      const original = FIXTURE['src/a.ts'];
      const h = harness({ [seedFile!]: original }, 0);
      const authority = (): ApprovalAuthority =>
        approvedAuthority({
          read: async (workspace) => ({ workspace, headSha: 'head-at-approval', treeClean: true }),
        }).authority;
      const dispatch = (store: AnalyzeFileStore) =>
        makePlaybookDispatchOp({
          playbooks: h.playbooks,
          quarantine: h.quarantine,
          run: h.run,
          storeFor: () => store,
          approval: authority(),
        });
      const input = { playbookId: 'fix-foo-bar', dir: seedDir!, targets: [seedFile!] };
      expect((await dispatch(faultingStore(h.store))(input)).status).toBe('failed');
      const scans = h.run.scans.length;
      // This store is correctly bound to the other containment root. The
      // obligation must retain the seed store and relative path for repair.
      const aliasStore: AnalyzeFileStore = {
        ...h.store,
        readBytes: async (file) => {
          expect(file).toBe(retryFile);
          return h.store.readBytes(seedFile!);
        },
        readText: async () => h.store.readText(seedFile!),
        writeBytes: async (_file, bytes) => h.store.writeBytes(seedFile!, bytes),
      };
      const blocked = await dispatch(aliasStore)({
        ...input,
        dir: retryDir!,
        targets: [retryFile!],
      });
      expect(blocked.status).toBe('needs-human');
      if (blocked.status === 'needs-human') expect(blocked.reason).toContain('stranded rollback');
      expect(h.run.scans).toHaveLength(scans);
      expect(h.run.verifierCalls).toHaveLength(0);
      expect(h.store.backing.get(seedFile!)).not.toBe(original);
      h.store.backing.set(seedFile!, original);
      expect((await dispatch(h.store)(input)).status).toBe('ok');
      expect(h.run.verifierCalls).toHaveLength(1);
    });
  }

  function raceFixture() {
    const h = harness(FIXTURE, 0);
    for (const id of ['waiter', 'writer']) h.playbooks.register({ ...playbookOf(), id });
    let onRead: ((bytes: Uint8Array) => Promise<Uint8Array>) | undefined;
    const store: AnalyzeFileStore = {
      ...h.store,
      readBytes: async (file) => {
        const bytes = await h.store.readBytes(file);
        const callback = onRead;
        onRead = undefined;
        return callback === undefined ? bytes : callback(bytes);
      },
    };
    const op = (boundStore = store) => {
      const { authority, ledger } = approvedAuthority();
      return {
        dispatch: makePlaybookDispatchOp({
          playbooks: h.playbooks,
          quarantine: h.quarantine,
          run: h.run,
          storeFor: () => boundStore,
          approval: authority,
        }),
        ledger,
      };
    };
    const input = (playbookId: string) => ({ playbookId, dir: '/ws', targets: ['src/a.ts'] });
    return {
      h,
      store,
      op,
      input,
      nextRead: (callback: typeof onRead) => {
        onRead = callback;
      },
    };
  }

  test('a newer stranded hold replaces the snapshot while reconciliation awaits a repaired read', async () => {
    const r = raceFixture();
    expect((await r.op(faultingStore(r.store)).dispatch(r.input('fix-foo-bar'))).status).toBe(
      'failed',
    );
    r.h.store.backing.set('src/a.ts', FIXTURE['src/a.ts']);
    const captured = deferred<void>();
    const resume = deferred<void>();
    r.nextRead(async (bytes) => {
      captured.resolve();
      await resume.promise;
      return bytes;
    });
    const waiter = r.op();
    const pending = waiter.dispatch(r.input('waiter'));
    await captured.promise;
    expect((await r.op(faultingStore(r.store)).dispatch(r.input('writer'))).status).toBe('failed');
    const scans = r.h.run.scans.length;
    resume.resolve();
    const blocked = await pending;
    expect(blocked.status).toBe('needs-human');
    if (blocked.status === 'needs-human')
      expect(blocked.reason).toContain('hold changed during reconciliation');
    expect(r.h.run.scans).toHaveLength(scans);
    expect(waiter.ledger.spent()).toBe(0);
    expect(r.h.run.verifierCalls).toHaveLength(0);
  });

  test('a hold published during capture is rechecked under the mutation lock before scan or nonce spend', async () => {
    const r = raceFixture();
    const captured = deferred<void>();
    const resume = deferred<void>();
    r.nextRead(async (bytes) => {
      captured.resolve();
      await resume.promise;
      return bytes;
    });
    const waiter = r.op();
    const pending = waiter.dispatch(r.input('waiter'));
    await captured.promise;
    expect((await r.op(faultingStore(r.store)).dispatch(r.input('writer'))).status).toBe('failed');
    const scans = r.h.run.scans.length;
    resume.resolve();
    const blocked = await pending;
    expect(blocked.status).toBe('needs-human');
    if (blocked.status === 'needs-human') {
      expect(blocked.reason).toContain('stranded rollback');
      expect(blocked.reason).toContain('UNSPENT');
    }
    expect(waiter.ledger.spent()).toBe(0);
    expect(r.h.run.scans).toHaveLength(scans);
    r.h.store.backing.set('src/a.ts', FIXTURE['src/a.ts']);
    expect((await waiter.dispatch(r.input('waiter'))).status).toBe('ok');
    expect(waiter.ledger.spent()).toBe(1);
  });

  test('a failing mutation publishes its hold before a queued mutator can enter preflight', async () => {
    const r = raceFixture();
    const written = deferred<void>();
    const releaseWriter = deferred<void>();
    const writer = r.op(
      faultingStore(r.store, async () => {
        written.resolve();
        await releaseWriter.promise;
      }),
    );
    const failing = writer.dispatch(r.input('writer'));
    await written.promise;
    const captured = deferred<void>();
    r.nextRead(async (bytes) => {
      captured.resolve();
      return bytes;
    });
    const waiter = r.op();
    const pending = waiter.dispatch(r.input('waiter'));
    await captured.promise;
    const scans = r.h.run.scans.length;
    releaseWriter.resolve();
    expect((await failing).status).toBe('failed');
    const blocked = await pending;
    expect(blocked.status).toBe('needs-human');
    if (blocked.status === 'needs-human') expect(blocked.reason).toContain('stranded rollback');
    expect(waiter.ledger.spent()).toBe(0);
    expect(r.h.run.scans).toHaveLength(scans);
    expect(r.h.run.verifierCalls).toHaveLength(0);
  });

  test('a failing verifier rollback publishes its hold before a queued mutator enters preflight', async () => {
    const r = raceFixture();
    r.h.setVerifierExit(null);
    const restoring = deferred<void>();
    const releaseRestore = deferred<void>();
    let writes = 0;
    const store: AnalyzeFileStore = {
      ...r.store,
      writeBytes: async (file, bytes) => {
        if (++writes === 2) {
          restoring.resolve();
          await releaseRestore.promise;
          throw new Error('offline rollback write fault');
        }
        await r.store.writeBytes(file, bytes);
      },
    };
    const failing = r.op(store).dispatch(r.input('writer'));
    await restoring.promise;
    const captured = deferred<void>();
    r.nextRead(async (bytes) => {
      captured.resolve();
      return bytes;
    });
    const waiter = r.op();
    const pending = waiter.dispatch(r.input('waiter'));
    await captured.promise;
    const scans = r.h.run.scans.length;
    releaseRestore.resolve();
    const result = await failing;
    expect(result.status).toBe('indeterminate');
    if (result.status === 'indeterminate') {
      expect(dispatchEvidence(result.detail).restore.stranded).toHaveLength(1);
    }
    const blocked = await pending;
    expect(blocked.status).toBe('needs-human');
    if (blocked.status === 'needs-human') expect(blocked.reason).toContain('stranded rollback');
    expect(waiter.ledger.spent()).toBe(0);
    expect(r.h.run.scans).toHaveLength(scans);
    expect(r.h.run.verifierCalls).toHaveLength(1);
  });
});
