import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GitAccountingRepository } from '../../../src/adapters/crq/backfillAccounting.js';
import { GitSubjectRepository } from '../../../src/adapters/crq/backfillSubjects.js';
import { buildSynthetic } from '../../../src/adapters/crq/buildSynthetic.js';
import { runGitIn } from '../../../src/adapters/crq/publishSource.js';
import { LedgerIntegrityError } from '../../../src/policy/crq/ledger.js';
import { JsonNumber } from '../../../src/policy/crq/jsonValue.js';
import { PythonJsonError } from '../../../src/policy/crq/pythonJson.js';
import { PyError } from '../../../src/policy/crq/pyCompat.js';
import type { MeasureGit } from '../../../src/queue-runner/measureMerged.js';

/**
 * Replays the Python 3.14 oracle (apps/crq-python/build_synthetic_vectors.py):
 * the production `crq.build_synthetic` over throwaway work + bare-origin
 * repositories. Each scenario's history ops are replayed here into a fresh temp
 * repository with the same fixed identities and dates, so the returned object
 * ids, every `refs/crq` ref, the written commits and the item record all compare
 * exactly. A raised exception compares by class, and by message except for
 * git-failure classes, whose text is git's stderr.
 */

const FIXTURE = new URL(
  '../../../apps/crq-python/fixtures/crq-build-synthetic/cases.json',
  import.meta.url,
);

type Op = Record<string, unknown> & { op: string };
interface Result {
  readonly outcome: {
    ok?: { base: string; head: string; paths: number };
    raises?: string;
    message?: string;
  };
  readonly refs: string[];
  readonly subject?: Record<string, { commit: string; files: string[] }>;
  readonly item_unchanged: boolean;
}
interface Case {
  readonly name: string;
  readonly spec: {
    history: string;
    target: unknown;
    item: unknown;
    identity_paths: string[] | null;
    preseed: { label: string; rev: string }[] | null;
    runs: number;
  };
  readonly target: string;
  readonly preseed: string[];
  readonly results: Result[];
}
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  histories: Record<string, Op[]>;
  cases: Case[];
};

const IDENT: Record<string, string> = {
  GIT_AUTHOR_NAME: 'fx',
  GIT_AUTHOR_EMAIL: 'fx@localhost',
  GIT_COMMITTER_NAME: 'fx',
  GIT_COMMITTER_EMAIL: 'fx@localhost',
  GIT_AUTHOR_DATE: '2026-11-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-11-01T00:00:00Z',
};

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return { ...env, ...IDENT, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
}

function sh(work: string, ...args: string[]): string {
  return execFileSync('git', ['-C', work, ...args], { env: gitEnv(), encoding: 'utf8' }).trim();
}

function play(work: string, ops: readonly Op[]): void {
  for (const op of ops) {
    switch (op.op) {
      case 'write': {
        const file = join(work, op.path as string);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, op.text as string);
        break;
      }
      case 'writeb':
        writeFileSync(
          Buffer.concat([Buffer.from(`${work}/`), Buffer.from(op.path_hex as string, 'hex')]),
          op.text as string,
        );
        break;
      case 'rm':
        rmSync(join(work, op.path as string));
        break;
      case 'chmod':
        chmodSync(join(work, op.path as string), 0o755);
        break;
      case 'symlink':
        symlinkSync(op.to as string, join(work, op.path as string));
        break;
      case 'commit':
        sh(work, 'add', '-A');
        sh(work, 'commit', '-q', '-m', op.msg as string);
        break;
      case 'git':
        sh(work, ...(op.args as string[]));
        break;
      default:
        throw new Error(`unknown op ${op.op}`);
    }
  }
}

/** Decode the emitter's lossless tags: `{"$int": "..."}` and `{"$float": "..."}`. */
function decode(value: unknown, work: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => decode(entry, work));
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  if (typeof record.$int === 'string') return BigInt(record.$int);
  if (typeof record.$float === 'string') return JsonNumber.float(Number(record.$float));
  if (typeof record.$rev === 'string') {
    let sha = sh(work, 'rev-parse', `${record.$rev}^{commit}`);
    if (typeof record.slice === 'number') sha = sha.slice(0, record.slice);
    return record.upper === true ? sha.toUpperCase() : sha;
  }
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, decode(v, work)]));
}

