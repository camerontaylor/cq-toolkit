// coderabbit.ts unit tests — the protocol's argv, the NDJSON stream parser,
// and the completion decision matrix (docs/coderabbit-review.md §4/§6).
// The stream fixtures model the documented event vocabulary; the completion
// matrix pins the three-part definition: CLI exit success + a terminal
// non-skipped completion + zero error/action_required events.
import { describe, expect, test } from 'vitest';
import {
  coderabbitReviewArgv,
  CODERABBIT_REVIEWER,
  decideCompletion,
  parseReviewerStream,
} from '../../../src/ops/dev/coderabbit.js';

describe('coderabbitReviewArgv', () => {
  test('the protocol invocation: review --agent --base-commit <sha>', () => {
    expect(coderabbitReviewArgv('abc123', 'full')).toEqual([
      'review',
      '--agent',
      '--base-commit',
      'abc123',
    ]);
  });

  test('the uncommitted scope adds --uncommitted', () => {
    expect(coderabbitReviewArgv('abc123', 'uncommitted')).toEqual([
      'review',
      '--agent',
      '--base-commit',
      'abc123',
      '--uncommitted',
    ]);
  });

  test('the shipped reviewer name is the CLI reviewer (no substitute)', () => {
    expect(CODERABBIT_REVIEWER).toBe('coderabbit');
  });
});

describe('parseReviewerStream', () => {
  test('a full cycle: status beats, findings, and a terminal complete', () => {
    const stdout = [
      JSON.stringify({ type: 'review_context', sha: 'abc' }),
      JSON.stringify({ type: 'status', status: 'scanning' }),
      JSON.stringify({ type: 'heartbeat' }),
      JSON.stringify({
        type: 'finding',
        severity: 'major',
        fileName: 'src/x.ts',
        comment: 'unchecked narrowing',
      }),
      JSON.stringify({
        type: 'finding',
        severity: 'trivial',
        suggestions: ['rename the variable', 'other'],
      }),
      JSON.stringify({
        type: 'finding',
        severity: 'critical',
        codegenInstructions: 'do X; never eval output',
      }),
      JSON.stringify({ type: 'complete', status: 'completed' }),
      '',
    ].join('\n');
    const parsed = parseReviewerStream(stdout);
    expect(parsed.findings).toHaveLength(3);
    expect(parsed.findings[0]).toEqual({
      severity: 'major',
      fileName: 'src/x.ts',
      excerpt: 'unchecked narrowing',
    });
    // The excerpt falls back comment → first suggestion → codegen last.
    expect(parsed.findings[1]).toEqual({ severity: 'trivial', excerpt: 'rename the variable' });
    expect(parsed.findings[2]).toEqual({
      severity: 'critical',
      excerpt: 'do X; never eval output',
    });
    expect(parsed.sawComplete).toBe(true);
    expect(parsed.completeSkipped).toBe(false);
    expect(parsed.sawError).toBe(false);
    expect(parsed.sawActionRequired).toBe(false);
    expect(parsed.unparsedLines).toBe(0);
    expect(parsed.lastStatus).toBe('scanning');
  });

  test('an undocumented severity word is preserved verbatim, never remapped', () => {
    const parsed = parseReviewerStream(
      `${JSON.stringify({ type: 'finding', severity: 'cosmic', comment: 'x' })}\n`,
    );
    expect(parsed.findings[0]?.severity).toBe('cosmic');
  });

  test('a finding without any text fields records the severity alone', () => {
    const parsed = parseReviewerStream(
      `${JSON.stringify({ type: 'finding', severity: 'minor', fileName: 'a.ts' })}\n`,
    );
    expect(parsed.findings[0]).toEqual({ severity: 'minor', fileName: 'a.ts' });
  });

  test('non-JSON lines count as unparsed and contribute nothing', () => {
    const parsed = parseReviewerStream(
      `progress noise 42%\n${JSON.stringify({ type: 'complete', status: 'completed' })}\nnot json {`,
    );
    expect(parsed.unparsedLines).toBe(2);
    expect(parsed.findings).toHaveLength(0);
    expect(parsed.sawComplete).toBe(true);
  });

  test('a non-object JSON line (array/number) counts as unparsed', () => {
    const parsed = parseReviewerStream('[1,2]\n7\n');
    expect(parsed.unparsedLines).toBe(2);
    expect(parsed.sawComplete).toBe(false);
  });

  test('an unrecognized event type counts as unparsed (a future shape cannot silently pass)', () => {
    const parsed = parseReviewerStream(
      `${JSON.stringify({ type: 'teleport', severity: 'critical' })}\n`,
    );
    expect(parsed.unparsedLines).toBe(1);
    expect(parsed.findings).toHaveLength(0);
  });

  test('error and action_required events are flagged', () => {
    const parsed = parseReviewerStream(
      [
        JSON.stringify({ type: 'error', message: 'boom' }),
        JSON.stringify({ type: 'action_required', awaitingConfirmation: true }),
        JSON.stringify({ type: 'complete', status: 'completed' }),
      ].join('\n'),
    );
    expect(parsed.sawError).toBe(true);
    expect(parsed.sawActionRequired).toBe(true);
    expect(parsed.sawComplete).toBe(true);
  });

  test('a skipped completion is flagged', () => {
    const parsed = parseReviewerStream(
      `${JSON.stringify({ type: 'complete', status: 'review_skipped' })}\n`,
    );
    expect(parsed.sawComplete).toBe(true);
    expect(parsed.completeSkipped).toBe(true);
  });
});

