// Offline controller state-machine tests. Gate judgments are covered by the
// real promote-gate/acceptance fixtures; this seam models only a qualified push.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  GateConfig,
  GateDeps,
  GateResult,
  VerifiedRunEvidence,
} from '../../src/selfhost/promote-gate.js';
import {
  controllerAcceptancePolicy,
  controllerMain,
  journalStore,
  runController,
  type ControllerDeps,
} from '../../src/selfhost/promotion-controller.js';

const fixture = vi.hoisted(() => ({
  gate: vi.fn<(deps: GateDeps, cfg: GateConfig) => Promise<GateResult>>(),
}));
vi.mock('../../src/selfhost/promote-gate.js', async (original) => ({
  ...(await original<typeof import('../../src/selfhost/promote-gate.js')>()),
  runGate: fixture.gate,
}));
const FROM = 'a'.repeat(40);
const TO = 'b'.repeat(40);
const AT = '2026-10-29T00:01:00Z';
const NOW = Date.parse(AT);
const source = { commit: FROM, tree: 'c'.repeat(40), artifactSha256: 'd'.repeat(64) };
const cfg: GateConfig = {
  repo: '/fixture',
  owner: 'o',
  name: 'r',
  repositoryId: 42,
  trustRef: FROM,
  defaultBranch: 'main',
  verdictAppId: 500,
  verifiedWorkflows: ['ci.yml'],
  reviewer: { login: 'fixture[bot]', id: 42 },
  timeoutMin: 0,
  push: true,
  pushToken: 'fixture',
  remoteUrl: '/fixture-remote',
};
const updates = [
  { refspec: `${TO}:refs/heads/main`, expected: FROM },
  { refspec: `${TO}:refs/heads/cq/promoted`, expected: FROM },
  { refspec: `${TO}:refs/heads/merge-queue`, expected: TO },
];
const evidence: VerifiedRunEvidence = {
  repositoryId: 42,
  from: FROM,
  subject: TO,
  workflow: 'ci.yml',
  runId: 100,
  runAttempt: 2,
  requiredJobs: ['j'],
  phase: 'final-recheck',
};
const temp: string[] = [];
afterEach(() => {
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  fixture.gate.mockReset();
  fixture.gate.mockImplementation(async (deps, config) => {
    await deps.acceptance({ pr: 7, subject: TO, state: 'merged', base: 'merge-queue' });
    await deps.onVerifiedRun?.(evidence);
    if (!config.push)
      return {
        verdict: 'would-promote',
        main: FROM,
        tip: TO,
        subject: TO,
        signer: 'advisory-missing',
        report: [],
      };
    try {
      const pushed = await deps.git.pushAtomic(
        config.repo,
        config.remoteUrl,
        updates,
        config.pushToken ?? '',
      );
      return {
        verdict: pushed.ok ? 'promoted' : 'refused',
        main: FROM,
        tip: TO,
        subject: TO,
        signer: 'advisory-missing',
        report: [],
      };
    } catch {
      return { verdict: 'refused', main: FROM, tip: TO, subject: TO, signer: null, report: [] };
    }
  });
});