/** `crq.git`: stdout stripped, a RuntimeError on a non-zero exit. */
function measureGit(work: string): MeasureGit {
  const run = runGitIn(work);
  return {
    git: async (args, check = true) => {
      const call = await run(args);
      if (check && call.code !== 0) {
        throw new PyError('RuntimeError', `git ${args.slice(0, 5).join(' ')} exit ${call.code}`);
      }
      return Buffer.from(call.stdout).toString('utf8').trim();
    },
    pathExists: async () => true,
  };
}

function errorClass(error: unknown): { raises: string; message: string } {
  if (error instanceof PyError) return { raises: error.pythonError, message: error.message };
  if (error instanceof LedgerIntegrityError) {
    return { raises: 'IntegrityError', message: error.message };
  }
  if (error instanceof PythonJsonError)
    return { raises: error.pythonError, message: error.message };
  if (error instanceof Error && /^(Accounting|Subject)GitError$/.test(error.name)) {
    return { raises: 'CalledProcessError', message: error.message };
  }
  throw error;
}

const GIT_TEXT = new Set(['RuntimeError', 'CalledProcessError']);
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function snapshot(work: string, base: string, head: string) {
  const refs = sh(work, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/crq')
    .split('\n')
    .filter(Boolean);
  const subject: Record<string, { commit: string; files: string[] }> = {};
  for (const [label, sha] of [
    ['base', base],
    ['head', head],
  ] as const) {
    subject[label] = {
      commit: sh(work, 'cat-file', '-p', sha),
      files: sh(
        work,
        'ls-tree',
        '-r',
        '--format=%(objectmode) %(objectname) %(path)',
        sha,
        '--',
        '.',
      )
        .split('\n')
        .filter(Boolean),
    };
  }
  return { refs, subject };
}

describe('buildSynthetic against the Python oracle', () => {
  it('has unique case names and covers success and error classes', () => {
    const names = fixture.cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    const raised = new Set(fixture.cases.flatMap((c) => c.results.map((r) => r.outcome.raises)));
    for (const klass of [
      'IntegrityError',
      'KeyError',
      'TypeError',
      'AttributeError',
      'RuntimeError',
    ]) {
      expect(raised.has(klass)).toBe(true);
    }
    expect(fixture.cases.some((c) => c.results.some((r) => r.outcome.ok !== undefined))).toBe(true);
  });

  for (const testCase of fixture.cases) {
    it(testCase.name, async () => {
      const root = mkdtempSync(join(tmpdir(), 'cq-build-synthetic-'));
      roots.push(root);
      const origin = join(root, 'origin.git');
      const work = join(root, 'work');
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: gitEnv() });
      execFileSync('git', ['init', '-q', '-b', 'main', work], { env: gitEnv() });
      sh(work, 'remote', 'add', 'origin', origin);
      play(work, fixture.histories[testCase.spec.history] as Op[]);

      const target = decode(testCase.spec.target, work);
      const item = decode(testCase.spec.item, work) as Record<string, unknown> | null;
      const before = structuredClone(item);
      if (typeof target === 'string' && /^[0-9a-f]{40}$/.test(target)) {
        expect(target).toBe(testCase.target);
      }
      if (testCase.spec.preseed !== null) {
        for (const line of testCase.preseed) {
          const [ref, sha] = line.split(' ') as [string, string];
          sh(work, 'update-ref', ref, sha);
        }
      }

      const runGit = runGitIn(work);
      const accounting = new GitAccountingRepository({ repo: work, runGit });
      const subjects = new GitSubjectRepository({ runGit, accounting });
      const deps = { git: measureGit(work), accounting, subjects };

      for (const expected of testCase.results) {
        let outcome: Result['outcome'];
        try {
          const done = await buildSynthetic(deps, item, target as string);
          outcome = { ok: done };
        } catch (error) {
          outcome = errorClass(error);
        }
        if (expected.outcome.ok !== undefined) {
          expect(outcome).toEqual(expected.outcome);
        } else {
          expect(outcome.raises).toBe(expected.outcome.raises);
          if (!GIT_TEXT.has(expected.outcome.raises ?? '')) {
            expect(outcome.message).toBe(expected.outcome.message);
          }
        }
        const snap = snapshot(work, outcome.ok?.base ?? 'HEAD', outcome.ok?.head ?? 'HEAD');
        expect(snap.refs).toEqual(expected.refs);
        if (expected.subject !== undefined) expect(snap.subject).toEqual(expected.subject);
        expect(structuredClone(item)).toEqual(before);
        expect(expected.item_unchanged).toBe(true);
      }
    });
  }
});
