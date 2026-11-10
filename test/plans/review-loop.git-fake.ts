// Split provenance: test/plans/review-loop.helpers.ts was split by subject;
// this module carries the routed git fake (prWorktree's model: a reusable
// on-label tree, the per-stage head reads and pushes).
import { join } from 'node:path';
import type { GhFn } from '../../src/adapters/forge-github/gh.js';
import { ok } from './review-loop.argv.js';
import {
  AFTER_SHA,
  BEFORE_SHA,
  HEAD_REF,
  LABEL,
  SHA,
  type LoopWorld,
} from './review-loop.fixtures.js';

/** The routed git fake: prWorktree's model (a reusable on-label tree) + pushes. */
/**
 * The worktree tree the fake git serves by default (path → line count): the
 * three anchored files, an empty file, and a huge one (-1: over the
 * evidence size bound, never meant to be read).
 */
export const DEFAULT_WORLD_FILES: Record<string, number> = {
  'src/a.ts': 20,
  'src/b.ts': 20,
  'src/c.ts': 20,
  'src/empty.ts': 0,
  'src/huge.ts': -1,
};

export const fakeGit = (
  world: LoopWorld,
  log: string[][],
  worktreePath: string,
  opts: { ownershipIdentityReads?: number } = {},
): GhFn => {
  /** The tree at `<sha>:<path>`'s sha: a per-commit override, else the world's files. */
  const treeAt = (object: string): Record<string, number> =>
    world.filesAt?.[object.slice(0, 40)] ?? world.files ?? DEFAULT_WORLD_FILES;
  let pushCount = 0;
  let publishedTip: string | undefined;
  let worktreeHeadReads = 0;
  return async (args) => {
    log.push(args);
    // prWorktree composes every git argv with a leading '-C <path>' — the
    // subcommand starts at index 2 in that form, at 0 without it.
    const rest = args[0] === '-C' ? args.slice(2) : args;
    if (rest[0] === 'rev-parse' && rest.includes('--git-common-dir')) return ok('/fake/git-dir\n');
    if (rest[0] === 'rev-parse' && rest[1] === '--absolute-git-dir') {
      return ok(`${join(worktreePath, '.git')}\n`);
    }
    if (rest[0] === 'remote' && rest[1] === 'get-url')
      return ok(
        world.changePushurlAfterFirstPush && pushCount > 0
          ? '/fake/changed.git\n'
          : '/fake/origin.git\n',
      );
    if (rest[0] === 'fetch' && rest[1] === 'origin') {
      return ok('');
    }
    if (rest[0] === 'rev-parse' && (rest[1] ?? '').startsWith('refs/cq-review/pr-')) {
      return ok(
        `${world.worktreeHead ?? (world.worktreeFollowsOrigin === true ? world.sha : SHA)}\n`,
      );
    }
    // The per-item resolve gate's mechanical checks (finding 2): a sha is
    // verifiable exactly when the world knows it.
    if (rest[0] === 'rev-parse' && rest[1] === '--verify') {
      if (rest[2] === 'HEAD^{commit}')
        return ok(
          `${world.executionHead ?? world.worktreeHead ?? (world.worktreeFollowsOrigin ? world.sha : SHA)}\n`,
        );
      const sha = (rest[2] ?? '').replace(/\^\{commit\}$/, '');
      if (world.knownShas.includes(sha)) {
        return ok(`${sha}\n`);
      }
      return { code: 128, stdout: '', stderr: `fatal: Needed a single revision: ${sha}` };
    }
    if (rest[0] === 'merge-base' && rest[1] === '--is-ancestor') {
      const from = rest[2] ?? '';
      const to = rest[3] ?? '';
      // The not-ancestor stage driver (round-2 low): a declared sha's
      // HEAD-ancestry is refused before the permissive pass conditions.
      if (world.ancestorFails !== undefined && world.ancestorFails.includes(from)) {
        return { code: 128, stdout: '', stderr: 'fatal: not an ancestor relation in this world' };
      }
      // Two-ref ancestry: 0 when (a) FROM is a served origin head (either —
      // the stage-5 publish may already have moved it; SHA too, since
      // resolvePrWorktree fetched it — the observed base, codex P2) and TO
      // is a known new commit (the strict-descendant check), or (b) FROM is
      // a known new commit and TO is HEAD (the pushed-head check).
      const servedHead = from === BEFORE_SHA || from === AFTER_SHA || from === SHA;
      const descendantOfHead = servedHead && world.knownShas.includes(to);
      const inPushedHead = world.knownShas.includes(from) && (to === 'HEAD' || to === from);
      if (descendantOfHead || inPushedHead) {
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 128, stdout: '', stderr: 'fatal: not an ancestor relation in this world' };
    }
    if (rest[0] === 'rev-list') {
      // The loop's range accountability (round 2): `rev-list <before>..HEAD`
      // lists the commits the fix run added — the world declares them
      // (default: the advanced tip alone). prWorktree's `rev-list --count`
      // guard never runs in these worlds (the reuse path skips it). When
      // revListByBase is set, the answer keys on the BASE the loop passes
      // (the stale-snapshot pin, codex P2).
      if (world.revListByBase !== undefined) {
        const base = (rest[1] ?? '').replace(/\.\.HEAD$/, '');
        const shas = world.revListByBase[base] ?? [];
        return ok(`${shas.join('\n')}${shas.length > 0 ? '\n' : ''}`);
      }
      const advanced = world.worktreeAdvancesAt !== undefined;
      const shas = advanced
        ? (world.revListShas ?? [world.worktreeAdvancesTo ?? '4444'.repeat(10)])
        : [];
      return ok(`${shas.join('\n')}${shas.length > 0 ? '\n' : ''}`);
    }
    if (rest[0] === 'diff' && rest.includes('--quiet')) {
      // Admission's worktree/index checks differ from the commit-range evidence gate.
      const range = rest.some((arg) => arg.includes('..'));
      return { code: range ? (world.diffCode ?? 1) : world.dirty ? 1 : 0, stdout: '', stderr: '' };
    }
    if (rest[0] === 'ls-files' && rest.includes('--others')) return ok('');
    if (rest[0] === 'symbolic-ref' && rest[1] === 'HEAD') return ok(`refs/heads/${LABEL}\n`);
    if (rest[0] === 'log' && rest[1] === '-1') {
      // Per-item attribution (round-3 finding 3): the commit message the
      // world carries for this sha.
      return ok(world.commitMessages[rest[3] ?? ''] ?? '');
    }
    if (rest[0] === 'worktree' && rest[1] === 'list') {
      return ok(`worktree ${worktreePath}\nHEAD ${SHA}\nbranch refs/heads/${LABEL}\n\n`);
    }
    if (rest[0] === 'rev-parse' && rest[1] === '--abbrev-ref') {
      return ok(`${LABEL}\n`);
    }
    if (rest[0] === 'rev-parse' && rest[1] === 'HEAD') {
      if (args[1] === worktreePath) {
        // The loop's per-stage worktree HEAD reads (slice 9 item 2): the
        // head advances after the configured read count. Reads after
        // headReadFailsAfter FAIL, as does the single headReadFailsAt read
        // (round 3 + final bot slice P1: drives the fail-closed
        // head-unreadable gate for both its shapes).
        // Ownership rechecks the selected HEAD twice before the loop's stage
        // boundaries. Those probes observe the same pre-fix snapshot; scripted
        // transitions/faults remain attached to the documented stage reads.
        const identityReads = opts.ownershipIdentityReads ?? 0;
        worktreeHeadReads += 1;
        const stageRead = Math.max(1, worktreeHeadReads - identityReads);
        if (
          (world.headReadFailsAfter !== undefined && stageRead > world.headReadFailsAfter) ||
          world.headReadFailsAt === stageRead
        ) {
          return { code: 128, stdout: '', stderr: 'fatal: unreadable HEAD' };
        }
        const advanced =
          world.worktreeAdvancesAt !== undefined && stageRead > world.worktreeAdvancesAt;
        const base = world.worktreeHead ?? (world.worktreeFollowsOrigin === true ? world.sha : SHA);
        return ok(`${advanced ? (world.worktreeAdvancesTo ?? '4444'.repeat(10)) : base}\n`);
      }
      return ok(`${SHA}\n`);
    }
    if (rest[0] === 'status' && rest[1] === '--porcelain') {
      return world.dirty === true ? ok(' M src/a.ts\n') : ok('');
    }
    if (rest[0] === 'cat-file' && rest[1] === '-s' && /^[0-9a-f]{40}:/.test(rest[2] ?? '')) {
      const lines = treeAt(rest[2] ?? '')[(rest[2] ?? '').slice(41)];
      // Each served line is 'line N\n': about 8 bytes; -1 marks a huge blob.
      return lines === undefined
        ? { code: 128, stdout: '', stderr: 'fatal: not a valid object\n' }
        : ok(`${String(lines < 0 ? 10_000_000 : lines * 8)}\n`);
    }
    if (rest[0] === 'cat-file' && rest[1] === '-t' && /^[0-9a-f]{40}:/.test(rest[2] ?? '')) {
      const path = (rest[2] ?? '').slice(41);
      const files = Object.keys(treeAt(rest[2] ?? ''));
      return files.includes(path)
        ? ok('blob\n')
        : files.some((file) => file.startsWith(`${path}/`))
          ? ok('tree\n')
          : { code: 128, stdout: '', stderr: `fatal: path '${path}' does not exist\n` };
    }
    if (rest[0] === 'show' && /^[0-9a-f]{40}:/.test(rest[1] ?? '')) {
      const path = (rest[1] ?? '').slice(41);
      const files = treeAt(rest[1] ?? '');
      const lines = files[path];
      const entries = Object.keys(files).filter((file) => file.startsWith(`${path}/`));
      // Like git: showing a TREE succeeds and lists its entries.
      if (lines === undefined && entries.length > 0) {
        return ok(
          `tree ${rest[1] ?? ''}\n\n${entries.map((file) => file.slice(path.length + 1)).join('\n')}\n`,
        );
      }
      return lines === undefined
        ? { code: 128, stdout: '', stderr: `fatal: path '${path}' does not exist\n` }
        : lines <= 0
          ? ok('')
          : ok(Array.from({ length: lines }, (_, i) => `line ${String(i + 1)}`).join('\n') + '\n');
    }
    if (rest[0] === 'ls-remote' && world.loseFirstPushAcknowledgement && publishedTip)
      return ok(`${publishedTip}\trefs/heads/${HEAD_REF}\n`);
    if (rest[0] === 'push') {
      pushCount += 1;
      if (world.pushFailAt !== undefined && pushCount >= world.pushFailAt) {
        return { code: 1, stdout: '', stderr: 'fatal: remote rejected the push\n' };
      }
      // KEYED (finding 1): only a push of the PR's REAL head moves the
      // served origin state — a push of the internal cq-review label must
      // NOT (a stray label branch and a phantom progress signal).
      if (
        world.advanceOnPush &&
        (rest.at(-1) === `HEAD:${HEAD_REF}` || rest.at(-1)?.endsWith(`:refs/heads/${HEAD_REF}`))
      ) {
        world.sha = AFTER_SHA;
        publishedTip = rest.at(-1)?.split(':')[0];
      }
      if (world.loseFirstPushAcknowledgement && pushCount === 1)
        return { code: 124, stdout: '', stderr: 'push acknowledgement lost' };
      return ok('');
    }
    return { code: 1, stdout: '', stderr: `unexpected git argv: ${args.join(' ')}` };
  };
};
