// `GitCoverageRepository`: the accounting surface the coverage fold needs,
// over a scripted git seam. Every reply is a recorded git invocation, so these
// tests pin the exact argv and the first-parent/rename/blame rules Python's
// `backfill_accounting.Repository` implements.
//
// What is NOT here: real object materialization. The end-to-end credit path
// (verify_review over a restored bundle) is exercised by the publisher route's
// real-git suite; this file pins the git-read semantics that route depends on
// and the invocation-scoped memo that keeps a failing restore from repeating.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { JsonObject, parseJsonValue, type JsonValue } from '../../../src/policy/crq/jsonValue.js';
import { gitCoverageRepository } from '../../../src/adapters/crq/coverageSource.js';
import type { GitCall, RunGit } from '../../../src/adapters/crq/ledgerGit.js';

const encoder = new TextEncoder();

interface CommitModel {
  readonly parent: string | null;
  /** name -> blob (mode is always a regular file in these fixtures). */
  readonly entries: Readonly<Record<string, string>>;
  /** `git diff --name-status parent commit`: [status, source, destination?]. */
  readonly changes: readonly (readonly [string, string, string?])[];
}

interface BlameModel {
  readonly origin: string;
  readonly originalLine: number;
  readonly filename: string;
  readonly content: string;
}

