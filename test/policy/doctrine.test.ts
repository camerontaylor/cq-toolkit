import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('doctrine promotion entitlement facts', () => {
  it('documents eligible first-parent subjects and the atomic ref leases', () => {
    // #269: the canonical policy must allow an eligible prefix to promote
    // while a newer queue tip waits. The gate's existing selection and push
    // contracts, rather than a queue-tip equality requirement, are authoritative.
    const doctrine = readFileSync(new URL('../../policy/DOCTRINE.md', import.meta.url), 'utf8');
    const facts = doctrine.split('### Entitlement facts\n')[1]?.split('\n## I4')[0];
    expect(facts).toBeDefined();
    const text = facts?.replace(/\s+/g, ' ');
    expect(text).not.toContain('merge-queue-tip guard');
    expect(text).toContain('newest eligible subject on the `main..tip` first-parent line');
    expect(text).toContain('the subject may precede the queue tip');
    expect(text).toContain('already-contained history a no-op and refuse divergence');
    expect(text).toContain('atomic leased push');
    expect(text).toContain(
      '`main` and the `cq/promoted` replay marker advance to the selected subject',
    );
    expect(text).toContain('`merge-queue` stays at the observed tip');
    expect(text).toContain('Leases reject concurrent movement of any of those refs');
  });

  it('keeps current enforcement and template comments aligned on all three refs', () => {
    const doctrine = readFileSync(new URL('../../policy/DOCTRINE.md', import.meta.url), 'utf8');
    const i3 = doctrine.split('## I3 —')[1]?.split('### Entitlement facts')[0];
    expect(i3).toBeDefined();
    const enforcement = i3?.split('**Enforcement (today).**')[1]?.replace(/\s+/g, ' ');
    expect(enforcement).toBeDefined();
    const template = readFileSync(
      new URL('../../policy/templates/gate.yml', import.meta.url),
      'utf8',
    );
    const comments = template
      .split('\n')
      .filter((line) => line.startsWith('#'))
      .map((line) => line.replace(/^#\s?/, ''))
      .join(' ')
      .replace(/\s+/g, ' ');

    // The current gate's ref set comes from promote-gate.ts, not the retired
    // main-only implementation. Keep every earlier entitlement assertion.
    for (const refspec of [
      '<subject>:refs/heads/main',
      '<subject>:refs/heads/cq/promoted',
      '<tip>:refs/heads/merge-queue',
    ]) {
      expect(enforcement).toContain(refspec);
      expect(comments).toContain(refspec);
    }
    expect(enforcement).toContain('one atomic leased push');
    expect(enforcement).toContain('`main` advances only by fast-forward');
    expect(enforcement).toContain('the queue ref retains the observed tip');
    expect(enforcement).toContain('rejection prevents every update');
    expect(comments).toContain('one atomic leased push');
    expect(comments).toContain('Main advances only by fast-forward');
    expect(comments).toContain('the queue ref retains the observed tip');
    expect(comments).toContain('rejection prevents every update');
    expect(comments).not.toContain('single main-refspec');
    expect(comments).not.toContain('the queue is never written');
    expect(comments).not.toContain('template is kept adopter-only');
  });
});
