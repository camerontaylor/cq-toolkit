// dev.review op tests over a REAL git repo (repo.ts) with a scripted
// reviewer CLI and a stub or capturing scanner. Pinned: the base pin, the
// per-path scan components (committed/staged/unstaged/untracked, binary
// bytes included), the scan BEFORE any reviewer run, honest completion
// recording, drift refusal, and the finding-id minting in the ledger.
// Shared fixtures/helpers for the dev.review op tests split across the
// review*.test.ts files in this directory.
import { createHash } from 'node:crypto';
import type { DiffSecretScanner, ScanComponentInput } from '../../../src/ops/dev/denylist.js';
import type { Op } from '../../../src/kernel/types.js';
import type { CommandResult } from '../../../src/ops/dev/effects.js';
import type { DevFinding } from '../../../src/ops/dev/record.js';
import type { ManagedReviewSubmit } from '../../../src/ops/dev/managedReview.js';
import {
  makeDevReview,
  type DevCycleInput,
  type DevReviewReport,
} from '../../../src/ops/dev/review.js';
import {
  ReviewCoverageV2Schema,
  type ReviewCoverageV2,
} from '../../../src/ops/review/internal/reviewCoverageV2.js';
import type { CommandHandler } from './repo.js';

/** The cycle branch of the composed op. */
export const cycleReview = (
  effects: Parameters<typeof makeDevReview>[0]['effects'],
  scanSecrets: DiffSecretScanner,
  patternsFile?: string,
  managedSubmit?: ManagedReviewSubmit,
) =>
  makeDevReview({
    effects,
    scanSecrets,
    ...(patternsFile === undefined ? {} : { patternsFile }),
    ...(managedSubmit === undefined ? {} : { managedSubmit }),
  }) as Op<DevCycleInput, DevReviewReport>;

/**
 * S2b-i: a scripted managed queue leg. The tests script the submit outcome
 * directly (the submit-wait-fetch leg itself is covered in managedReview.test.ts
 * over a fake transport); these fixtures carry the same finding shapes the
 * CLI stream parser emitted, so cycle assertions are unchanged.
 */
export const managedTerminal = (
  findings: Omit<DevFinding, 'id'>[] = [
    { severity: 'major', fileName: 'src/a.ts', excerpt: 'fix this' },
    { severity: 'minor', excerpt: 'nit' },
  ],
  receiptId = 'r'.repeat(64),
): ManagedReviewSubmit =>
  (async () => ({
    status: 'completed',
    value: { receiptId, completion: { kind: 'terminal' }, findings, advisories: [] },
  })) as ManagedReviewSubmit;

export const managedBlocked = (
  reason: string,
  findings: Omit<DevFinding, 'id'>[] = [],
  receiptId = 'b'.repeat(64),
): ManagedReviewSubmit =>
  (async () => ({
    status: 'completed',
    value: { receiptId, completion: { kind: 'blocked', reason }, findings, advisories: [] },
  })) as ManagedReviewSubmit;

export const managedRefused = (reason: string, transient?: true): ManagedReviewSubmit =>
  (async () =>
    transient === true
      ? { status: 'refused', reason, transient: true as const }
      : { status: 'refused', reason }) as ManagedReviewSubmit;

const NDJSON_OK = [
  JSON.stringify({ type: 'status', status: 'scanning' }),
  JSON.stringify({ type: 'finding', severity: 'major', fileName: 'src/a.ts', comment: 'fix this' }),
  JSON.stringify({ type: 'finding', severity: 'minor', comment: 'nit' }),
  JSON.stringify({ type: 'complete', status: 'review_completed' }),
  '',
].join('\n');

export const ran = (
  exitCode: number | null,
  stdout = NDJSON_OK,
  extra: Partial<CommandResult> = {},
): CommandResult => ({
  exitCode,
  stdout,
  stderr: '',
  timedOut: false,
  ...extra,
});

/**
 * The ai-sdk pre-request wire shape the review engine's delivery hook parses:
 * a JSON request whose user turn carries the exact review prompt.
 */
export function wireRequest(prompt: string): {
  text: string;
  contents: { text: string }[];
} {
  return {
    text: JSON.stringify({ prompt: [{ role: 'user', content: prompt }] }),
    contents: [{ text: prompt }],
  };
}

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export function reviewCoverage(
  head: string,
  base: string,
  scope: 'full' | 'uncommitted',
  state: 'planned' | 'excluded',
): ReviewCoverageV2 {
  return ReviewCoverageV2Schema.parse({
    version: 2,
    head,
    base,
    scope,
    mode: 'session',
    modeReason: 'fixture coverage',
    pieces: [
      {
        component: 'tracked:src/a.ts',
        path: 'src/a.ts',
        sha256: sha256(''),
        chars: 0,
        bytes: 0,
        ...(state === 'excluded'
          ? {
              state,
              exclusion: { rule: 'fixture/**', limitation: 'fixture exclusion limitation' },
            }
          : { state }),
      },
    ],
    sessions: [],
  });
}

/** A scripted reviewer: `coderabbit` answers with `result`; everything else is real git. */
export const reviewer =
  (result: CommandResult | (() => CommandResult | Promise<CommandResult>)): CommandHandler =>
  async (command) =>
    command === 'coderabbit' ? (typeof result === 'function' ? result() : result) : undefined;

/** A scanner that records the components it was handed. */
export function capturingScanner(): DiffSecretScanner & { seen: ScanComponentInput[] } {
  const seen: ScanComponentInput[] = [];
  const scan = ((components: readonly ScanComponentInput[]) => {
    seen.push(...components);
    return components.map((c) => ({ component: c.component, hits: [] }));
  }) as unknown as DiffSecretScanner & { seen: ScanComponentInput[] };
  scan.seen = seen;
  return scan;
}

export const reviewerCalls = (effects: { calls: { command: string; args: readonly string[] }[] }) =>
  effects.calls.filter((call) => call.command === 'coderabbit');
