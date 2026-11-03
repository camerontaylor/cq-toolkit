// Split provenance: test/ops/review/fixReviewItem.test.ts was split into the
// fixReviewItem.*.test.ts siblings in this directory; the shared fixtures live
// here. The original suite header is kept at the top of this module.
// E4 slice 1 + S4b-B — tests for fixReviewItem (src/ops/review/fixReviewItem.ts).
//
// Pinned here:
//   1. Happy path: complete + valid structured output → ok {changed,
//      summary, commits}; the OpInvocation the fake received carries the
//      conservative defaults — allowlist mode, allow ['read','edit'], NO
//      'run' (the deny-all default stays out), sandbox workspace-write,
//      the FACTORY-RESOLVED modelSpec, the worktree as the invocation's
//      workspace binding, the fix contract as the invocation's
//      outputSchema, NO sessionRef, and the budget passthrough.
//   2. Harness config with run enabled + non-empty commandPatterns → 'run'
//      joins the allow list; edit disabled → 'edit' drops out.
//   3. promptOverride replaces the default prompt wholesale; the shipped
//      default is used otherwise (the fake records prompts).
//   4. Truncation: a maxSystemPromptChars below the composed system prompt
//      → truncated true + head-truncated text; a comment over
//      MAX_COMMENT_CHARS → truncated true + head-capped comment.
//   5. Structured output as a one-line JSON STRING parses; malformed,
//      wrong-shaped, extra-key, and non-string-commit outputs → failed.
//   6. Stop reasons per ADR-0002 §2.9: budget → budget-exhausted; error →
//      failed with errorClass=<x> named in the text; aborted →
//      indeterminate; a thrown resolve()/run() under an aborted governed
//      signal → indeterminate, any other throw → needs-human.
//   7. usage + denials ride the ok result verbatim.
//   8. Factory request shape (ADR-0002 §2.5): role 'fixer', the input's
//      ModelSpec, the harness passthrough (input.harness ?? the
//      conservative default), sessionRetention mapped from the op's
//      retainSessions dep (true → 'keep', false/absent →
//      'reap-on-settle'). The factory's own reap behaviour is tested in
//      test/driver/factory.test.ts — only the REQUEST is pinned here.
//   9. Registry entry: name 'review.fixItem' (the family carries the six
//      review-loop ops — enumerated in registry.test.ts); the inputSchema
//      accepts a minimal valid input and rejects an unknown key, pr 0, and
//      a missing worktree; the importer resolves to a callable op (the
//      driver factory constructs inert lane instances — zero env deps).
//
// Hermetic by construction: the DriverFactory seam is a scripted fake — no
// network, no spawned processes, no filesystem writes; the registry test
// only CONSTRUCTS the driver's importer result.
import type { DriverFactory, DriverRequest } from '../../../src/driver/factory.js';
import type { OpInvocation, WorkerResult } from '../../../src/driver/types.js';
import type { HarnessConfig } from '../../../src/harness/config.js';
import { defaultHarnessConfig } from '../../../src/harness/config.js';
import { makeFixReviewItem } from '../../../src/ops/review/fixReviewItem.js';
import type {
  FixReviewItemInput,
  FixReviewItemResult,
} from '../../../src/ops/review/fixReviewItem.js';

// ---------------------------------------------------------------------------
// Fixtures — a scripted DriverFactory and a minimal valid input
// ---------------------------------------------------------------------------

/**
 * A DriverFactory scripted with canned WorkerResults (ADR-0002 §2.5 fake —
 * the real factory's resolve/reap/served-model behaviour is the factory's
 * own tests). Records every DriverRequest and every OpInvocation the op
 * sends; the resolved modelSpec mirrors the factory contract (the spec the
 * op must put on the invocation — distinct from the input's spec whenever
 * the deprecated 'ai-sdk' alias normalises).
 */
export const scriptedFactory = (
  results: WorkerResult[],
): {
  drivers: DriverFactory;
  requests: DriverRequest[];
  invocations: OpInvocation[];
} => {
  const requests: DriverRequest[] = [];
  const invocations: OpInvocation[] = [];
  return {
    requests,
    invocations,
    drivers: {
      resolve: (req) => {
        requests.push(req);
        return {
          driver: {
            run: async (invocation) => {
              invocations.push(invocation);
              const next = results.shift();
              if (next === undefined) {
                throw new Error('scriptedFactory: no scripted result left');
              }
              return next;
            },
          },
          lane: 'ai-sdk',
          // The deprecated alias normalises away — the invocation must
          // carry THIS spec, never the input's.
          modelSpec:
            req.modelSpec.provider === 'ai-sdk'
              ? { ...req.modelSpec, provider: 'zai' }
              : req.modelSpec,
        };
      },
    },
  };
};

/** A scripted factory plus the op built over it (the common test shape). */
export const scriptedOp = (results: WorkerResult[], retainSessions?: boolean) => {
  const scripted = scriptedFactory(results);
  return {
    requests: scripted.requests,
    invocations: scripted.invocations,
    op: makeFixReviewItem({
      drivers: scripted.drivers,
      ...(retainSessions === undefined ? {} : { retainSessions }),
    }),
  };
};

/** A 'complete' WorkerResult overridable field by field. */
export const completeWorker = (
  structuredOutput: unknown,
  extra?: Partial<WorkerResult>,
): WorkerResult => ({
  structuredOutput,
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
  denials: [],
  stopReason: 'complete',
  model: 'test-model',
  ...extra,
});

/** A real no-change disposition: the outcome AND its reason. */
export const NO_CHANGE = 'Already satisfied: src/a.ts line 3 already handles this case.';

/** A v2 no-change outcome: the disposition, its reason and the evidence. */
export const UNCHANGED = {
  disposition: 'unchanged_with_reason',
  summary: NO_CHANGE,
  commits: [],
  evidence: [{ path: 'src/a.ts', line: 3 }],
};

/** Minimal valid input overridable field by field. */
export const baseInput = (extra?: Partial<FixReviewItemInput>): FixReviewItemInput => ({
  pr: 7,
  item: {
    id: 'PRRT_kwDOAbc123',
    path: 'src/a.ts',
    line: 42,
    body: 'The retry loop swallows the abort signal.',
    comments: [
      {
        authorLogin: 'reviewer',
        body: 'Also check the timeout path.',
        createdAt: '2026-09-15T10:00:00Z',
      },
    ],
  },
  worktree: { path: '/tmp/cq-fix-review/pr-7', branch: 'cq-review/pr-7' },
  driver: { model: 'test-model', provider: 'test-provider' },
  ...extra,
});

/** An unfrozen HarnessConfig copy, mutated by `mutate` for one scenario. */
export const harnessWith = (mutate: (harness: HarnessConfig) => void): HarnessConfig => {
  const harness = structuredClone(defaultHarnessConfig) as HarnessConfig;
  mutate(harness);
  return harness;
};

/** Unwrap an ok result (or fail the test naming the actual status). */
export const expectOk = (
  result: Awaited<ReturnType<ReturnType<typeof makeFixReviewItem>>>,
): FixReviewItemResult => {
  if (result.status !== 'ok') {
    throw new Error(`expected status 'ok', got '${result.status}'`);
  }
  return result.value;
};