interface Reply {
  readonly code?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

type Script = (args: readonly string[]) => Reply | undefined;

function reply(value: Reply): GitCall {
  return {
    args: [],
    code: value.code ?? 0,
    stdout: encoder.encode(value.stdout ?? ''),
    stderr: value.stderr ?? '',
  };
}

function runner(script: Script): { runGit: RunGit; calls: string[][] } {
  const calls: string[][] = [];
  const runGit: RunGit = async (args) => {
    calls.push([...args]);
    const value = script(args);
    if (value === undefined) return reply({ code: 1, stderr: `unexpected: ${args.join(' ')}` });
    return reply(value);
  };
  return { runGit, calls };
}

function lsTree(entries: Readonly<Record<string, string>>): string {
  return Object.keys(entries)
    .sort()
    .map((name) => `100644 blob ${entries[name] as string}\t${name}\0`)
    .join('');
}

function nameStatus(changes: readonly (readonly [string, string, string?])[]): string {
  return changes.map((row) => row.join('\0')).join('\0') + '\0';
}

function blameOutput(rows: readonly BlameModel[]): string {
  return rows
    .map((row, index) => {
      const data =
        `${row.origin} ${row.originalLine} ${index + 1}\n` +
        'author fixture\n' +
        'author-mail <fixture@example.invalid>\n' +
        `filename ${row.filename}\n` +
        `\t${row.content}\n`;
      return data;
    })
    .join('');
}

const BLOB_A = 'a'.repeat(40);
const BLOB_B = 'b'.repeat(40);
const C1 = '1'.repeat(40);
const C2 = '2'.repeat(40);

/** Two commits: C2 renames src/old.ts to src/new.ts (exact rename). */
function renameModel(): Script {
  const commits: Record<string, CommitModel> = {
    [C1]: { parent: null, entries: { 'src/old.ts': BLOB_A }, changes: [] },
    [C2]: {
      parent: C1,
      entries: { 'src/new.ts': BLOB_A },
      changes: [['R100', 'src/old.ts', 'src/new.ts']],
    },
  };
  const blames: Record<string, readonly BlameModel[]> = {
    [`${C1}\u0000src/old.ts`]: [
      { origin: C1, originalLine: 1, filename: 'src/old.ts', content: 'one' },
      { origin: C1, originalLine: 2, filename: 'src/old.ts', content: 'two' },
    ],
    [`${C2}\u0000src/new.ts`]: [
      { origin: C1, originalLine: 1, filename: 'src/old.ts', content: 'one' },
      { origin: C2, originalLine: 2, filename: 'src/new.ts', content: 'two' },
    ],
  };
  return (args) => {
    const [command, ...rest] = args;
    if (command === 'rev-parse' && rest.length === 1) {
      const spec = rest[0] as string;
      if (spec.endsWith('^1')) {
        const commit = spec.slice(0, -2);
        const parent = commits[commit]?.parent;
        return parent === null || parent === undefined
          ? { code: 1, stderr: 'no parent' }
          : { stdout: `${parent}\n` };
      }
      if (spec.endsWith('^{commit}')) {
        const commit = spec.slice(0, -'^{commit}'.length);
        return commits[commit] === undefined
          ? { code: 1, stderr: 'unknown commit' }
          : { stdout: `${commit}\n` };
      }
      return undefined;
    }
    if (command === 'ls-tree' && args[1] === '-r' && args[2] === '-z') {
      const commit = args[3] as string;
      const model = commits[commit];
      return model === undefined
        ? { code: 1, stderr: 'unknown tree' }
        : { stdout: lsTree(model.entries) };
    }
    if (command === 'rev-list' && args[1] === '--first-parent') {
      return { stdout: `${C2}\n${C1}\n` };
    }
    if (command === 'diff') {
      const commit = args[args.length - 1] as string;
      const model = commits[commit];
      return model === undefined
        ? { code: 1, stderr: 'unknown diff' }
        : { stdout: nameStatus(model.changes) };
    }
    if (command === 'blame') {
      const target = args[args.indexOf('--') - 1] as string;
      const name = args[args.indexOf('--') + 1] as string;
      const rows = blames[`${target}\u0000${name}`];
      return rows === undefined ? { code: 1, stderr: 'no blame' } : { stdout: blameOutput(rows) };
    }
    return undefined;
  };
}

describe('GitCoverageRepository.lineage', () => {
  test('follows one exact rename and returns the current name', async () => {
    const { runGit } = runner(renameModel());
    const repository = gitCoverageRepository(runGit);
    expect(await repository.lineage(C1, C2, 'src/old.ts')).toBe('src/new.ts');
    // Unknown paths and non-ancestors are not evidence of lineage.
    expect(await repository.lineage(C1, C2, 'src/missing.ts')).toBeNull();
    expect(await repository.lineage(C2, C1, 'src/new.ts')).toBeNull();
  });

  test('a non-exact rename, a copy or an ambiguous blob ends inherited credit', async () => {
    const build =
      (
        status: string,
        entriesBefore: Record<string, string>,
        entriesAfter: Record<string, string>,
      ): Script =>
      (args) => {
        const [command, ...rest] = args;
        if (command === 'rev-parse' && rest.length === 1) {
          const spec = rest[0] as string;
          // `entries()` resolves `<commit>^{commit}`; answering that with C2
          // would read C2's tree for C1 and pass every negative case for the
          // wrong reason (the source path would simply be missing).
          if (spec.endsWith('^{commit}')) {
            return { stdout: `${spec.slice(0, -'^{commit}'.length)}\n` };
          }
          if (spec.endsWith('^1')) return { stdout: `${C1}\n` };
          return undefined;
        }
        if (command === 'ls-tree') {
          const commit = args[3] as string;
          return { stdout: lsTree(commit === C1 ? entriesBefore : entriesAfter) };
        }
        if (command === 'rev-list') return { stdout: `${C2}\n${C1}\n` };
        if (command === 'diff') {
          const row: readonly [string, string, string?] =
            status.startsWith('R') || status.startsWith('C')
              ? [status, 'src/old.ts', 'src/new.ts']
              : [status, 'src/old.ts'];
          return {
            stdout: nameStatus([row]),
          };
        }
        return undefined;
      };
    for (const status of ['R090', 'C100', 'D']) {
      const repository = gitCoverageRepository(
        runner(build(status, { 'src/old.ts': BLOB_A }, { 'src/new.ts': BLOB_A })).runGit,
      );
      expect(await repository.lineage(C1, C2, 'src/old.ts')).toBeNull();
    }
    // An exact rename of a blob that appears twice on either side is ambiguous.
    const duplicated = gitCoverageRepository(
      runner(
        build('R100', { 'src/old.ts': BLOB_A, 'src/other.ts': BLOB_A }, { 'src/new.ts': BLOB_A }),
      ).runGit,
    );
    expect(await duplicated.lineage(C1, C2, 'src/old.ts')).toBeNull();
    const duplicatedAfter = gitCoverageRepository(
      runner(
        build('R100', { 'src/old.ts': BLOB_A }, { 'src/new.ts': BLOB_A, 'src/other.ts': BLOB_A }),
      ).runGit,
    );
    expect(await duplicatedAfter.lineage(C1, C2, 'src/old.ts')).toBeNull();
  });

  test('a chained rename across two rows of one commit follows Python', async () => {
    // Python's `_lineage` walks every row of the commit and reassigns
    // `current`; a later row of the same diff can therefore match the renamed
    // path again (`for status, source, destination in changes: if source !=
    // current: continue ... current = destination`). Both renames here are
    // individually unique and exact, so Python maps a -> c. The port keeps
    // that behaviour deliberately: it is the oracle, not a destination we
    // silently re-derive.
    const C3 = '3'.repeat(40);
    const script: Script = (args) => {
      const [command, ...rest] = args;
      if (command === 'rev-parse' && rest.length === 1) {
        const spec = rest[0] as string;
        if (spec.endsWith('^{commit}')) {
          return { stdout: `${spec.slice(0, -'^{commit}'.length)}\n` };
        }
        if (spec.endsWith('^1')) return { stdout: `${C2}\n` };
        return undefined;
      }
      if (command === 'ls-tree') {
        const commit = args[3] as string;
        if (commit === C2) {
          return { stdout: lsTree({ 'src/a.ts': BLOB_A, 'src/b.ts': BLOB_B }) };
        }
        if (commit === C3) {
          return { stdout: lsTree({ 'src/b.ts': BLOB_A, 'src/c.ts': BLOB_B }) };
        }
        return undefined;
      }
      if (command === 'rev-list') return { stdout: `${C3}\n${C2}\n` };
      if (command === 'diff') {
        return {
          stdout: nameStatus([
            ['R100', 'src/a.ts', 'src/b.ts'],
            ['R100', 'src/b.ts', 'src/c.ts'],
          ]),
        };
      }
      return undefined;
    };
    const repository = gitCoverageRepository(runner(script).runGit);
    expect(await repository.lineage(C2, C3, 'src/a.ts')).toBe('src/c.ts');
  });

  test('a non-ASCII rename name is decoded as UTF-8, like the tree entries', async () => {
    // Python's `_lineage_step` decodes name-status paths as UTF-8; the tree
    // parser does the same. A Latin-1 read of these bytes would mojibake the
    // destination and the final `entries(new)` lookup would miss it.
    const script: Script = (args) => {
      const [command, ...rest] = args;
      if (command === 'rev-parse' && rest.length === 1) {
        const spec = rest[0] as string;
        if (spec.endsWith('^{commit}')) {
          return { stdout: `${spec.slice(0, -'^{commit}'.length)}\n` };
        }
        if (spec.endsWith('^1')) return { stdout: `${C1}\n` };
        return undefined;
      }
      if (command === 'ls-tree') {
        const commit = args[3] as string;
        if (commit === C1) return { stdout: lsTree({ 'src/café.ts': BLOB_A }) };
        if (commit === C2) return { stdout: lsTree({ 'src/renamed.ts': BLOB_A }) };
        return undefined;
      }
      if (command === 'rev-list') return { stdout: `${C2}\n${C1}\n` };
      if (command === 'diff') {
        return { stdout: nameStatus([['R100', 'src/café.ts', 'src/renamed.ts']]) };
      }
      return undefined;
    };
    const repository = gitCoverageRepository(runner(script).runGit);
    expect(await repository.lineage(C1, C2, 'src/café.ts')).toBe('src/renamed.ts');
  });
});

describe('GitCoverageRepository.carry', () => {
  test('maps only signatures unique on both sides', async () => {
    const { runGit, calls } = runner(renameModel());
    const repository = gitCoverageRepository(runGit);
    const [mapped, lines] = await repository.carry(C1, C2, 'src/old.ts', new Set([1, 2]));
    expect(mapped).toBe('src/new.ts');
    // Line 1 keeps its (origin, original line, filename, content) signature and
    // moves to new line 1; line 2 was rewritten in C2 and is dropped.
    expect([...lines]).toEqual([1]);
    // Blame argv is pinned (Python BLAME_OPTIONS) and the mapped path is read.
    expect(calls).toContainEqual([
      'blame',
      '--line-porcelain',
      '--encoding=UTF-8',
      C1,
      '--',
      'src/old.ts',
    ]);
    expect(calls).toContainEqual([
      'blame',
      '--line-porcelain',
      '--encoding=UTF-8',
      C2,
      '--',
      'src/new.ts',
    ]);
  });

  test('a repeated signature on either side is not carried', async () => {
    const duplicated: Script = (args) => {
      if (args[0] === 'blame') {
        // One signature (same origin, original line, filename and content)
        // occurring twice: no unique position to map onto.
        const row = { origin: C1, originalLine: 1, filename: 'src/old.ts', content: 'same' };
        return { stdout: blameOutput([row, row]) };
      }
      return renameModel()(args);
    };
    const repository = gitCoverageRepository(runner(duplicated).runGit);
    const [mapped, lines] = await repository.carry(C1, C2, 'src/old.ts', new Set([1]));
    expect(mapped).toBe('src/new.ts');
    expect(lines.size).toBe(0);
  });

  test('no lineage means no carried credit', async () => {
    const repository = gitCoverageRepository(runner(renameModel()).runGit);
    expect(await repository.carry(C1, C2, 'src/missing.ts', new Set([1]))).toEqual([
      null,
      new Set<number>(),
    ]);
  });
});

describe('GitCoverageRepository.fold', () => {
  const fixture = parseJsonValue(
    readFileSync(
      new URL(
        '../../../apps/crq-python/fixtures/crq-notify-coverage-b1/vectors.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as JsonObject;
  const families = fixture.get('families');
  if (!Array.isArray(families)) throw new Error('fixture has no families');
  const coverageFamily = families
    .map((entry) => entry as JsonObject)
    .find((entry) => entry.get('family') === 'coverage');
  if (coverageFamily === undefined) throw new Error('fixture has no coverage family');
  const fullCase = (coverageFamily.get('cases') as JsonValue[])
    .map((entry) => entry as JsonObject)
    .find((entry) => entry.get('name') === 'refresh-full');
  if (fullCase === undefined) throw new Error('fixture has no refresh-full case');
  const events = (fullCase.get('input') as JsonObject).get('events') as JsonValue[];
  const review = events[0] as JsonObject;

  test('a non-creditable record credits nothing and is not a gap', async () => {
    const repository = gitCoverageRepository(runner(renameModel()).runGit);
    repository.beginInvocation();
    const covered = new Map<string, Set<number>>();
    const gaps: JsonValue[] = [];
    const stateEvent = new JsonObject([
      ['id', 'x'],
      ['event_type', 'job-state'],
      ['payload', new JsonObject([])],
    ]);
    await repository.fold('a'.repeat(40), [stateEvent], async () => {}, covered, gaps);
    expect([...covered.entries()]).toEqual([]);
    expect(gaps).toEqual([]);
  });

  test('a failing artifact restore is one gap per invocation, not per target', async () => {
    const { runGit } = runner(renameModel());
    const repository = gitCoverageRepository(runGit);
    let verifications = 0;
    const verify = async (): Promise<void> => {
      verifications += 1;
      // The fixture's artifact location is outside every durable store.
      throw new Error('artifact outside configured durable store');
    };
    repository.beginInvocation();
    const gaps: JsonValue[] = [];
    for (const target of ['a'.repeat(40), 'b'.repeat(40)]) {
      await repository.fold(target, [review], verify, new Map(), gaps);
    }
    expect(verifications).toBe(1);
    expect(gaps).toHaveLength(2);
    const reason = (gaps[0] as JsonObject).get('reason');
    expect(reason).toBe('artifact outside configured durable store');
    // A new invocation retries: Python's `begin_invocation` forgets failures.
    repository.beginInvocation();
    const retried: JsonValue[] = [];
    await repository.fold('c'.repeat(40), [review], verify, new Map(), retried);
    expect(verifications).toBe(2);
    expect(retried).toHaveLength(1);
  });

  test('entries are memoized per invocation and decoded through ls-tree', async () => {
    const { runGit, calls } = runner(renameModel());
    const repository = gitCoverageRepository(runGit);
    repository.beginInvocation();
    const first = await repository.entries(C1);
    const second = await repository.entries(C1);
    expect(first).toBe(second);
    expect(first.get('src/old.ts')).toEqual({ mode: '100644', blob: BLOB_A });
    expect(calls.filter((args) => args[0] === 'ls-tree')).toHaveLength(1);
    repository.beginInvocation();
    await repository.entries(C1);
    expect(calls.filter((args) => args[0] === 'ls-tree')).toHaveLength(2);
  });
});