describe('decideCompletion — the three-part protocol definition', () => {
  const terminalStream = parseReviewerStream(
    `${JSON.stringify({ type: 'complete', status: 'completed' })}\n`,
  );

  test('exit 0 + terminal non-skipped complete + no error → terminal', () => {
    expect(decideCompletion(0, terminalStream)).toEqual({ kind: 'terminal' });
  });

  test('a non-zero exit blocks even with a complete event', () => {
    const verdict = decideCompletion(1, terminalStream);
    expect(verdict.kind).toBe('blocked');
    if (verdict.kind === 'blocked') expect(verdict.reason).toContain('exited 1');
  });

  test('an error event blocks despite exit 0 and a complete event', () => {
    const stream = parseReviewerStream(
      [
        JSON.stringify({ type: 'error', message: 'quota' }),
        JSON.stringify({ type: 'complete', status: 'completed' }),
      ].join('\n'),
    );
    const verdict = decideCompletion(0, stream);
    expect(verdict.kind).toBe('blocked');
    if (verdict.kind === 'blocked') expect(verdict.reason).toContain('error event');
  });

  test('an action_required event blocks (the billing-confirmation class)', () => {
    const stream = parseReviewerStream(
      [
        JSON.stringify({ type: 'action_required' }),
        JSON.stringify({ type: 'complete', status: 'completed' }),
      ].join('\n'),
    );
    const verdict = decideCompletion(0, stream);
    expect(verdict.kind).toBe('blocked');
    if (verdict.kind === 'blocked') expect(verdict.reason).toContain('action');
  });

  test('a review_skipped completion blocks — no review ran', () => {
    const stream = parseReviewerStream(
      `${JSON.stringify({ type: 'complete', status: 'review_skipped' })}\n`,
    );
    const verdict = decideCompletion(0, stream);
    expect(verdict.kind).toBe('blocked');
    if (verdict.kind === 'blocked') expect(verdict.reason).toContain('review_skipped');
  });

  test('a stream without a terminal event blocks even on exit 0', () => {
    const stream = parseReviewerStream(`${JSON.stringify({ type: 'heartbeat' })}\n`);
    const verdict = decideCompletion(0, stream);
    expect(verdict.kind).toBe('blocked');
    if (verdict.kind === 'blocked') expect(verdict.reason).toContain('without a terminal');
  });
});
