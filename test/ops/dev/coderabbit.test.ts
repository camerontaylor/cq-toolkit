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
  isTransientReviewerFailure,
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
      JSON.stringify({ type: 'complete', status: 'review_completed' }),
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
    expect(parsed.completeStatus).toBe('review_completed');
    expect(parsed.trailingAfterComplete).toBe(0);
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
      `progress noise 42%\n${JSON.stringify({ type: 'complete', status: 'review_completed' })}\nnot json {`,
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
        JSON.stringify({ type: 'complete', status: 'review_completed' }),
      ].join('\n'),
    );
    expect(parsed.sawError).toBe(true);
    expect(parsed.sawActionRequired).toBe(true);
    expect(parsed.sawComplete).toBe(true);
  });

  test('a skipped completion is flagged with its verbatim status', () => {
    const parsed = parseReviewerStream(
      `${JSON.stringify({ type: 'complete', status: 'review_skipped' })}\n`,
    );
    expect(parsed.sawComplete).toBe(true);
    expect(parsed.completeStatus).toBe('review_skipped');
  });
});

describe('decideCompletion — the three-part protocol definition', () => {
  const terminalStream = parseReviewerStream(
    `${JSON.stringify({ type: 'complete', status: 'review_completed' })}\n`,
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
        JSON.stringify({ type: 'complete', status: 'review_completed' }),
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
        JSON.stringify({ type: 'complete', status: 'review_completed' }),
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

  test('an UNKNOWN complete status blocks even on exit 0 (fail closed)', () => {
    const stream = parseReviewerStream(
      `${JSON.stringify({ type: 'complete', status: 'mysterious' })}\n`,
    );
    const verdict = decideCompletion(0, stream);
    expect(verdict.kind).toBe('blocked');
    if (verdict.kind === 'blocked') {
      expect(verdict.reason).toContain('mysterious');
      expect(verdict.reason).toContain('unrecognized status');
    }
  });

  test('a complete event with a MISSING status blocks even on exit 0', () => {
    const stream = parseReviewerStream(`${JSON.stringify({ type: 'complete' })}\n`);
    const verdict = decideCompletion(0, stream);
    expect(verdict.kind).toBe('blocked');
    if (verdict.kind === 'blocked') expect(verdict.reason).toContain('(missing)');
  });

  test('an invented no-fresh STATUS spelling blocks as unrecognized (the real quota case carries a message — see the recovered-corpus test)', () => {
    const stream = parseReviewerStream(
      `${JSON.stringify({ type: 'complete', status: 'no_fresh_review' })}\n`,
    );
    const verdict = decideCompletion(0, stream);
    expect(verdict.kind).toBe('blocked');
    if (verdict.kind === 'blocked') expect(verdict.reason).toContain('no_fresh_review');
  });

  test('a failed-status completion blocks', () => {
    const stream = parseReviewerStream(
      `${JSON.stringify({ type: 'complete', status: 'failed' })}\n`,
    );
    expect(decideCompletion(0, stream).kind).toBe('blocked');
  });

  test('meaningful events AFTER the terminal complete block (the review did not end there)', () => {
    const stream = parseReviewerStream(
      [
        JSON.stringify({ type: 'complete', status: 'review_completed' }),
        JSON.stringify({ type: 'status', status: 'writing' }),
      ].join('\n'),
    );
    const verdict = decideCompletion(0, stream);
    expect(verdict.kind).toBe('blocked');
    if (verdict.kind === 'blocked') expect(verdict.reason).toContain('after the terminal complete');
  });

  test('unparsed garbage AFTER the terminal complete blocks too', () => {
    const stream = parseReviewerStream(
      `${JSON.stringify({ type: 'complete', status: 'review_completed' })}\ngarbage line\n`,
    );
    expect(decideCompletion(0, stream).kind).toBe('blocked');
  });

  test('THE REAL QUOTA CASE (recovered phase0 corpus): review_completed + no-fresh message blocks', () => {
    // The complete event VERBATIM from the saved real log
    // (/tmp/phase0-a-coderabbit-cooldown.ndjson, exit 0): status spells the
    // recognized terminal, yet the reviewer affirmatively says it did not
    // review. Zero findings is the giveaway; the notice is the gate.
    const realComplete = JSON.stringify({
      type: 'complete',
      status: 'review_completed',
      findings: 0,
      reviewedFiles: [
        'src/config/registry.ts',
        'src/config/resolve.ts',
        'test/config/resolve.test.ts',
      ],
      outcome: 'completed',
      message: 'No fresh detailed file review was performed in this run.',
    });
    const stream = parseReviewerStream(
      [
        JSON.stringify({ type: 'review_context' }),
        JSON.stringify({ type: 'status', status: 'reviewing' }),
        JSON.stringify({ type: 'heartbeat' }),
        realComplete,
        '',
      ].join('\n'),
    );
    const verdict = decideCompletion(0, stream);
    expect(verdict.kind).toBe('blocked');
    if (verdict.kind === 'blocked') {
      expect(verdict.reason).toContain('AFFIRMATIVE no-fresh');
      expect(verdict.reason).toContain('No fresh detailed file review was performed in this run.');
    }
  });

  test('a skip-notice variant in the completion message blocks too (case-insensitive)', () => {
    const stream = parseReviewerStream(
      `${JSON.stringify({ type: 'complete', status: 'review_completed', message: 'Review was skipped for this run.' })}\n`,
    );
    const verdict = decideCompletion(0, stream);
    expect(verdict.kind).toBe('blocked');
    if (verdict.kind === 'blocked') expect(verdict.reason).toContain('AFFIRMATIVE no-fresh');
  });

  test('a completion message WITHOUT skip language keeps review_completed terminal', () => {
    const stream = parseReviewerStream(
      `${JSON.stringify({ type: 'complete', status: 'review_completed', message: 'Reviewed 12 files.' })}\n`,
    );
    expect(decideCompletion(0, stream)).toEqual({ kind: 'terminal' });
  });

  test('MALFORMED STREAM: an unrecognized event type before the terminal blocks', () => {
    const stream = parseReviewerStream(
      [
        JSON.stringify({ type: 'teleporting', phase: 'x' }),
        JSON.stringify({ type: 'complete', status: 'review_completed' }),
      ].join('\n'),
    );
    const verdict = decideCompletion(0, stream);
    expect(verdict.kind).toBe('blocked');
    if (verdict.kind === 'blocked') {
      expect(verdict.reason).toContain('MALFORMED');
      expect(verdict.reason).toContain('cannot pass as a clean cycle');
    }
  });

  test('MALFORMED STREAM: non-JSON garbage BEFORE the terminal blocks', () => {
    const stream = parseReviewerStream(
      `progress noise 42%\n${JSON.stringify({ type: 'complete', status: 'review_completed' })}\n`,
    );
    const verdict = decideCompletion(0, stream);
    expect(verdict.kind).toBe('blocked');
    if (verdict.kind === 'blocked') expect(verdict.reason).toContain('MALFORMED');
  });

  test('the recognized real-world terminal: complete review_completed as the LAST line → terminal', () => {
    const stream = parseReviewerStream(
      [
        JSON.stringify({ type: 'status', status: 'reviewing' }),
        JSON.stringify({ type: 'finding', severity: 'minor', comment: 'nit' }),
        JSON.stringify({ type: 'complete', status: 'review_completed' }),
      ].join('\n'),
    );
    expect(decideCompletion(0, stream)).toEqual({ kind: 'terminal' });
    // Severities are preserved whatever the completion verdict.
    expect(stream.findings[0]?.severity).toBe('minor');
  });

  test('a finding event WITHOUT a severity is malformed — never a fabricated nonblocking none', () => {
    const stream = parseReviewerStream(
      [
        JSON.stringify({ type: 'finding', comment: 'truncated event — no severity word' }),
        JSON.stringify({ type: 'complete', status: 'review_completed' }),
      ].join('\n'),
    );
    // The malformed event is unparsed (decideCompletion fails closed on any
    // unparsed line) and no finding is recorded, so no classification —
    // blocking or otherwise — is invented from schema drift.
    expect(stream.findings).toHaveLength(0);
    expect(stream.unparsedLines).toBe(1);
    expect(decideCompletion(0, stream).kind).toBe('blocked');
  });
});

describe('CodeRabbit transient classification (#509)', () => {
  const event = (value: object) => `${JSON.stringify(value)}\n`;
  const conErr = event({
    type: 'error',
    errorType: 'review',
    message: 'Review failed: con_err: webSocket connection failed',
    recoverable: false,
  });
  const exited = { exitCode: 1, timedOut: false };

  test('reads the anchored vendor code of every error event', () => {
    const parsed = parseReviewerStream(
      conErr + event({ type: 'error', message: 'rate limit reached; see con_err: docs' }),
    );
    expect(parsed.errorCodes).toEqual(['con_err', '']);
  });

  test('a wholly dropped-connection stream that exited on its own is transient', () => {
    expect(isTransientReviewerFailure(parseReviewerStream(conErr), exited)).toBe(true);
    expect(isTransientReviewerFailure(parseReviewerStream(conErr + conErr), exited)).toBe(true);
  });

  test.each([
    [
      'a later auth error',
      conErr + event({ type: 'error', message: 'Review failed: auth_err: login required' }),
    ],
    ['an error with no vendor code', conErr + event({ type: 'error', message: 'unexpected' })],
    [
      'an action-required event',
      conErr + event({ type: 'action_required', message: 'confirm billing' }),
    ],
    ['an unparsed line', `${conErr}not json\n`],
    ['no error event at all', event({ type: 'status', status: 'reviewing' })],
  ])('%s vetoes the transient class', (_label, stdout) => {
    expect(isTransientReviewerFailure(parseReviewerStream(stdout), exited)).toBe(false);
  });

  test.each([
    ['a killed process', { exitCode: null, timedOut: false }],
    ['a timed-out process', { exitCode: null, timedOut: true }],
    ['a clean exit', { exitCode: 0, timedOut: false }],
  ])('%s vetoes the transient class', (_label, raw) => {
    expect(isTransientReviewerFailure(parseReviewerStream(conErr), raw)).toBe(false);
  });
});