function setup() {
  let saved: unknown = null;
  let verdict = 'UNVERIFIED';
  let ack: unknown = null;
  const calls: string[][] = [];
  const push = vi.fn(() => Promise.resolve({ ok: true, output: '' }));
  const unused = (): never => {
    throw new Error('unexpected real gate dependency in controller fixture');
  };
  const deps: ControllerDeps = {
    gate: {
      gh: unused,
      git: {
        revParse: unused,
        isAncestor: unused,
        rangeCommits: unused,
        firstParentRange: unused,
        treeOf: unused,
        mergeTreeClean: unused,
        readBlob: unused,
        changedPaths: unused,
        pushAtomic: push,
      },
      acceptance: (input) =>
        Promise.resolve({
          verdict: 'pass',
          pr: input.pr,
          subject: input.subject,
          acceptedBy: ['user:reviewer'],
          report: [],
        }),
      policyDiff: unused,
      sleep: unused,
      nowMs: () => NOW,
    },
    store: {
      acquire: () => () => {},
      read: () => structuredClone(saved),
      write: (value) => {
        saved = structuredClone(value);
      },
    },
    refs: () => Promise.resolve({ main: TO, promoted: TO }),
    crq: (args) => {
      calls.push([...args]);
      const op = (saved as { operations: { reason: string; after: string }[] }).operations.at(-1)!;
      if (args[0] === 'promotion-ack') {
        ack = { from: FROM, to: TO, audit_at: AT, reason: args[2], acknowledged_at: AT };
        return Promise.resolve({ code: 0, stdout: 'ok is not proof' });
      }
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify({
          schema: 1,
          from: FROM,
          to: TO,
          after: op.after,
          status: verdict === 'verified' ? 'verified' : 'unverified',
          record: { from: FROM, to: TO, at: AT, verdict, ...(ack ? { acknowledgement: ack } : {}) },
          ...(verdict === 'verified'
            ? {}
            : {
                alert: {
                  from: FROM,
                  to: TO,
                  at: AT,
                  acked: ack ? `${AT} ${op.reason}` : null,
                  ...(ack ? { acknowledgement: ack } : {}),
                },
              }),
        }),
      });
    },
    nowMs: () => NOW,
    id: () => '00000000-0000-4000-8000-000000000001',
  };
  const journal = () =>
    saved as {
      operations: {
        state: string;
        auditAt: string | null;
        ci: VerifiedRunEvidence[];
        reason: string;
        digest: string;
      }[];
    };
  return {
    deps,
    calls,
    push,
    journal,
    verdict: (v: string) => {
      verdict = v;
    },
  };
}

