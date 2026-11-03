// Split from policy-provenance.test.ts: cq-signal is a wake-up only
// (ADR-0004 D-B). Shared helpers live in policy-provenance.helpers.ts.
import { describe, expect, it } from 'vitest';
import { bothCopies, code, jobBlocks, onBlock, steps } from './policy-provenance.helpers.js';

describe('cq-signal is a wake-up only (ADR-0004 D-B)', () => {
  it.each(bothCopies('cq-signal.yml'))(
    '%s: head-defined, holds nothing, does nothing',
    (_label, text) => {
      const body = code(text);
      const on = onBlock(body);
      expect(on).toMatch(
        /^ {2}pull_request:\n {4}types:\n {6}- opened\n {6}- synchronize\n {6}- reopened\n {6}- ready_for_review\n {2}pull_request_review:$/m,
      );
      // Debounced (development posture, 2026-10-20): comments, edits and
      // label events no longer wake the verifiers; cq-accept's sweep reconciles.
      expect(on).not.toMatch(/pull_request_review_comment|- edited|labeled/);
      expect(on).not.toMatch(/^ {2}push:/m);
      expect(on).not.toMatch(/pull_request_target|workflow_run|workflow_dispatch/);
      expect(body).toMatch(/^permissions: \{\}$/m);
      const jobs = jobBlocks(body);
      expect([...jobs.keys()]).toEqual(['signal']);
      const job = jobs.get('signal') ?? '';
      expect(job).toMatch(/^ {4}permissions: \{\}$/m);
      expect(steps(job)).toHaveLength(1);
      expect(job).toMatch(/^ {8}run: 'true'$/m);
      expect(body).not.toMatch(/secrets\.|github\.token|GH_TOKEN/);
      expect(body).not.toMatch(/uses:|actions\/checkout|environment:/);
    },
  );
});
