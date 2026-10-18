// dev.review op tests — scripted effects + a stub scanner. Pinned: the base
// pin (merge-base against the intended target, or the explicit sha resolved
// once), the secret scan BEFORE any reviewer run, the host-lock span, the
// honest completion recording (terminal vs blocked with the reason), the
// finding id minting, and the log written outside the repository.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, test, vi } from 'vitest';
import { DevReviewInputSchema, registry } from '../../../src/ops/dev/registry.js';
import type { DiffSecretScanner } from '../../../src/ops/dev/denylist.js';
import type { Op } from '../../../src/kernel/types.js';
import {
  makeDevReview,
  type DevCycleInput,
  type DevReviewReport,
} from '../../../src/ops/dev/review.js';
import { sshAuthorTransport, type AuthorTransport } from '../../../src/ops/dev/review-transport.js';
import { BASE, BRANCH, failResult, HEAD, makeFakeEffects, okResult, stubScanner } from './fakes.js';

/**
 * The cycle action under test: the composed op bound to the given
 * effects/scanner (and no transport — the cycle never reads one). A cycle
 * input produces the cycle result, so the test-side view is the cycle
 * branch of the op's result union.
 */
const cycleReview = (effects: ReturnType<typeof makeFakeEffects>, scanSecrets: DiffSecretScanner) =>
  makeDevReview({ effects, scanSecrets }) as Op<DevCycleInput, DevReviewReport>;

/**
 * The admission action under test: the composed op with the given transport
 * and inert effects/scanner deps (an admission action never touches them).
 */
const admissionReview = (transport: AuthorTransport) =>
  makeDevReview({ transport, effects: makeFakeEffects(), scanSecrets: stubScanner() });

const NDJSON_OK = [
  JSON.stringify({ type: 'status', status: 'scanning' }),
  JSON.stringify({ type: 'finding', severity: 'major', fileName: 'src/a.ts', comment: 'fix this' }),
  JSON.stringify({ type: 'finding', severity: 'minor', comment: 'nit' }),
  JSON.stringify({ type: 'complete', status: 'review_completed' }),
  '',
].join('\n');

/** Effects whose reviewer run produces the given NDJSON and exit code. */
function reviewEffects(ndjson: string, exitCode: number) {
  return makeFakeEffects((command, args) => {
    if (command === 'coderabbit') {
      expect(args[0]).toBe('review');
      expect(args[1]).toBe('--agent');
      expect(args[2]).toBe('--base-commit');
      return { exitCode, stdout: ndjson, stderr: '', timedOut: false };
    }
    if (command === 'git' && args[0] === 'diff' && args[1] === '--binary') {
      return okResult('patchtext', '');
    }
    return undefined;
  });
}