describe('promotion controller', () => {
  test('entrypoint removes the push credential even when argv refuses before transport construction', async () => {
    const env = { CQ_PROMOTE_TOKEN: 'offline-fixture' };
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await controllerMain([], env)).toBe(1);
      expect(Object.hasOwn(env, 'CQ_PROMOTE_TOKEN')).toBe(false);
      expect(output).toHaveBeenCalledWith('{"state":"held"}\n');
    } finally {
      output.mockRestore();
    }
  });
  test('composition rejects bot/ordinary COMMENTED acceptance while preserving marker opt-in and exclusions', () => {
    const policy = controllerAcceptancePolicy({
      CQ_MERGE_TRUSTED_BOTS: 'coderabbitai',
      CQ_MERGE_ACCEPT_REVIEW_STATES: 'COMMENTED,APPROVED',
      CQ_MERGE_ALLOW_SAME_ACCOUNT_AGENT_REVIEW: 'true',
    });
    expect([...policy.trustedBots]).toEqual([]);
    expect([...policy.acceptStates]).toEqual(['APPROVED']);
    expect(policy.allowSameAccountAgentReview).toBe(true);
    expect(policy.excludedLogins.has('github-actions[bot]')).toBe(true);
    expect(controllerAcceptancePolicy({}).allowSameAccountAgentReview).toBe(false);
  });
  test('confirmed exact push preserves leased tuple and persists gate evidence before one exact ack/readback', async () => {
    const h = setup();
    h.push.mockImplementation(() => {
      expect(h.journal().operations[0]?.state).toBe('PREPARED');
      expect(h.journal().operations[0]?.ci).toEqual([evidence]);
      return Promise.resolve({ ok: true, output: '' });
    });
    expect((await runController(h.deps, cfg, source)).state).toBe('complete');
    expect(h.push).toHaveBeenCalledExactlyOnceWith(cfg.repo, cfg.remoteUrl, updates, 'fixture');
    expect(h.journal().operations[0]?.state).toBe('ACK_CONFIRMED');
    expect(h.calls.map((c) => c[0])).toEqual([
      'promotion-audit-observe',
      'promotion-ack',
      'promotion-audit-observe',
    ]);
    expect(h.calls[1]).toEqual([
      'promotion-ack',
      TO,
      h.journal().operations[0]?.reason,
      '--audit-from',
      FROM,
      '--audit-at',
      AT,
    ]);
  });

  test('same-operation literal verified/no banner reaches durable AUDIT_VERIFIED with no ack', async () => {
    const h = setup();
    h.verdict('verified');
    expect((await runController(h.deps, cfg, source)).state).toBe('complete');
    expect(h.journal().operations[0]?.state).toBe('AUDIT_VERIFIED');
    expect(h.calls.map((c) => c[0])).toEqual(['promotion-audit-observe']);
  });

  test.each(['nonzero', 'throws', 'mismatched-ref', 'unavailable-ref'] as const)(
    'push %s cannot ack or automatically repush',
    async (mode) => {
      const h = setup();
      if (mode === 'nonzero')
        h.push.mockResolvedValue({ ok: false, output: 'success-looking text' });
      if (mode === 'throws') h.push.mockRejectedValue(new Error('unknown delivery'));
      if (mode === 'mismatched-ref')
        h.deps.refs = () => Promise.resolve({ main: FROM, promoted: TO });
      if (mode === 'unavailable-ref') h.deps.refs = () => Promise.reject(new Error('offline'));
      expect((await runController(h.deps, cfg, source)).state).toBe('held');
      expect((await runController(h.deps, cfg, source)).state).toBe('held');
      expect(h.push).toHaveBeenCalledTimes(1);
      expect(h.calls).toEqual([]);
      expect(h.journal().operations[0]?.state).toBe('UNKNOWN');
    },
  );

  test('prepare persistence failure prevents push; lease-held entry performs no work', async () => {
    const h = setup();
    h.deps.store.write = () => {
      throw new Error('fsync failure');
    };
    expect((await runController(h.deps, cfg, source)).state).toBe('held');
    expect(h.push).not.toHaveBeenCalled();
    h.deps.store.acquire = () => {
      throw new Error('held');
    };
    fixture.gate.mockClear();
    expect((await runController(h.deps, cfg, source)).state).toBe('held');
    expect(fixture.gate).not.toHaveBeenCalled();
  });

  test('crash after prepare never adopts remote equality as proof or repushes', async () => {
    const h = setup();
    const write = h.deps.store.write;
    let writes = 0;
    h.deps.store.write = (v) => {
      if (++writes > 1) throw new Error('crash');
      write(v);
    };
    expect((await runController(h.deps, cfg, source)).state).toBe('held');
    h.deps.store.write = write;
    expect((await runController(h.deps, cfg, source)).state).toBe('held');
    expect(h.journal().operations[0]?.state).toBe('UNKNOWN');
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.calls).toEqual([]);
  });

  test('absent observation serializes promotions; a later invocation resumes observation only', async () => {
    const h = setup();
    const crq = h.deps.crq;
    h.deps.crq = () =>
      Promise.resolve({
        code: 0,
        stdout: JSON.stringify({ schema: 1, from: FROM, to: TO, after: AT, status: 'absent' }),
      });
    expect((await runController(h.deps, cfg, source)).state).toBe('pending');
    expect(h.journal().operations[0]?.state).toBe('AWAITING_AUDIT');
    fixture.gate.mockClear();
    h.deps.crq = crq;
    expect((await runController(h.deps, cfg, source)).state).toBe('complete');
    expect(fixture.gate).not.toHaveBeenCalled();
    expect(h.push).toHaveBeenCalledTimes(1);
  });

  test('lost ack response retries identical operation and reason, without another promotion', async () => {
    const h = setup();
    const crq = h.deps.crq;
    let failed = false;
    h.deps.crq = async (args) => {
      const r = await crq(args);
      if (args[0] === 'promotion-ack' && !failed) {
        failed = true;
        return { code: 1, stdout: '' };
      }
      return r;
    };
    expect((await runController(h.deps, cfg, source)).state).toBe('pending');
    expect((await runController(h.deps, cfg, source)).state).toBe('complete');
    const acks = h.calls.filter((c) => c[0] === 'promotion-ack');
    expect(acks).toHaveLength(2);
    expect(acks[0]).toEqual(acks[1]);
    expect(h.push).toHaveBeenCalledTimes(1);
  });

  test('conflicting durable acknowledgement holds before any ack call', async () => {
    const h = setup();
    const crq = h.deps.crq;
    h.deps.crq = async (args) => {
      const r = await crq(args);
      const parsed = JSON.parse(r.stdout) as {
        record: Record<string, unknown>;
        alert: Record<string, unknown>;
      };
      const foreign = {
        from: FROM,
        to: TO,
        audit_at: AT,
        reason: 'another-operation',
        acknowledged_at: AT,
      };
      parsed.record['acknowledgement'] = foreign;
      parsed.alert['acknowledgement'] = foreign;
      parsed.alert['acked'] = `${AT} another-operation`;
      return { code: 0, stdout: JSON.stringify(parsed) };
    };
    expect((await runController(h.deps, cfg, source)).state).toBe('held');
    expect(h.calls.map((c) => c[0])).toEqual(['promotion-audit-observe']);
  });

  test('remote movement while observing prevents acknowledgement', async () => {
    const h = setup();
    const crq = h.deps.crq;
    h.deps.crq = async (args) => {
      const r = await crq(args);
      h.deps.refs = () => Promise.resolve({ main: 'e'.repeat(40), promoted: TO });
      return r;
    };
    expect((await runController(h.deps, cfg, source)).state).toBe('held');
    expect(h.calls.map((c) => c[0])).toEqual(['promotion-audit-observe']);
  });

  test('green-looking ack output without persisted matching receipt never completes', async () => {
    const h = setup();
    const crq = h.deps.crq;
    h.deps.crq = (args) =>
      args[0] === 'promotion-ack' ? Promise.resolve({ code: 0, stdout: 'ok' }) : crq(args);
    expect((await runController(h.deps, cfg, source)).state).toBe('held');
    expect(h.journal().operations[0]?.state).toBe('AWAITING_AUDIT');
  });

  test('crash after ack save but before controller terminal write resumes identical ack without repush', async () => {
    const h = setup();
    const write = h.deps.store.write;
    h.deps.store.write = (v) => {
      const state = (v as { operations: { state: string }[] }).operations.at(-1)?.state;
      if (state === 'ACK_CONFIRMED') throw new Error('terminal fsync failure');
      write(v);
    };
    expect((await runController(h.deps, cfg, source)).state).toBe('held');
    h.deps.store.write = write;
    expect((await runController(h.deps, cfg, source)).state).toBe('complete');
    const calls = h.calls.filter((c) => c[0] === 'promotion-ack');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
    expect(h.push).toHaveBeenCalledTimes(1);
  });

  test.each([
    'ambiguous',
    'unknown',
    'old',
    'future',
    'foreign',
    'banner',
    'uncorroborated',
  ] as const)('%s observation never manufactures a terminal or ack', async (shape) => {
    const h = setup();
    const crq = h.deps.crq;
    h.deps.crq = async (args) => {
      const r = await crq(args);
      const parsed = JSON.parse(r.stdout) as {
        status: string;
        from: string;
        record: { at: string; verdict: string };
      };
      if (shape === 'ambiguous' || shape === 'unknown') parsed.status = shape;
      if (shape === 'old') parsed.record.at = '2026-10-28T00:00:00Z';
      if (shape === 'future') parsed.record.at = '2099-01-01T00:00:00Z';
      if (shape === 'foreign') parsed.from = 'e'.repeat(40);
      if (shape === 'banner') {
        parsed.status = 'verified';
        parsed.record.verdict = 'verified';
      }
      if (shape === 'uncorroborated') parsed.record.verdict = 'verified-uncorroborated';
      return { code: 0, stdout: JSON.stringify(parsed) };
    };
    expect((await runController(h.deps, cfg, source)).state).not.toBe('complete');
    expect(h.calls.filter((c) => c[0] === 'promotion-ack')).toEqual([]);
  });

  test('dry run cannot resume a pending ack; source/repository/digest changes fail closed', async () => {
    const h = setup();
    h.deps.crq = () => Promise.resolve({ code: 1, stdout: '' });
    await runController(h.deps, cfg, source);
    expect((await runController(h.deps, { ...cfg, push: false }, source)).state).toBe('held');
    expect(
      (await runController(h.deps, cfg, { ...source, artifactSha256: 'e'.repeat(64) })).state,
    ).toBe('held');
    expect((await runController(h.deps, { ...cfg, repositoryId: 43 }, source)).state).toBe('held');
    h.journal().operations[0]!.digest = 'altered';
    expect((await runController(h.deps, cfg, source)).state).toBe('held');
    expect(h.push).toHaveBeenCalledTimes(1);
  });

  test('durable store writes complete JSON under exclusive lease and preserves receipts after release', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cq-controller-fixture-'));
    temp.push(dir);
    const store = journalStore(dir);
    const release = store.acquire();
    expect(() => store.acquire()).toThrow();
    store.write({ schema: 1, operations: ['receipt'] });
    expect(store.read()).toEqual({ schema: 1, operations: ['receipt'] });
    expect(JSON.parse(readFileSync(join(dir, 'journal.json'), 'utf8'))).toEqual(store.read());
    release();
    const next = store.acquire();
    next();
    expect(store.read()).toEqual({ schema: 1, operations: ['receipt'] });
  });
});
