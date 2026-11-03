// Split provenance: test/ops/review/reviewSession-wire.test.ts was split into
// subject files sharing ./reviewSession-wire.helpers.ts. This file holds the
// outer reviewer path-scoped refusal suite.
import { describe, expect, it } from 'vitest';
import { runAgentReviewer } from '../../../src/ops/review/agentReviewer.js';
import {
  COMPONENT,
  DIFF,
  recordingScanner,
  role,
  scratch,
  severityMap,
  useScratchRoots,
} from './reviewSession-wire.helpers.js';

useScratchRoots();

describe('review session wire hook', () => {
  it('refuses a path-scoped component before dispatch through the outer reviewer', async () => {
    const root = await scratch();
    let resolveCalls = 0;
    const result = await runAgentReviewer(
      {
        resolve: () => {
          resolveCalls += 1;
          throw new Error('must not dispatch');
        },
      },
      {
        repoRoot: root,
        head: 'a'.repeat(40),
        branch: 'feature',
        base: 'b'.repeat(40),
        scope: 'full',
        diff: DIFF,
        components: [COMPONENT],
        scanSecrets: recordingScanner([], (component) => component.path === 'src/a.ts'),
        role,
        maxTokens: 1000,
        wallMs: 1000,
        severityMap,
      },
    );
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('protected content');
    expect(resolveCalls).toBe(0);
  });
});
