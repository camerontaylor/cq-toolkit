// PR lane — `pr.open`: open (or update in place) the PR FROM the readiness
// record (strategy §3, pr.open row; §2.1: the PR is not development state —
// the first quality cycle ran in the worktree and yielded a record, and a
// PR is opened from that record).
//
// THE REMOTE IS THE AUTHORITY FOR WHAT A PR WOULD CARRY: the op requires a
// CLEAN tree (no staged, unstaged or untracked change — a PR carries pushed
// commits only) and the branch's REMOTE head (`git ls-remote`) to EQUAL the
// reviewed local head before any GitHub write. A never-pushed branch or a
// differing remote head is a needs-human refusal.
//
// ONE PASS, AUTHOR TIER (strategy §2.4): the state is read once, then the PR
// is written. A push racing the write is not defended here — the rendered
// record names its head, and pr.verify reports that head without trusting
// it; verification is required CI and the reviewer bots at the exact head.
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
import type { Op } from '../../kernel/types.js';
import type { DevEffects } from '../dev/effects.js';
import { faultText, guardDevOp } from '../dev/effects.js';
import type { DevCheckGate, DevLedgerFile, DevReadinessRecord } from '../dev/record.js';
import { AUTHOR_EVIDENCE_CAVEAT, DEFAULT_DEV_TARGET } from '../dev/record.js';
import { readReadiness } from '../dev/ready.js';
import { CLEAN_TREE, git, gitStdout } from '../dev/internal/workState.js';
import { composeSection, mdSafe } from './assemblePrs.js';
import type { PrEffects } from './assemblePrs.js';
import { PrOpenInputSchema } from './registry.js';

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
  gates: readonly Pick<DevCheckGate, 'name' | 'status' | 'durationMs'>[],
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
    `- review cycle: \`${mdLine(record.cycleId)}\` (terminal, reviewer \`${mdLine(record.reviewer)}\`) · check: \`${mdLine(record.checkId)}\` (green)`,
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
 * readiness → clean tree → remote head → adopt-or-create → dispositions.
 */
export function makePrOpen(dev: DevEffects, gh: PrEffects): Op<PrOpenInput, PrOpenReport> {
  return guardDevOp('pr.open', PrOpenInputSchema, async (input) => {
    const target = input.target ?? DEFAULT_DEV_TARGET;
    const ready = await readReadiness(dev, 'pr.open', target);
    if (!ready.ok) return ready.result;
    const { state, ledger, record } = ready.read;
    const { branch, head } = state;

    if (state.dirtySha256 !== CLEAN_TREE) {
      return {
        status: 'needs-human',
        reason: `pr.open: the tree has staged, unstaged or untracked changes — a PR carries pushed commits only, so it would not contain what the record describes; commit, re-run the cycle at the new head, push, and re-open`,
      };
    }
    const remoteRef = `refs/heads/${branch}`;
    const remoteHead = gitStdout(
      await git(dev, ['ls-remote', 'origin', remoteRef]),
      'ls-remote origin',
    )
      .split('\n')
      .find((line) => line.endsWith(`\t${remoteRef}`))
      ?.split('\t')[0];
    if (remoteHead === undefined) {
      return {
        status: 'needs-human',
        reason: `pr.open: branch '${branch}' was never pushed — push the reviewed head ${head} and re-run`,
      };
    }
    if (remoteHead !== head) {
      return {
        status: 'needs-human',
        reason: `pr.open: the remote branch '${branch}' is at ${remoteHead}, but the reviewed head is ${head} — push the reviewed head and re-run (readiness is never posted for a different head)`,
      };
    }

    let title = input.title;
    if (title === undefined) {
      title = gitStdout(await git(dev, ['log', '-1', '--format=%s', head]), 'log -1').trim();
      if (title === '') {
        return {
          status: 'needs-human',
          reason: 'pr.open: the head commit subject is empty — pass --title',
        };
      }
    }

    // The body: the managed readiness section (with the gates of the check
    // the record rests on) composed over any existing body.
    const check = ledger.records.find(
      (entry) => entry.kind === 'check' && entry.checkId === record.checkId,
    );
    const section = renderReadinessSection(
      record,
      ledger,
      check?.kind === 'check' ? check.gates : [],
    );

    // Adopt-or-create: an OPEN same-repo PR for this head+base is refreshed
    // in place (never a second PR); a closed/merged or fork PR is refused.
    let number: number;
    let url: string | undefined;
    let created: boolean;
    try {
      const existing = await gh.searchPrByHead(branch, target);
      if (existing !== null) {
        if (existing.isCrossRepository || existing.state !== 'open') {
          return {
            status: 'failed',
            error: `pr.open: a PR for branch '${branch}' already exists (PR #${String(existing.number)}, state '${existing.state}'${existing.isCrossRepository ? ', foreign fork' : ''}) — a landed record is never rewritten and a fork's PR is never adopted`,
          };
        }
        ({ number, url } = existing);
        created = false;
        await gh.editPrBody(number, composeSection(await gh.getPrBody(number), section));
      } else {
        ({ number, url } = await gh.createPr({
          head: branch,
          base: target,
          title,
          body: section,
          draft: input.draft === true,
        }));
        created = true;
      }
    } catch (err) {
      return { status: 'failed', error: `pr.open: the PR could not be opened — ${faultText(err)}` };
    }

    // The dispositions comment posts ONCE, on creation; the managed body
    // section carries them too and is refreshed in place on every re-run,
    // so the evidence never accumulates duplicate comments.
    if (created && ledger.records.some((entry) => entry.kind === 'disposition')) {
      try {
        await gh.comment(number, renderDispositionsComment(ledger));
      } catch (err) {
        return {
          status: 'failed',
          error: `pr.open: PR #${String(number)} is open with the dispositions in its body, but the creation comment failed — ${faultText(err)}`,
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
  });
}
