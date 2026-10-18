// PR lane — `pr.open`: open (or update in place) the PR FROM the readiness
// record (strategy §3, pr.open row; §2.1: the PR is not development state —
// the first quality cycle ran in the worktree and yielded a record, and a
// PR is opened from that record).
//
// THE REMOTE IS THE AUTHORITY FOR WHAT A PR WOULD CARRY: before ANY
// mutation the op reads the branch's REMOTE head (`git ls-remote origin
// refs/heads/<branch>`) and requires it to EQUAL the reviewed local head.
// A branch that was never pushed, or whose remote head differs from the
// reviewed head, is a needs-human refusal — the readiness record describes
// ONE head, and posting it for (or opening a PR from) a different head
// would be evidence about a state nobody reviewed. The worktree identity is
// also RE-VALIDATED immediately before the gh mutation (the record and gh
// reads take time; a drift between assembly and mutation must abort, never
// post).
//
// WHAT IT DOES: assemble the author-tier readiness record (the same core
// dev.ready uses — not-ready is a needs-human refusal naming the gaps,
// never a PR), render the record into the PR body under a MANAGED SECTION
// (the tracker-body compose protocol: updating an existing PR's body
// replaces only this section and preserves all other prose), open the PR
// against the intended target branch (or adopt the existing OPEN one and
// refresh its body — never a second PR for the same head), and post the
// dispositions as a PR comment so the author evidence is reachable where
// the next reader looks.
//
// THE TIER IS MARKED IN THE ARTIFACT: the rendered body carries the author
// evidence caveat verbatim — a claim produced in the worktree, never
// verification (strategy §2.4; verification is green required CI at the
// exact head plus the reviewer bots' PR review).
import { createHash } from 'node:crypto';
import type { Op } from '../../kernel/types.js';
import type { DevEffects } from '../dev/effects.js';
import { branchFromRevParse, gitOut, requireGitOut, requireGitOutRaw } from '../dev/effects.js';
import type { DevCheckRecord, DevLedgerFile, DevReadinessRecord } from '../dev/record.js';
import {
  AUTHOR_EVIDENCE_CAVEAT,
  assembleReadiness,
  DEFAULT_DEV_TARGET,
  objectInputFault,
  repoRootFault,
} from '../dev/record.js';
import { composeSection, mdSafe } from './assemblePrs.js';
import type { PrEffects } from './assemblePrs.js';

/** Git read wall-clock cap. */
export const GIT_TIMEOUT_MS = 60 * 1000;

/** Input of the `pr.open` op (plain JSON; the registry schema mirrors it). */
export interface PrOpenInput {
  /** Repository the PR is opened from (the gh and git effects bind to it). */
  repoRoot: string;
  /** The intended PR target branch (default: the documented queue target). */
  target?: string;
  /** PR title; default is the head commit's subject. */
  title?: string;
  /** Open as a draft; default false (a ready record is a real submission). */
  draft?: boolean;
}

/** The pr.open report — the op's ok value. */
export interface PrOpenReport {
  number: number;
  url?: string;
  /** true only when this op created the PR; false = adopted and refreshed in place. */
  created: boolean;
  /** The branch the PR targets (the branch NAME — the review's pin is its merge-base). */
  base: string;
  head: string;
  branch: string;
  /** Always 'author': the rendered body is author evidence by construction. */
  evidenceClass: 'author';
}

/** The managed body section's START marker. */
export const DEV_READINESS_SECTION_MARKER = '<!-- cq:dev-readiness -->';

/**
 * One-line markdown-safe text (Cc runs become spaces, pipes escaped for
 * tables). Markdown DELIMITERS go through the tracker manifest's `mdSafe`:
 * a backtick or angle bracket in a recorded field (a target ref, a
 * disposition reason) would otherwise close or rewrite the code spans and
 * let the managed readiness section carry fabricated markup.
 */
