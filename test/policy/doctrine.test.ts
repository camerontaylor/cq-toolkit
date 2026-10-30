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
});