describe('dev.review', () => {
  test('a terminal cycle: ok report, ledger record with minted ids, log outside the repo', async () => {
    const effects = reviewEffects(NDJSON_OK, 0);
    const result = await cycleReview(effects, stubScanner())({ repoRoot: '/repo' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.cycleId).toBe('c001-aaaaaaaa');
    expect(result.value.base).toBe(BASE);
    expect(result.value.head).toBe(HEAD);
    expect(result.value.dirtySha256).not.toBe('clean-tree');
    expect(result.value.findings).toHaveLength(2);
    expect(result.value.findings[0]).toMatchObject({
      id: 'c001-aaaaaaaa#f1',
      severity: 'major',
      fileName: 'src/a.ts',
    });
    expect(result.value.logPath).toContain('/tmp/fake-cq-dev-review/');

    const ledger = effects.openLedger(BRANCH).load();
    expect(ledger.records).toHaveLength(1);
    const record = ledger.records[0];
    expect(record?.kind).toBe('cycle');
    if (record?.kind === 'cycle') {
      expect(record.completion).toEqual({ kind: 'terminal' });
      expect(record.reviewer).toBe('coderabbit');
      expect(record.scope).toBe('full');
      expect(record.logPath).toBe(result.value.logPath);
    }
  });

  test('the pinned base is the merge-base of origin/<target> and HEAD', async () => {
    const effects = reviewEffects(NDJSON_OK, 0);
    await cycleReview(effects, stubScanner())({ repoRoot: '/repo', target: 'main' });
    const mergeBase = effects.commands.find((entry) => entry.args[0] === 'merge-base');
    expect(mergeBase?.args).toEqual(['merge-base', 'origin/main', 'HEAD']);
  });

  test('an explicit base resolves once to a commit (the immutable pin)', async () => {
    const effects = reviewEffects(NDJSON_OK, 0);
    const result = await cycleReview(
      effects,
      stubScanner(),
    )({ repoRoot: '/repo', base: '1234567' });
    expect(result.status).toBe('ok');
    const resolve = effects.commands.find(
      (entry) => entry.args[0] === 'rev-parse' && entry.args[1] === '1234567^{commit}',
    );
    expect(resolve).toBeDefined();
    if (result.status === 'ok') expect(result.value.base).toBe(BASE);
  });

  test('an explicit base that does not resolve is needs-human, no reviewer run', async () => {
    const effects = makeFakeEffects((command, args) => {
      if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'deadbeef^{commit}') {
        return failResult(128, '', 'unknown revision');
      }
      return undefined;
    });
    const result = await cycleReview(
      effects,
      stubScanner(),
    )({ repoRoot: '/repo', base: 'deadbeef' });
    expect(result.status).toBe('needs-human');
    expect(effects.commands.find((entry) => entry.command === 'coderabbit')).toBeUndefined();
  });

  test('THE SCAN GATES THE UPLOAD: a secret hit refuses before the reviewer runs, nothing recorded', async () => {
    const effects = reviewEffects(NDJSON_OK, 0);
    const scanner = stubScanner([{ component: 'committed', ruleId: 'class:token-ssh-plumbing' }]);
    const result = await cycleReview(effects, scanner)({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('class:token-ssh-plumbing');
      expect(result.reason).toContain('committed');
    }
    expect(effects.commands.find((entry) => entry.command === 'coderabbit')).toBeUndefined();
    expect(effects.openLedger(BRANCH).load().records).toHaveLength(0);
  });

  test('a scanner fault refuses the review too', async () => {
    const effects = reviewEffects(NDJSON_OK, 0);
    const result = await cycleReview(effects, () => {
      throw new Error('patterns.yml malformed');
    })({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('malformed');
    expect(effects.commands.find((entry) => entry.command === 'coderabbit')).toBeUndefined();
  });

  test('blocked variants are recorded honestly with the reason and never ok', async () => {
    const cases: { name: string; ndjson: string; exitCode: number; why: RegExp }[] = [
      {
        name: 'non-zero exit',
        ndjson: NDJSON_OK,
        exitCode: 3,
        why: /exited 3/,
      },
      {
        name: 'error event',
        ndjson: `${JSON.stringify({ type: 'error', message: 'quota' })}\n`,
        exitCode: 0,
        why: /error event/,
      },
      {
        name: 'skipped',
        ndjson: `${JSON.stringify({ type: 'complete', status: 'review_skipped' })}\n`,
        exitCode: 0,
        why: /review_skipped/,
      },
      {
        name: 'action required',
        ndjson: `${JSON.stringify({ type: 'action_required' })}\n${JSON.stringify({ type: 'complete', status: 'review_completed' })}\n`,
        exitCode: 0,
        why: /action/,
      },
      {
        name: 'no terminal event',
        ndjson: `${JSON.stringify({ type: 'heartbeat' })}\n`,
        exitCode: 0,
        why: /without a terminal/,
      },
    ];
    for (const testCase of cases) {
      const effects = reviewEffects(testCase.ndjson, testCase.exitCode);
      const result = await cycleReview(effects, stubScanner())({ repoRoot: '/repo' });
      expect(result.status, testCase.name).toBe('needs-human');
      if (result.status === 'needs-human') {
        expect(result.reason, testCase.name).toMatch(testCase.why);
        expect(result.reason, testCase.name).toContain('c001-aaaaaaaa');
      }
      const ledger = effects.openLedger(BRANCH).load();
      const record = ledger.records[0];
      expect(record?.kind, testCase.name).toBe('cycle');
      if (record?.kind === 'cycle') {
        expect(record.completion.kind, testCase.name).toBe('blocked');
        if (record.completion.kind === 'blocked') {
          expect(record.completion.reason, testCase.name).toMatch(testCase.why);
        }
      }
    }
  });

  test('a TIMED-OUT reviewer run blocks naming the timeout, not a spawn fault', async () => {
    const effects = reviewEffects(NDJSON_OK, 0);
    const original = effects.runCommand;
    effects.runCommand = async (command, args, opts) => {
      if (command === 'coderabbit') {
        return { exitCode: null, stdout: '', stderr: '', timedOut: true };
      }
      return original(command, args, opts);
    };
    const result = await cycleReview(effects, stubScanner())({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('timed out');
      expect(result.reason).not.toContain('did not run');
    }
  });

  test('a spawn fault (missing binary) is a blocked cycle naming the fault, not a crash', async () => {
    const effects = makeFakeEffects((command, args) => {
      if (command === 'coderabbit') throw new Error('spawn coderabbit ENOENT');
      // A non-empty unstaged patch so the run reaches the reviewer.
      if (command === 'git' && args[0] === 'diff' && args.length === 1)
        return okResult('patch text');
      return undefined;
    });
    const result = await cycleReview(effects, stubScanner())({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('BLOCKED');
    const record = effects.openLedger(BRANCH).load().records[0];
    expect(record?.kind).toBe('cycle');
    if (record?.kind === 'cycle' && record.completion.kind === 'blocked') {
      expect(record.completion.reason).toContain('did not run');
    }
  });

  test('the SCANNER ITSELF sees the index split change (capture-time binding): refused, no reviewer run', async () => {
    // The attack the capture-time binding exists for: the index split
    // changes DURING scanner execution. The scanner stub mutates the
    // simulated index on invocation, so the SECOND `git diff --cached`
    // read (the in-lock rebind) diverges from the text the scan saw —
    // while the aggregate HEAD→worktree diff stays byte-identical
    // throughout. A post-scan baseline would bless the unscanned content;
    // the capture-time hash must refuse.
    const effects = reviewEffects(NDJSON_OK, 0);
    let indexMutated = false;
    const original = effects.runCommand;
    effects.runCommand = async (command, args, opts) => {
      if (command === 'git' && args[0] === 'diff' && args[1] === '--cached' && indexMutated) {
        return okResult('unscanned secret-bearing staged patch');
      }
      return original(command, args, opts);
    };
    const mutatingScanner = (components: readonly { component: string }[]) => {
      // The scan itself observes the index flip: content it will be asked
      // to have scanned is no longer what the next read returns.
      indexMutated = true;
      return components.map((component) => ({ component: component.component, hits: [] }));
    };
    const result = await cycleReview(effects, mutatingScanner)({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('staged patch changed since the scan');
    }
    expect(effects.commands.find((entry) => entry.command === 'coderabbit')).toBeUndefined();
    expect(effects.openLedger(BRANCH).load().records).toHaveLength(0);
  });

  test('an absent staged patch that APPEARS in-lock diverges from the empty capture', async () => {
    // Empty-string capture: the scan saw NO staged patch; the recheck finds
    // one — the hash of '' must not match.
    const effects = makeFakeEffects((command, args) => {
      if (command === 'git' && args[0] === 'diff' && args[1] === '--cached') {
        return okResult(''); // capture: empty
      }
      if (command === 'coderabbit') return okResult(NDJSON_OK);
      if (command === 'git' && args[0] === 'diff' && args[1] === '--binary')
        return okResult('aggregate-unchanged');
      if (command === 'git' && args[0] === 'diff' && args.length === 1) {
        // unstaged: capture '' (read 1); the in-lock recheck (read 2)
        // suddenly carries content.
        return okResult('late-appearing unstaged patch');
      }
      return undefined;
    });
    const reads: number[] = [];
    const original = effects.runCommand;
    effects.runCommand = async (command, args, opts) => {
      if (command === 'git' && args[0] === 'diff' && args[1] === '--cached') reads.push(0);
      if (command === 'git' && args[0] === 'diff' && args[1] === undefined && args.length === 1) {
        reads.push(1);
        if (reads.filter((r) => r === 1).length >= 2)
          return okResult('late-appearing unstaged patch');
        return okResult('');
      }
      return original(command, args, opts);
    };
    const result = await cycleReview(effects, stubScanner())({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('unstaged patch changed since the scan');
    }
  });

  test('a failed dirty-diff read is needs-human, never a fabricated clean tree', async () => {
    const effects = reviewEffects(NDJSON_OK, 0);
    const original = effects.runCommand;
    effects.runCommand = async (command, args, opts) => {
      if (
        command === 'git' &&
        args[0] === 'diff' &&
        args[1] === '--binary' &&
        args[2] === '--full-index' &&
        args[3] === 'HEAD'
      ) {
        return { exitCode: 128, stdout: '', stderr: 'fatal: bad object HEAD', timedOut: false };
      }
      return original(command, args, opts);
    };
    const result = await cycleReview(effects, stubScanner())({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('dirty-diff identity');
    expect(effects.commands.find((entry) => entry.command === 'coderabbit')).toBeUndefined();
  });

  test('worktree drift while waiting on the host lock refuses before the reviewer runs', async () => {
    let headCalls = 0;
    const effects = reviewEffects(NDJSON_OK, 0);
    const original = effects.runCommand;
    effects.runCommand = async (command, args, opts) => {
      if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
        headCalls += 1;
        if (headCalls >= 2) return okResult('9999999999999999999999999999999999999999\n');
      }
      return original(command, args, opts);
    };
    const result = await cycleReview(effects, stubScanner())({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('HEAD moved');
      expect(result.reason).toContain('waiting for the review lock');
    }
    expect(effects.commands.find((entry) => entry.command === 'coderabbit')).toBeUndefined();
    expect(effects.openLedger(BRANCH).load().records).toHaveLength(0);
  });

  test('the agent fallback is refused by name — never a substitute for the CLI cycle', async () => {
    const effects = reviewEffects(NDJSON_OK, 0);
    const result = await cycleReview(
      effects,
      stubScanner(),
    )({
      repoRoot: '/repo',
      reviewer: 'agent:zai/glm-4.7',
    });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('agent');
      expect(result.reason).toContain('fallback');
    }
    expect(effects.commands).toHaveLength(0);
  });

  test('an unknown reviewer word is a failed result', async () => {
    const effects = reviewEffects(NDJSON_OK, 0);
    const result = await cycleReview(
      effects,
      stubScanner(),
    )({ repoRoot: '/repo', reviewer: 'mystery' });
    expect(result.status).toBe('failed');
  });

  test('an empty selected scope is needs-human before the scan or the run', async () => {
    const effects = makeFakeEffects(() => undefined);
    const result = await cycleReview(effects, stubScanner())({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('no diff to review');
  });

  test('uncommitted scope skips the committed patch component and flags --uncommitted', async () => {
    const effects = makeFakeEffects((command, args) => {
      if (command === 'coderabbit') {
        expect(args).toContain('--uncommitted');
        return okResult(NDJSON_OK);
      }
      if (command === 'git' && args[0] === 'diff' && args[1] === '--cached')
        return okResult('staged-patch');
      if (command === 'git' && args[0] === 'diff') return okResult('unstaged-patch');
      return undefined;
    });
    const seenComponents: string[] = [];
    const result = await cycleReview(effects, (components) => {
      seenComponents.push(...components.map((component) => component.component));
      return components.map((component) => ({ component: component.component, hits: [] }));
    })({ repoRoot: '/repo', uncommitted: true });
    expect(result.status).toBe('ok');
    expect(seenComponents).toEqual(['staged', 'unstaged']);
    // The identity still pins the merge-base (the record's triple), but the
    // committed patch component is absent from the uncommitted scope.
    const mergeBase = effects.commands.find((entry) => entry.args[0] === 'merge-base');
    expect(mergeBase).toBeDefined();
  });

  test('untracked files are scanned and recorded in the cycle', async () => {
    const effects = makeFakeEffects((command, args) => {
      if (command === 'coderabbit') return okResult(NDJSON_OK);
      if (command === 'git' && args[0] === 'ls-files') return okResult('notes.md\n');
      if (command === 'git' && args[0] === 'diff' && args[1] === '--binary')
        return okResult('patch');
      return undefined;
    });
    effects.readWorktreeFile = async (path) =>
      path === 'notes.md'
        ? { ok: true as const, text: 'content' }
        : { ok: false as const, reason: 'unreadable' };
    const seen: string[] = [];
    const result = await cycleReview(effects, (components) => {
      seen.push(...components.map((component) => component.component));
      return components.map((component) => ({ component: component.component, hits: [] }));
    })({ repoRoot: '/repo' });
    expect(result.status).toBe('ok');
    expect(seen).toContain('untracked:notes.md');
    const record = effects.openLedger(BRANCH).load().records[0];
    if (record?.kind === 'cycle') expect(record.untracked).toEqual(['notes.md']);
  });

  test('an unreadable untracked file refuses the review (never silently skipped)', async () => {
    const effects = makeFakeEffects((command, args) => {
      if (command === 'git' && args[0] === 'ls-files') return okResult('gone.md\n');
      if (command === 'git' && args[0] === 'diff' && args[1] === '--binary')
        return okResult('patch');
      return undefined;
    });
    effects.readWorktreeFile = async () => ({ ok: false as const, reason: 'unreadable' });
    const result = await cycleReview(effects, stubScanner())({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('gone.md');
    expect(effects.commands.find((entry) => entry.command === 'coderabbit')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The author-admission branch (the merged worker-transport suite — every
// assertion carried over verbatim, routed through the composed op).
// ---------------------------------------------------------------------------

const admissionInput = {
  action: 'enroll',
  requestId: 'worker-1',
  base: 'a'.repeat(40),
  head: 'b'.repeat(40),
  target: 'origin/merge-queue',
  cycle: 1,
} as const;
const admissionBinding = {
  request_id: admissionInput.requestId,
  base: admissionInput.base,
  head: admissionInput.head,
  target: admissionInput.target,
  cycle: admissionInput.cycle,
};
const waitingDecision = {
  v: 1,
  request_id: admissionInput.requestId,
  binding: admissionBinding,
  issuer: 'waiting',
  reviewer: null,
  deadline_at: '2026-10-17T00:25:00Z',
  decided_at: null,
  dispatch: false,
};

describe('dev.review worker admission (no local issuer)', () => {
  it('exposes the operation through the lazy registry', async () => {
    const entry = registry.find((item) => item.name === 'dev.review');
    expect(entry?.name).toBe('dev.review');
    expect(await entry?.importer()).toBeTypeOf('function');
    expect(DevReviewInputSchema.safeParse({ ...admissionInput, spool: 'promotion' }).success).toBe(
      false,
    );
    expect(
      DevReviewInputSchema.safeParse({ ...admissionInput, head: admissionInput.base }).success,
    ).toBe(false);
    expect(() => sshAuthorTransport('-oProxyCommand=bad')).toThrow();
  });

  it('disables SSH sharing and unrelated agent keys for the author identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cq-author-ssh-'));
    try {
      await writeFile(
        join(root, 'ssh'),
        [
          '#!/bin/sh',
          '[ "$1" = "-T" ] || exit 20',
          '[ "$2" = "-S" ] && [ "$3" = "none" ] || exit 21',
          'identity_only=no; connect_timeout=no; attempts=no',
          'for arg do [ "$arg" != "IdentitiesOnly=yes" ] || identity_only=yes; done',
          'for arg do [ "$arg" != "ConnectTimeout=15" ] || connect_timeout=yes; done',
          'for arg do [ "$arg" != "ConnectionAttempts=1" ] || attempts=yes; done',
          '[ "$identity_only" = yes ] || exit 22',
          '[ "$connect_timeout" = yes ] && [ "$attempts" = yes ] || exit 23',
          'cat >/dev/null',
          `printf '%s\\n' '${JSON.stringify(waitingDecision)}'`,
          '',
        ].join('\n'),
        { mode: 0o700 },
      );
      vi.stubEnv('PATH', root + ':' + process.env['PATH']);
      const reply = await admissionReview(sshAuthorTransport('fixture-author'))(admissionInput);
      expect(reply).toEqual({ status: 'ok', value: waitingDecision });
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('round-trips the real Python versioned wire encoder/decoder at this SHA', async () => {
    const transport: AuthorTransport = (request) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          'python3',
          ['-B', '-c', 'from test_author_transport import fixture_main; fixture_main()'],
          {
            cwd: fileURLToPath(new URL('../../../apps/crq-python/', import.meta.url)),
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
        let output = '';
        let error = '';
        child.stdout.on('data', (s: Buffer) => {
          output += s.toString();
        });
        child.stderr.on('data', (s: Buffer) => {
          error += s.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve(output) : reject(new Error(error))));
        child.stdin.end(request);
      });
    expect(await admissionReview(transport)(admissionInput)).toEqual({
      status: 'ok',
      value: waitingDecision,
    });
  });

  it('does not retry or dispatch after uncertain delivery', async () => {
    let calls = 0;
    const op = admissionReview(async () => {
      calls++;
      throw new Error('timeout');
    });
    expect((await op(admissionInput)).status).toBe('indeterminate');
    expect(calls).toBe(1);
  });

  it.each([
    { ...waitingDecision, request_id: 'other' },
    { ...waitingDecision, binding: { ...admissionBinding, head: 'c'.repeat(40) } },
    { ...waitingDecision, v: 2 },
    { ...waitingDecision, dispatch: true },
    {
      ...waitingDecision,
      issuer: 'agent',
      reviewer: 'agent:configured',
      dispatch: true,
      decided_at: '2026-10-17T00:25:00Z',
    },
  ])('refuses mismatched, unsupported or unsolicited dispatch replies', async (reply) => {
    expect((await admissionReview(async () => JSON.stringify(reply))(admissionInput)).status).toBe(
      'indeterminate',
    );
  });

  it('returns only explicit one-shot agent permission from a fallback request', async () => {
    const reply = {
      ...waitingDecision,
      issuer: 'agent',
      reviewer: 'agent:configured',
      dispatch: true,
      decided_at: '2026-10-17T00:25:00Z',
    };
    const op = admissionReview(async () => JSON.stringify(reply));
    expect(await op({ ...admissionInput, action: 'fallback' })).toEqual({
      status: 'ok',
      value: reply,
    });
  });
});

// ---------------------------------------------------------------------------
// The ONE-op union contract: dispatch on `action`, branch strictness, and
// the byte-for-byte crq invocation.
// ---------------------------------------------------------------------------

describe('dev.review — one op discriminated on action', () => {
  it('accepts an explicit action "cycle" as the review cycle', async () => {
    const effects = reviewEffects(NDJSON_OK, 0);
    const result = await cycleReview(
      effects,
      stubScanner(),
    )({
      repoRoot: '/repo',
      action: 'cycle',
    });
    expect(result.status).toBe('ok');
  });

  it('refuses an unknown action with the failed taxonomy (never a silent cycle)', async () => {
    const effects = reviewEffects(NDJSON_OK, 0);
    const result = await cycleReview(
      effects,
      stubScanner(),
    )({
      repoRoot: '/repo',
      action: 'bogus',
    } as unknown as DevCycleInput);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain("unknown action 'bogus'");
      expect(result.error).toContain("'enroll' | 'status' | 'fallback'");
    }
    expect(effects.commands.find((entry) => entry.command === 'coderabbit')).toBeUndefined();
  });

  it('the union schema refuses branch-crossing spellings', () => {
    expect(DevReviewInputSchema.safeParse({ repoRoot: '/repo', action: 'bogus' }).success).toBe(
      false,
    );
    // An admission action without the transport binding fields matches no branch.
    expect(DevReviewInputSchema.safeParse({ repoRoot: '/repo', action: 'enroll' }).success).toBe(
      false,
    );
    // A cycle-only key on the transport branch matches no branch.
    expect(DevReviewInputSchema.safeParse({ ...admissionInput, repoRoot: '/repo' }).success).toBe(
      false,
    );
  });

  it('keeps the crq worker-transport invocation working byte-for-byte (worker-transport.md:29)', () => {
    // The exact CLI spelling from apps/crq-python/ops/worker-transport.md:29;
    // the CLI JSON-parses flag values, so --cycle=1 arrives as the number 1.
    expect(
      DevReviewInputSchema.safeParse({
        action: 'enroll',
        requestId: 'branch-cycle-1',
        base: 'a'.repeat(40),
        head: 'b'.repeat(40),
        target: 'origin/merge-queue',
        cycle: 1,
      }).success,
    ).toBe(true);
  });

  it('the registry admission dispatch without the ambient alias reports the configuration gap', async () => {
    const entry = registry.find((item) => item.name === 'dev.review');
    const op = await entry?.importer();
    const previous = process.env['CQ_AUTHOR_SSH_ALIAS'];
    delete process.env['CQ_AUTHOR_SSH_ALIAS'];
    try {
      const result = await op?.(admissionInput);
      expect(result).toMatchObject({ status: 'needs-human' });
      if (result !== null && typeof result === 'object' && 'reason' in result) {
        expect(String(result.reason)).toContain('CQ_AUTHOR_SSH_ALIAS');
      }
    } finally {
      if (previous !== undefined) process.env['CQ_AUTHOR_SSH_ALIAS'] = previous;
    }
  });
});

// ---------------------------------------------------------------------------
// Late-thread hardening: exact-byte identity hashing, binary blob scanning,
// and the post-run drift refusal.
// ---------------------------------------------------------------------------

describe('dev.review — late-thread hardening', () => {
  test('the dirty-diff identity hashes the EXACT bytes (no trim)', async () => {
    const run = (diffText: string) => {
      const effects = makeFakeEffects((command, args) => {
        if (command === 'coderabbit')
          return { exitCode: 0, stdout: NDJSON_OK, stderr: '', timedOut: false };
        if (command === 'git' && args[0] === 'diff' && args[1] === '--binary')
          return okResult(diffText);
        return undefined;
      });
      return cycleReview(effects, stubScanner())({ repoRoot: '/repo' });
    };
    const plain = await run('patch\n');
    const padded = await run('patch   \n');
    expect(plain.status).toBe('ok');
    expect(padded.status).toBe('ok');
    if (plain.status === 'ok' && padded.status === 'ok') {
      // Trailing whitespace on the final patch line is real content — a
      // trimmed hash would keep an earlier green run current across it.
      expect(plain.value.dirtySha256).not.toBe(padded.value.dirtySha256);
    }
  });

  test('a staged BINARY file is scanned from its BLOB, not the placeholder', async () => {
    const binaryPatch = [
      'diff --git a/keys.dat b/keys.dat',
      'GIT binary patch',
      'literal 10',
      'cmZ~1#x==',
      '',
    ].join('\n');
    const seen: { component: string; kind: string; text: string }[] = [];
    const effects = makeFakeEffects((command, args) => {
      if (command === 'git' && args[0] === 'diff' && args[1] === '--binary') return okResult('');
      if (command === 'git' && args[0] === 'diff' && args[1] === '--cached')
        return okResult(binaryPatch);
      if (command === 'git' && args[0] === 'cat-file') return okResult('STAGED-BLOB-BYTES-ff77');
      if (command === 'coderabbit')
        return { exitCode: 0, stdout: NDJSON_OK, stderr: '', timedOut: false };
      return undefined;
    });
    const result = await cycleReview(effects, async (components) => {
      for (const component of components) {
        seen.push({ component: component.component, kind: component.kind, text: component.text });
      }
      return components.map((component) => ({ component: component.component, hits: [] }));
    })({ repoRoot: '/repo' });
    expect(result.status).toBe('ok');
    const blobComponent = seen.find((entry) => entry.component === 'binary:staged:keys.dat');
    expect(blobComponent).toBeDefined();
    expect(blobComponent?.kind).toBe('file');
    expect(blobComponent?.text).toBe('STAGED-BLOB-BYTES-ff77');
  });

  test.each(['staged', 'unstaged'] as const)(
    'a %s binary deletion scans the removed bytes',
    async (leg) => {
      const patch =
        'diff --git a/asset.dat b/asset.dat\nBinary files a/asset.dat and /dev/null differ\n';
      const requested: string[] = [];
      const effects = makeFakeEffects((command, args) => {
        if (command === 'git' && args[0] === 'diff') {
          if (
            (leg === 'staged' && args[1] === '--cached') ||
            (leg === 'unstaged' && args.length === 1)
          )
            return okResult(patch);
          return okResult('');
        }
        if (command === 'git' && args[0] === 'cat-file') {
          requested.push(args[2] ?? '');
          if (args[2] === (leg === 'staged' ? `${HEAD}:asset.dat` : ':asset.dat'))
            return okResult('REMOVED-BYTES');
          return failResult(128);
        }
        if (command === 'coderabbit') return okResult(NDJSON_OK);
        return undefined;
      });
      effects.readWorktreeFile = async () => ({ ok: false, reason: 'ENOENT: deleted' });
      const scanned: string[] = [];
      const result = await cycleReview(effects, async (components) => {
        scanned.push(
          ...components
            .filter((component) => component.kind === 'file')
            .map((component) => component.text),
        );
        return components.map((component) => ({ component: component.component, hits: [] }));
      })({ repoRoot: '/repo' });
      expect(result.status).toBe('ok');
      expect(scanned).toContain('REMOVED-BYTES');
      expect(requested).toContain(leg === 'staged' ? `${HEAD}:asset.dat` : ':asset.dat');
    },
  );

  test('a committed BINARY file is scanned from BOTH blobs; a hit refuses the upload', async () => {
    const binaryPatch = [
      'diff --git a/keys.dat b/keys.dat',
      'GIT binary patch',
      'literal 10',
      'cmZ~1#x==',
      '',
    ].join('\n');
    const requested: string[] = [];
    const effects = makeFakeEffects((command, args) => {
      if (command === 'git' && args[0] === 'diff' && args[1] === '--binary') {
        // The committed leg is `diff … <base> HEAD` — the pinned base sits
        // at args[3]; the dirty-diff leg ends at HEAD directly.
        if (args[3] === BASE) return okResult(binaryPatch);
        return okResult('');
      }
      if (command === 'git' && args[0] === 'cat-file') {
        requested.push(args[2] ?? '');
        return okResult('BLOBBYTES');
      }
      return undefined;
    });
    const result = await cycleReview(effects, async (components) =>
      components.map((component) => ({
        component: component.component,
        hits: component.component.startsWith('binary:')
          ? [{ ruleId: 'class:pem', lines: [1] }]
          : [],
      })),
    )({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('class:pem');
      expect(result.reason).toContain('binary:committed(base):keys.dat');
    }
    expect(requested).toContain(`${BASE}:keys.dat`);
    expect(requested).toContain(`${HEAD}:keys.dat`);
    expect(effects.openLedger(BRANCH).load().records).toHaveLength(0);
  });

  test('identity drift DURING the review refuses the cycle — nothing recorded', async () => {
    let dirtyReads = 0;
    const effects = makeFakeEffects((command, args) => {
      if (command === 'git' && args[0] === 'diff' && args[1] === '--binary') {
        dirtyReads += 1;
        // Reads: 1 the identity, 2 the pre-lock recheck, 3 the post-run
        // recheck — the worktree changes between the pre-lock recheck and
        // the reviewer's completion.
        return okResult(dirtyReads >= 3 ? 'patch-after-drift' : 'patch');
      }
      if (command === 'coderabbit')
        return { exitCode: 0, stdout: NDJSON_OK, stderr: '', timedOut: false };
      return undefined;
    });
    const result = await cycleReview(effects, stubScanner())({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('could not run to a recorded outcome');
      expect(result.reason).toContain('working-tree diff changed');
    }
    expect(effects.openLedger(BRANCH).load().records).toHaveLength(0);
  });
});