function mdLine(text: string): string {
  return mdSafe(
    text
      .split(/[\p{Cc}]/u)
      .join(' ')
      .replace(/\|/g, '\\|'),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** The readiness record rendered as the managed body section. */
export function renderReadinessSection(
  record: DevReadinessRecord,
  ledger: DevLedgerFile,
  gates: { name: string; status: string; durationMs: number }[],
): string {
  const cycles = ledger.records.filter((entry) => entry.kind === 'cycle');
  const dispositions = ledger.records.filter((entry) => entry.kind === 'disposition');
  const lines: string[] = [
    DEV_READINESS_SECTION_MARKER,
    '<!-- cq-toolkit dev readiness (generated from the branch dev-record; updated in place, never duplicated) -->',
    '## Dev readiness — author evidence',
    '',
    `> ${mdLine(record.caveat)}`,
    '',
    `- target: \`${mdLine(record.target)}\``,
    `- base: \`${mdLine(record.base)}\` (merge-base pin) · head: \`${mdLine(record.head)}\``,
    `- dirty-diff sha256: \`${mdLine(record.dirtySha256)}\``,
    `- review cycle: \`${mdLine(record.cycleId)}\` (terminal) · check: \`${mdLine(record.checkId)}\` (green)`,
    `- review cycles recorded: ${String(cycles.length)} · dispositions recorded: ${String(dispositions.length)}`,
    '',
    '<details><summary>dev.check gates</summary>',
    '',
    '| gate | status | duration (ms) |',
    '| --- | --- | --- |',
  ];
  for (const gate of gates) {
    lines.push(`| ${mdLine(gate.name)} | ${mdLine(gate.status)} | ${String(gate.durationMs)} |`);
  }
  lines.push('', '</details>');
  // The dispositions live INSIDE the managed section: a re-run updates this
  // section in place, so the posted evidence can never accumulate duplicate
  // comment copies across re-runs.
  if (dispositions.length > 0) {
    lines.push('', '<details><summary>finding dispositions</summary>', '');
    for (const entry of dispositions) {
      lines.push(`- \`${mdLine(entry.findingId)}\` — **${entry.action}**: ${mdLine(entry.why)}`);
    }
    lines.push('', '</details>');
  }
  lines.push('<!-- /cq:dev-readiness -->');
  return lines.join('\n');
}

/** The dispositions rendered as the PR-comment body. */
export function renderDispositionsComment(ledger: DevLedgerFile): string {
  const dispositions = ledger.records.filter((entry) => entry.kind === 'disposition');
  const lines: string[] = [
    '<!-- cq:dev-dispositions -->',
    '## Finding dispositions (author evidence)',
    '',
    `> ${mdLine(AUTHOR_EVIDENCE_CAVEAT)}`,
    '',
  ];
  if (dispositions.length === 0) {
    lines.push(
      'No findings were dispositioned — the terminal review cycle reported none needing adjudication.',
    );
  }
  for (const entry of dispositions) {
    lines.push(`- \`${mdLine(entry.findingId)}\` — **${entry.action}**: ${mdLine(entry.why)}`);
  }
  lines.push('<!-- /cq:dev-dispositions -->');
  return lines.join('\n');
}

/**
 * Build the `pr.open` op over the dev effects (git reads, the ledger, the
 * clock) and the gh effects (search/create/edit/comment). Per call:
 * assemble readiness → render → adopt-or-create → comment dispositions.
 */
export function makePrOpen(dev: DevEffects, gh: PrEffects): Op<PrOpenInput, PrOpenReport> {
  return async (input) => {
    // Library boundary BEFORE any effect: the input itself, then repoRoot
    // (a null/undefined input maps to the failed taxonomy, never a
    // TypeError outside it).
    const objectFault = objectInputFault(input);
    if (objectFault !== null) return { status: 'failed', error: `pr.open: ${objectFault}` };
    const rootFault = repoRootFault(input.repoRoot);
    if (rootFault !== null) return { status: 'failed', error: `pr.open: ${rootFault}` };
    const target = input.target ?? DEFAULT_DEV_TARGET;

    const branch = branchFromRevParse(
      await dev.runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        timeoutMs: GIT_TIMEOUT_MS,
      }),
    );
    if (branch === null) {
      return {
        status: 'needs-human',
        reason:
          'pr.open records evidence per branch and HEAD is detached — check out a branch and re-run',
      };
    }
    const head = gitOut(
      await dev.runCommand('git', ['rev-parse', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS }),
    );
    if (head === null) {
      return {
        status: 'needs-human',
        reason: 'git rev-parse HEAD failed — is this a git worktree?',
      };
    }
    const base = gitOut(
      await dev.runCommand('git', ['merge-base', `origin/${target}`, 'HEAD'], {
        timeoutMs: GIT_TIMEOUT_MS,
      }),
    );
    if (base === null) {
      return {
        status: 'needs-human',
        reason: `cannot pin the merge-base: 'origin/${target}' did not resolve — fetch the target and re-run`,
      };
    }
    let dirtySha256: string;
    let untracked: string[];
    try {
      const dirtyDiff = await dev.runCommand('git', ['diff', '--binary', '--full-index', 'HEAD'], {
        timeoutMs: GIT_TIMEOUT_MS,
      });
      const diffText = requireGitOutRaw(dirtyDiff, 'diff --binary --full-index HEAD');
      dirtySha256 =
        diffText === '' ? 'clean-tree' : createHash('sha256').update(diffText).digest('hex');
      const untrackedOut = requireGitOut(
        await dev.runCommand('git', ['ls-files', '--others', '--exclude-standard'], {
          timeoutMs: GIT_TIMEOUT_MS,
        }),
        'ls-files --others',
      );
      untracked = untrackedOut.split('\n').filter((line) => line.trim() !== '');
    } catch (err) {
      return {
        status: 'needs-human',
        reason: `the diff identity could not be read — ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    let ledger: DevLedgerFile;
    try {
      ledger = dev.openLedger(branch).load();
    } catch (err) {
      return {
        status: 'needs-human',
        reason: `the branch dev-record could not be read — ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // THE REMOTE HEAD IS THE AUTHORITY: a PR carries the REMOTE branch, so
    // it must equal the reviewed local head before anything is mutated.
    const lsRemote = await dev.runCommand('git', ['ls-remote', 'origin', `refs/heads/${branch}`], {
      timeoutMs: GIT_TIMEOUT_MS,
    });
    if (lsRemote.exitCode !== 0) {
      return {
        status: 'needs-human',
        reason: `the remote head of '${branch}' could not be read — ${lsRemote.stderr.trim().slice(0, 300)}`,
      };
    }
    const remoteLine = lsRemote.stdout
      .split('\n')
      .find((line) => line.trim().endsWith(`refs/heads/${branch}`));
    const remoteHead = remoteLine === undefined ? undefined : remoteLine.split('\t')[0]?.trim();
    if (remoteHead === undefined || remoteHead === '') {
      return {
        status: 'needs-human',
        reason: `branch '${branch}' was never pushed — the readiness record describes local head ${head}, and a PR cannot carry a branch the remote does not have; push the reviewed head and re-run`,
      };
    }
    if (remoteHead !== head) {
      return {
        status: 'needs-human',
        reason: `the remote branch '${branch}' is at ${remoteHead}, but the reviewed local head is ${head} — the readiness record describes the reviewed head only; push the reviewed head and re-run (never post readiness for a different head)`,
      };
    }

    const assembled = assembleReadiness({
      branch,
      target,
      identity: { base, head, dirtySha256 },
      ledger,
      untracked,
      nowIso: dev.nowIso(),
    });
    if (!assembled.ready) {
      return {
        status: 'needs-human',
        reason: `pr.open refuses: the branch is not dev.ready — ${assembled.gaps
          .map((gap) => `${gap.field}: ${gap.detail}`)
          .join(' | ')}`,
      };
    }
    let record: DevReadinessRecord = assembled.record;

    // THE MUTATION BOUNDARY: everything above read the ledger, the remote,
    // and the worktree at different instants. Before ANY gh mutation:
    //   (a) the ledger is RELOADED and readiness RE-ASSEMBLED (a concurrent
    //       dev.check/dev.review appending a red check or a blocked cycle
    //       must abort the publish, never ride a stale green snapshot);
    //   (b) the REMOTE head is re-read and must still equal the reviewed
    //       head (a push or force-push during the reads must abort);
    //   (c) the worktree identity recheck below covers the tree itself.
    try {
      const freshLedger = dev.openLedger(branch).load();
      const reassembled = assembleReadiness({
        branch,
        target,
        identity: { base, head, dirtySha256 },
        ledger: freshLedger,
        untracked,
        nowIso: dev.nowIso(),
      });
      if (!reassembled.ready) {
        return {
          status: 'needs-human',
          reason: `pr.open refuses at the mutation boundary: the branch ledger changed and is no longer ready — ${reassembled.gaps
            .map((gap) => `${gap.field}: ${gap.detail}`)
            .join(' | ')}`,
        };
      }
      ledger = freshLedger;
      record = reassembled.record;
    } catch (err) {
      return {
        status: 'needs-human',
        reason: `pr.open could not re-read the branch ledger at the mutation boundary — ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const remoteRecheck = await dev.runCommand(
      'git',
      ['ls-remote', 'origin', `refs/heads/${branch}`],
      { timeoutMs: GIT_TIMEOUT_MS },
    );
    if (remoteRecheck.exitCode !== 0) {
      return {
        status: 'needs-human',
        reason: `the remote head of '${branch}' could not be re-read at the mutation boundary — ${remoteRecheck.stderr.trim().slice(0, 300)}`,
      };
    }
    const remoteRecheckLine = remoteRecheck.stdout
      .split('\n')
      .find((line) => line.trim().endsWith(`refs/heads/${branch}`));
    const remoteRecheckHead =
      remoteRecheckLine === undefined ? undefined : remoteRecheckLine.split('\t')[0]?.trim();
    if (remoteRecheckHead !== head) {
      return {
        status: 'needs-human',
        reason: `the remote branch '${branch}' moved during pr.open's reads (now ${remoteRecheckHead ?? 'gone'}, reviewed head ${head}) — nothing was posted; re-run for the new state`,
      };
    }

    // THE PR CARRIES PUSHED COMMITS ONLY: a readiness record describing a
    // dirty worktree would describe uncommitted content the PR cannot
    // contain. A clean tree is required before any mutation.
    if (dirtySha256 !== 'clean-tree') {
      return {
        status: 'needs-human',
        reason: `pr.open refuses: the worktree still has uncommitted changes (dirty-diff ${dirtySha256.slice(0, 12)}) — a PR carries pushed commits only, so it would not contain everything the reviewed record describes; commit the work, re-run the cycle at the new state, and re-open`,
      };
    }

    // RE-VALIDATE the identity immediately before the gh mutation — FAIL
    // CLOSED: the recheck reads (head, dirty diff, untracked list) must all
    // SUCCEED and all MATCH the assembled identity. A failed read is a
    // refusal (it can never fold into clean/empty and pass); any drift
    // aborts before a byte is posted.
    try {
      const recheckHead = requireGitOut(
        await dev.runCommand('git', ['rev-parse', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS }),
        'rev-parse HEAD (recheck)',
      );
      const recheckDiff = requireGitOutRaw(
        await dev.runCommand('git', ['diff', '--binary', '--full-index', 'HEAD'], {
          timeoutMs: GIT_TIMEOUT_MS,
        }),
        'dirty diff (recheck)',
      );
      const recheckSha =
        recheckDiff === '' ? 'clean-tree' : createHash('sha256').update(recheckDiff).digest('hex');
      const recheckUntracked = requireGitOut(
        await dev.runCommand('git', ['ls-files', '--others', '--exclude-standard'], {
          timeoutMs: GIT_TIMEOUT_MS,
        }),
        'ls-files --others (recheck)',
      )
        .split('\n')
        .filter((line) => line.trim() !== '');
      const sameUntracked =
        recheckUntracked.length === untracked.length &&
        recheckUntracked.every((path, index) => path === untracked[index]);
      if (
        recheckHead !== head ||
        recheckSha !== dirtySha256 ||
        !sameUntracked ||
        dirtySha256 !== 'clean-tree'
      ) {
        return {
          status: 'needs-human',
          reason: `the worktree changed (or does not match the reviewed state) while pr.open read the record (head ${recheckHead} vs ${head}, dirty ${recheckSha.slice(0, 8)} vs ${dirtySha256.slice(0, 8)}, untracked ${String(recheckUntracked.length)} vs ${String(untracked.length)}) — nothing was posted; re-run the cycle for the new state`,
        };
      }
    } catch (err) {
      return {
        status: 'needs-human',
        reason: `the pre-mutation identity recheck failed — nothing was posted: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // The PR title: the explicit input, else the head commit's subject.
    let title = input.title;
    if (title === undefined) {
      const subject = gitOut(
        await dev.runCommand('git', ['log', '-1', '--format=%s'], { timeoutMs: GIT_TIMEOUT_MS }),
      );
      if (subject === null || subject.trim() === '') {
        return {
          status: 'needs-human',
          reason: 'no PR title and the head commit subject is unreadable — pass --title',
        };
      }
      title = subject;
    }

    // The body: the managed readiness section composed over any existing
    // body (an adopted PR's prose survives the refresh).
    const lastCheck = [...ledger.records]
      .reverse()
      .find((entry): entry is DevCheckRecord => entry.kind === 'check' && entry.passed);
    const gates =
      lastCheck?.gates.map((gate) => ({
        name: gate.name,
        status: gate.status,
        durationMs: gate.durationMs,
      })) ?? [];
    const section = renderReadinessSection(record, ledger, gates);

    // Adopt-or-create: an OPEN PR for this head+base is refreshed in place
    // (never a second PR); a non-open one is a landed record — refused.
    let number: number;
    let url: string | undefined;
    let created: boolean;
    try {
      const existing = await gh.searchPrByHead(branch, target);
      if (existing !== null) {
        if (existing.isCrossRepository || existing.state !== 'open') {
          return {
            status: 'failed',
            error: `pr: a PR for branch '${branch}' already exists (PR #${String(existing.number)}, state '${existing.state}'${existing.isCrossRepository ? ', foreign fork' : ''}) — refusing: a landed record is never rewritten and a fork's PR is never adopted`,
          };
        }
        number = existing.number;
        url = existing.url;
        created = false;
        const currentBody = await gh.getPrBody(number);
        await gh.editPrBody(number, composeSection(currentBody, section));
      } else {
        const result = await gh.createPr({
          head: branch,
          base: target,
          title,
          body: section,
          draft: input.draft === true,
        });
        number = result.number;
        url = result.url;
        created = true;
      }
    } catch (err) {
      return {
        status: 'failed',
        error: `pr: the PR could not be opened — ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // The dispositions comment posts ONCE, on creation — the dispositions
    // themselves live in the managed body section, which every re-run
    // updates in place, so the evidence stays reachable without ever
    // accumulating duplicate comments.
    if (created && ledger.records.some((entry) => entry.kind === 'disposition')) {
      try {
        await gh.comment(number, renderDispositionsComment(ledger));
      } catch (err) {
        // The PR exists and the body section already carries the
        // dispositions; the courtesy comment failed. Honest failure, no
        // idempotency claim: the caller may re-run to update the body (the
        // adopt path posts no comment).
        return {
          status: 'failed',
          error: `pr: PR #${String(number)} is open with the dispositions in its body, but the creation comment failed — ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    return {
      status: 'ok',
      value: {
        number,
        ...(url !== undefined ? { url } : {}),
        created,
        base: target,
        head,
        branch,
        evidenceClass: 'author',
      },
    };
  };
}
