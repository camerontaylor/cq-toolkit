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
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DevEffects } from '../dev/effects.js';
import { faultText, guardDevOp } from '../dev/effects.js';
import type {
  DevCheckGate,
  DevCheckRecord,
  DevLedgerFile,
  DevReadinessRecord,
} from '../dev/record.js';
import { AUTHOR_EVIDENCE_CAVEAT, DEFAULT_DEV_TARGET } from '../dev/record.js';
import { readReadinessWithGaps, type ReadinessGap } from '../dev/ready.js';
import { bindPublishedDeferredDebt } from '../dev/internal/deferredLedger.js';
import type { DeferredQueueClient } from '../review/internal/queueProtocol.js';
import { CLEAN_TREE, git, gitStdout } from '../dev/internal/workState.js';
import { parseCqConfig } from '../analyze/cqConfig.js';
import { resolveCqConfigDefaults } from '../analyze/cqConfigDefaults.js';
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
  /**
   * With `draft: true`: a not-ready branch opens the DRAFT carrying a
   * NOT-READY gaps section instead of refusing (the composition's round-cap
   * path — the branch is published with its honest state, never bypassed);
   * default false (a not-ready branch is a needs-human refusal naming the
   * gaps). Never has any effect without `draft: true`.
   */
  draftWhenNotReady?: boolean;
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
  /** true when the PR carries a READY author-tier record; false = a DRAFT carrying the gaps. */
  ready: boolean;
  /** Non-blocking review context, also rendered in the managed PR section. */
  advisories?: string[];
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

/** Use the latest cycle per reviewer for this exact comparison, never stale heads. */
function reviewAdvisories(
  ledger: DevLedgerFile,
  state: { head: string; base: string; target: string; dirtySha256?: string },
): string[] {
  const latest = new Map<string, string[]>();
  for (const entry of ledger.records) {
    if (
      entry.kind === 'cycle' &&
      entry.scope === 'full' &&
      entry.head === state.head &&
      entry.base === state.base &&
      entry.target === state.target &&
      (state.dirtySha256 === undefined || entry.dirtySha256 === state.dirtySha256)
    )
      latest.set(entry.reviewer, entry.advisories ?? []);
  }
  return [...new Set([...latest.values()].flat())];
}

function appendReviewAdvisories(lines: string[], advisories: readonly string[]): void {
  if (advisories.length === 0) return;
  lines.push('', '### Review advisories', '');
  for (const advisory of advisories) lines.push(`- ${mdLine(advisory)}`);
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
  const debts = new Map(
    ledger.records
      .filter((entry) => entry.kind === 'vendor-debt')
      .map((entry) => [entry.debt.reference.requestId, entry.debt]),
  );
  if (debts.size > 0) {
    lines.push(
      '',
      '### Deferred vendor review debt',
      '',
      'Pending obligations remain outstanding; completed entries link verified affected-current receipts only. Agent coverage and queue enrollment do not complete vendor review.',
    );
    for (const debt of debts.values()) {
      const binding = debt.reference.binding;
      lines.push(
        `- request \`${mdLine(debt.reference.requestId)}\` · head \`${mdLine(binding.kind === 'deferred-author' ? binding.head : binding.mergeSha)}\` · queue \`${mdLine(debt.queue.state)}\` · vendor \`${mdLine(debt.vendor)}\` · vendorCompleted: ${String(debt.vendorCompleted)}${debt.vendorCompleted ? ` · affected-current receipt \`${mdLine(debt.completion.receiptId)}\` (no full-branch or independent credit)` : ''} · origin \`${mdLine(debt.originAttempt.cycleId)}\`${debt.predecessor ? ` · predecessor \`${mdLine(debt.predecessor.requestId)}\`` : ''}`,
      );
    }
  }
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
  appendReviewAdvisories(lines, reviewAdvisories(ledger, record));
  lines.push('<!-- /cq:dev-readiness -->');
  return lines.join('\n');
}

/** The NOT-READY draft's managed body section: the readiness gaps, verbatim. */
export const DEV_READINESS_GAPS_SECTION_MARKER = '<!-- cq:dev-readiness-gaps -->';

/**
 * The not-ready gaps rendered as the managed body section of a DRAFT PR:
 * every gap verbatim (field + detail), marked NOT READY, WITH the branch
 * ledger's dispositions folded in (the spec's round-cap body lists the
 * readiness record, the dispositions AND the open findings — the findings
 * section is dev.cycle's own). The dispositions live INSIDE the managed
 * span (the READY section's rule): an adopted re-run refreshes them in
 * place, so they never depend on the one creation-time comment.
 */
export function renderReadinessGapsSection(
  state: { branch: string; head: string; base: string; dirtySha256?: string },
  ledger: DevLedgerFile,
  target: string,
  gaps: readonly { field: string; detail: string }[],
): string {
  const dispositions = ledger.records.filter((entry) => entry.kind === 'disposition');
  const lines: string[] = [
    DEV_READINESS_GAPS_SECTION_MARKER,
    '<!-- cq-toolkit dev readiness gaps (generated from the branch dev-record; updated in place, never duplicated) -->',
    '## Dev readiness — NOT READY (author evidence)',
    '',
    `> ${mdLine(AUTHOR_EVIDENCE_CAVEAT)}`,
    '',
    `- target: \`${mdLine(target)}\``,
    `- base: \`${mdLine(state.base)}\` (merge-base pin) · head: \`${mdLine(state.head)}\` · branch: \`${mdLine(state.branch)}\``,
    `- blocking gaps: ${String(gaps.length)}`,
    '',
  ];
  for (const gap of gaps) {
    lines.push(`- **${mdLine(gap.field)}**: ${mdLine(gap.detail)}`);
  }
  lines.push('', `- finding dispositions: ${String(dispositions.length)}`);
  if (dispositions.length === 0) {
    lines.push('  - (none recorded)');
  }
  for (const entry of dispositions) {
    lines.push(`  - \`${mdLine(entry.findingId)}\` — **${entry.action}**: ${mdLine(entry.why)}`);
  }
  appendReviewAdvisories(lines, reviewAdvisories(ledger, { ...state, target }));
  lines.push('', '<!-- /cq:dev-readiness-gaps -->');
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
export function makePrOpen(
  dev: DevEffects,
  gh: PrEffects,
  queueClient?: DeferredQueueClient,
): Op<PrOpenInput, PrOpenReport> {
  return guardDevOp('pr.open', PrOpenInputSchema, async (input) => {
    const target = input.target ?? DEFAULT_DEV_TARGET;
    const configText = await readFile(join(input.repoRoot, 'cq.json'), 'utf8').catch(() => null);
    let policy: { reviewers: readonly string[]; blockingSeverities: readonly string[] } | undefined;
    if (configText !== null) {
      const parsed = parseCqConfig(configText, input.repoRoot);
      if (!parsed.ok)
        return { status: 'needs-human', reason: `pr.open: cq.json — ${parsed.reason}` };
      const packageText = await readFile(join(input.repoRoot, 'package.json'), 'utf8').catch(
        () => '{}',
      );
      let packageName = 'repository';
      try {
        const value: unknown = JSON.parse(packageText);
        if (
          typeof value === 'object' &&
          value !== null &&
          'name' in value &&
          typeof value.name === 'string'
        )
          packageName = value.name;
      } catch {
        /* descriptive fallback only */
      }
      const configured = resolveCqConfigDefaults(parsed.config, { packageName });
      policy = {
        reviewers: configured.review.reviewers,
        blockingSeverities: configured.review.blockingSeverities,
      };
    }
    const draftFallback = input.draft === true && input.draftWhenNotReady === true;
    const readyRead = await readReadinessWithGaps(dev, 'pr.open', target, policy, queueClient);
    if (!readyRead.ok) {
      // The composition's round-cap path: a not-ready branch still publishes,
      // as a DRAFT whose managed section carries the gaps verbatim. Any other
      // case (the default posture, or an unreadable state — a detached head,
      // a corrupt ledger) is a refusal naming the gaps, never a draft.
      if (!draftFallback || readyRead.gaps === undefined)
        return { status: 'needs-human', reason: readyRead.reason };
    }
    const { state, ledger } = readyRead.ok
      ? readyRead.read
      : // The draft fallback's read: the same state and ledger the gaps were
        // assembled from (the WITH-GAPS read carries them whenever the gaps
        // list exists — the guard above refuses the unreadable case).
        { state: readyRead.state!, ledger: readyRead.ledger! };
    const gaps: readonly ReadinessGap[] | undefined = readyRead.ok ? undefined : readyRead.gaps;
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
    // the record rests on) composed over any existing body — or, on the
    // not-ready draft path, the NOT-READY gaps section. The two sections
    // carry distinct markers, so a draft later re-opened ready by a follow-up
    // cycle keeps the retired gaps history in the body while the ready
    // section refreshes in place.
    const section =
      readyRead.ok === true
        ? renderReadinessSection(
            readyRead.read.record,
            ledger,
            ledger.records.find(
              (entry): entry is DevCheckRecord =>
                entry.kind === 'check' && entry.checkId === readyRead.read.record.checkId,
            )?.gates ?? [],
          )
        : renderReadinessGapsSection(
            {
              branch: state.branch,
              head: state.head,
              base: state.base,
              dirtySha256: state.dirtySha256,
            },
            ledger,
            target,
            gaps!,
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
        // The not-ready adopt must not ride a NON-draft PR (#472 seam): a
        // submission that looks ready while the gaps say otherwise is a
        // fabricated state. When the forge reports the existing PR as a
        // non-draft, refuse naming the transition; a converted draft would
        // be an unverified forge write this op does not own.
        if (gaps !== undefined && existing.isDraft === false) {
          return {
            status: 'needs-human',
            reason: `pr.open: the branch is NOT READY (open-blocking gaps) and the existing PR #${String(existing.number)} is not a draft — a not-ready cycle must never ride a submission that looks ready; convert PR #${String(existing.number)} to a draft (or close it) and re-run`,
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
          // The round-cap draft: the flag pair only arms the MECHANISM —
          // an explicit `draft` still passes through, and a READY branch
          // under draftWhenNotReady is a real submission. Only the
          // not-ready gaps path forces true.
          draft: input.draft === true,
        }));
        created = true;
      }
    } catch (err) {
      return { status: 'failed', error: `pr.open: the PR could not be opened — ${faultText(err)}` };
    }

    try {
      await bindPublishedDeferredDebt(dev, target, state, ledger, number, queueClient);
    } catch (err) {
      return {
        status: 'indeterminate',
        detail: `pr.open: PR #${String(number)} is published, but deferred debt binding is uncertain — ${faultText(err)}; retain the same request identity and replay publication`,
      };
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

    const advisories = reviewAdvisories(ledger, { ...state, target });
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
        ready: gaps === undefined,
        ...(advisories.length > 0 ? { advisories } : {}),
      },
    };
  });
}
