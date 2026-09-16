// E4 slice 1 — tests for fixReviewItem (src/ops/review/fixReviewItem.ts).
//
// Pinned here:
//   1. Happy path: complete + valid structured output → ok {changed,
//      summary, commits}; the OpInvocation the fake received carries the
//      conservative defaults — allowlist mode, allow ['read','edit'], NO
//      'run' (the deny-all default stays out), sandbox workspace-write,
//      modelSpec and budget passthrough.
//   2. Harness config with run enabled + non-empty commandPatterns → 'run'
//      joins the allow list; edit disabled → 'edit' drops out.
//   3. promptOverride replaces the default prompt wholesale; the shipped
//      default is used otherwise (the fake records prompts).
//   4. Truncation: a maxSystemPromptChars below the composed system prompt
//      → truncated true + head-truncated text; a comment over
//      MAX_COMMENT_CHARS → truncated true + head-capped comment.
//   5. Structured output as a one-line JSON STRING parses; malformed,
//      wrong-shaped, extra-key, and non-string-commit outputs → failed.
//   6. Stop reasons: budget → budget-exhausted; error → failed; aborted →
//      indeterminate.
//   7. usage + denials ride the ok result verbatim.
//   8. Registry entry: name 'review.fixItem' (the family carries the six
//      review-loop ops — enumerated in registry.test.ts); the inputSchema
//      accepts a minimal valid input and rejects an unknown key, pr 0, and
//      a missing worktree; the importer resolves to a callable op
//      (SubprocessDriver constructs with zero env deps and spawns nothing).
//   9. md/constant parity: prompts/fix.default.md on disk is byte-identical
//      to defaultFixPrompt (the .md cannot rot away from the shipped
//      constant).
//
// Hermetic by construction: the Driver seam is a scripted fake — no
// network, no spawned processes, no filesystem writes; the registry test
// only CONSTRUCTS the driver's importer result.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type { Driver, OpInvocation, WorkerResult } from '../../../src/driver/types.js';
import type { HarnessConfig } from '../../../src/harness/config.js';
import { defaultHarnessConfig } from '../../../src/harness/config.js';
import { MAX_COMMENT_CHARS, makeFixReviewItem } from '../../../src/ops/review/fixReviewItem.js';
import type {
  FixReviewItemInput,
  FixReviewItemResult,
} from '../../../src/ops/review/fixReviewItem.js';
import { defaultFixPrompt } from '../../../src/ops/review/prompts/fix.default.js';
import { registry } from '../../../src/ops/review/registry.js';

// ---------------------------------------------------------------------------
// Fixtures — a scripted Driver and a minimal valid input
// ---------------------------------------------------------------------------

/** A Driver scripted with canned WorkerResults, recording every invocation. */
const scriptedDriver = (
  results: WorkerResult[],
): { driver: Driver; invocations: OpInvocation[] } => {
  const invocations: OpInvocation[] = [];
  return {
    invocations,
    driver: {
      run: async (invocation) => {
        invocations.push(invocation);
        const next = results.shift();
        if (next === undefined) {
          throw new Error('scriptedDriver: no scripted result left');
        }
        return next;
      },
    },
  };
};

/** A 'complete' WorkerResult overridable field by field. */
const completeWorker = (
  structuredOutput: unknown,
  extra?: Partial<WorkerResult>,
): WorkerResult => ({
  structuredOutput,
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
  denials: [],
  stopReason: 'complete',
  ...extra,
});

/** Minimal valid input overridable field by field. */
const baseInput = (extra?: Partial<FixReviewItemInput>): FixReviewItemInput => ({
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
const harnessWith = (mutate: (harness: HarnessConfig) => void): HarnessConfig => {
  const harness = structuredClone(defaultHarnessConfig) as HarnessConfig;
  mutate(harness);
  return harness;
};

/** Unwrap an ok result (or fail the test naming the actual status). */
const expectOk = (
  result: Awaited<ReturnType<ReturnType<typeof makeFixReviewItem>>>,
): FixReviewItemResult => {
  if (result.status !== 'ok') {
    throw new Error(`expected status 'ok', got '${result.status}'`);
  }
  return result.value;
};

// ---------------------------------------------------------------------------
// 1. Happy path + invocation shape
// ---------------------------------------------------------------------------

describe('fixReviewItem happy path', () => {
  test('complete + valid structured output → ok triple; the invocation carries the conservative defaults', async () => {
    const { driver, invocations } = scriptedDriver([
      completeWorker({ changed: true, summary: 'Guarded the abort.', commits: ['abc123'] }),
    ]);
    const op = makeFixReviewItem({ driver });
    const value = expectOk(await op(baseInput({ budget: { maxTokens: 12_345 } })));
    expect(value).toEqual({
      changed: true,
      summary: 'Guarded the abort.',
      commits: ['abc123'],
      denials: [],
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    });
    expect('truncated' in value).toBe(false);
    expect(invocations).toHaveLength(1);
    const invocation = invocations[0] as OpInvocation;
    expect(invocation.toolPolicy).toEqual({ mode: 'allowlist', allow: ['read', 'edit'] });
    expect(invocation.sandboxPolicy).toEqual({ level: 'workspace-write' });
    expect(invocation.modelSpec).toEqual({ model: 'test-model', provider: 'test-provider' });
    expect(invocation.budget).toEqual({ maxTokens: 12_345 });
  });

  test('budget omitted → the invocation carries the empty budget', async () => {
    const { driver, invocations } = scriptedDriver([
      completeWorker({ changed: false, summary: 'Already addressed.', commits: [] }),
    ]);
    const value = expectOk(await makeFixReviewItem({ driver })(baseInput()));
    expect(value.changed).toBe(false);
    expect(invocations[0]?.budget).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 2. Harness-driven allowlist
// ---------------------------------------------------------------------------

describe('fixReviewItem tool allowlist', () => {
  test('run enabled with non-empty commandPatterns → allow includes run', async () => {
    const harness = harnessWith((h) => {
      h.tools.run.commandPatterns = ['npm test'];
    });
    const { driver, invocations } = scriptedDriver([
      completeWorker({ changed: false, summary: 'n/a', commits: [] }),
    ]);
    await makeFixReviewItem({ driver })(baseInput({ harness }));
    expect(invocations[0]?.toolPolicy).toEqual({
      mode: 'allowlist',
      allow: ['read', 'edit', 'run'],
    });
  });

  test('edit disabled → allow drops edit', async () => {
    const harness = harnessWith((h) => {
      h.tools.edit.enabled = false;
    });
    const { driver, invocations } = scriptedDriver([
      completeWorker({ changed: false, summary: 'n/a', commits: [] }),
    ]);
    await makeFixReviewItem({ driver })(baseInput({ harness }));
    expect(invocations[0]?.toolPolicy).toEqual({ mode: 'allowlist', allow: ['read'] });
  });

  test('run enabled but commandPatterns empty (the deny-all default) → run stays out', async () => {
    const harness = harnessWith((h) => {
      h.tools.run.enabled = true;
      h.tools.run.commandPatterns = [];
    });
    const { driver, invocations } = scriptedDriver([
      completeWorker({ changed: false, summary: 'n/a', commits: [] }),
    ]);
    await makeFixReviewItem({ driver })(baseInput({ harness }));
    expect(invocations[0]?.toolPolicy).toEqual({ mode: 'allowlist', allow: ['read', 'edit'] });
  });
});

// ---------------------------------------------------------------------------
// 3. Prompt override / default
// ---------------------------------------------------------------------------

describe('fixReviewItem system prompt', () => {
  test('without override the shipped default is the system prompt', async () => {
    const { driver, invocations } = scriptedDriver([
      completeWorker({ changed: false, summary: 'n/a', commits: [] }),
    ]);
    await makeFixReviewItem({ driver })(baseInput());
    const prompt = invocations[0]?.prompt ?? '';
    expect(prompt.startsWith(`${defaultFixPrompt}\n\n`)).toBe(true);
  });

  test('promptOverride REPLACES the default wholesale', async () => {
    const { driver, invocations } = scriptedDriver([
      completeWorker({ changed: false, summary: 'n/a', commits: [] }),
    ]);
    await makeFixReviewItem({ driver })(baseInput({ promptOverride: 'OVERRIDE PROMPT' }));
    const prompt = invocations[0]?.prompt ?? '';
    expect(prompt.startsWith('OVERRIDE PROMPT\n\n')).toBe(true);
    expect(prompt.includes(defaultFixPrompt)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Truncation
// ---------------------------------------------------------------------------

describe('fixReviewItem truncation', () => {
  test('system prompt over maxSystemPromptChars → truncated true + head-truncated', async () => {
    const harness = harnessWith((h) => {
      h.promptBudget.maxSystemPromptChars = 50;
    });
    const { driver, invocations } = scriptedDriver([
      completeWorker({ changed: false, summary: 'n/a', commits: [] }),
    ]);
    const value = expectOk(await makeFixReviewItem({ driver })(baseInput({ harness })));
    expect(value.truncated).toBe(true);
    const prompt = invocations[0]?.prompt ?? '';
    expect(prompt.slice(0, 50)).toBe(defaultFixPrompt.slice(0, 50));
    expect(prompt.includes(defaultFixPrompt)).toBe(false);
  });

  test(`a comment over MAX_COMMENT_CHARS (${MAX_COMMENT_CHARS}) → truncated true + head-capped`, async () => {
    const { driver, invocations } = scriptedDriver([
      completeWorker({ changed: false, summary: 'n/a', commits: [] }),
    ]);
    const input = baseInput();
    input.item.comments = [
      { authorLogin: 'reviewer', body: 'x'.repeat(MAX_COMMENT_CHARS + 1), createdAt: null },
    ];
    const value = expectOk(await makeFixReviewItem({ driver })(input));
    expect(value.truncated).toBe(true);
    const prompt = invocations[0]?.prompt ?? '';
    expect(prompt.includes('x'.repeat(MAX_COMMENT_CHARS))).toBe(true);
    expect(prompt.includes('x'.repeat(MAX_COMMENT_CHARS + 1))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Structured output parsing
// ---------------------------------------------------------------------------

describe('fixReviewItem structured output', () => {
  test('a one-line JSON STRING parses into the triple', async () => {
    const { driver } = scriptedDriver([
      completeWorker('{"changed": false, "summary": "Already addressed.", "commits": []}'),
    ]);
    const value = expectOk(await makeFixReviewItem({ driver })(baseInput()));
    expect(value).toEqual({
      changed: false,
      summary: 'Already addressed.',
      commits: [],
      denials: [],
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    });
  });

  test.each([
    ['missing output', undefined],
    ['unparseable string', 'not json at all'],
    ['non-object JSON', '[1,2,3]'],
    ['wrong shape', { changed: 'yes', summary: 'n/a', commits: [] }],
    ['extra key', { changed: true, summary: 's', commits: [], session: 'x' }],
    ['non-string commit sha', { changed: true, summary: 's', commits: [42] }],
    ['missing commits key', { changed: true, summary: 's' }],
  ])('%s → failed', async (_name, structuredOutput) => {
    const { driver } = scriptedDriver([completeWorker(structuredOutput)]);
    const result = await makeFixReviewItem({ driver })(baseInput());
    expect(result.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// 6. Stop-reason mapping
// ---------------------------------------------------------------------------

describe('fixReviewItem stop reasons', () => {
  test('budget → budget-exhausted', async () => {
    const { driver } = scriptedDriver([completeWorker(undefined, { stopReason: 'budget' })]);
    const result = await makeFixReviewItem({ driver })(baseInput());
    expect(result).toEqual({ status: 'budget-exhausted' });
  });

  test('error → failed', async () => {
    const { driver } = scriptedDriver([
      completeWorker(undefined, { stopReason: 'error', sessionId: 'sess-1' }),
    ]);
    const result = await makeFixReviewItem({ driver })(baseInput());
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('sess-1');
    }
  });

  test('aborted → indeterminate', async () => {
    const { driver } = scriptedDriver([completeWorker(undefined, { stopReason: 'aborted' })]);
    const result = await makeFixReviewItem({ driver })(baseInput());
    expect(result.status).toBe('indeterminate');
  });

  test('a driver that rejects → indeterminate (no verdict on partial work)', async () => {
    const driver: Driver = {
      run: async () => {
        throw new Error('boom below the seam');
      },
    };
    const result = await makeFixReviewItem({ driver })(baseInput());
    expect(result.status).toBe('indeterminate');
    if (result.status === 'indeterminate') {
      expect(result.detail).toContain('boom below the seam');
    }
  });
});

// ---------------------------------------------------------------------------
// 7. usage + denials passthrough
// ---------------------------------------------------------------------------

describe('fixReviewItem worker evidence passthrough', () => {
  test('usage (reasoning included) and denials ride the ok result verbatim', async () => {
    const denials = [{ tool: 'run', reason: 'denied by policy' }];
    const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5 };
    const { driver } = scriptedDriver([
      completeWorker({ changed: true, summary: 's', commits: ['abc'] }, { denials, usage }),
    ]);
    const value = expectOk(await makeFixReviewItem({ driver })(baseInput()));
    expect(value.usage).toEqual(usage);
    expect(value.denials).toEqual(denials);
  });
});

// ---------------------------------------------------------------------------
// 8. Registry entry
// ---------------------------------------------------------------------------

describe('review.fixItem registry entry', () => {
  /**
   * The family's fixItem entry. The family registry carries the SIX
   * review-loop ops (enumerated exhaustively in registry.test.ts); this
   * block pins only the fixItem entry's own contract.
   */
  const fixEntry = () => {
    const entry = registry.find((candidate) => candidate.name === 'review.fixItem');
    if (entry === undefined) {
      throw new Error("missing registry entry 'review.fixItem'");
    }
    return entry;
  };

  test("the family registry carries a 'review.fixItem' entry", () => {
    expect(registry.some((entry) => entry.name === 'review.fixItem')).toBe(true);
  });

  test('inputSchema accepts the minimal valid input', () => {
    const entry = fixEntry();
    const minimal = {
      pr: 1,
      item: {
        id: 'T1',
        path: null,
        line: null,
        body: 'fix me',
        comments: [],
      },
      worktree: { path: '/tmp/cq-fix-review/pr-1', branch: 'cq-review/pr-1' },
      driver: { model: 'm', provider: 'p' },
    };
    expect(entry.inputSchema.safeParse(minimal).success).toBe(true);
  });

  test.each([
    [
      'an unknown key',
      (minimal: Record<string, unknown>) => {
        minimal['extra'] = 1;
      },
    ],
    [
      'pr 0',
      (minimal: Record<string, unknown>) => {
        minimal['pr'] = 0;
      },
    ],
    [
      'a missing worktree',
      (minimal: Record<string, unknown>) => {
        delete minimal['worktree'];
      },
    ],
  ])('inputSchema rejects %s', (_name, mutate) => {
    const entry = fixEntry();
    const minimal: Record<string, unknown> = {
      pr: 1,
      item: { id: 'T1', path: null, line: null, body: 'fix me', comments: [] },
      worktree: { path: '/tmp/cq-fix-review/pr-1', branch: 'cq-review/pr-1' },
      driver: { model: 'm', provider: 'p' },
    };
    mutate(minimal);
    expect(entry.inputSchema.safeParse(minimal).success).toBe(false);
  });

  test('the importer resolves to a callable op (SubprocessDriver constructs env-free)', async () => {
    const entry = fixEntry();
    const op = await entry.importer();
    expect(typeof op).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// 9. md/constant parity
// ---------------------------------------------------------------------------

describe('fix.default.md ⇄ defaultFixPrompt parity', () => {
  test('the shipped .md is byte-identical to the TS constant', () => {
    const mdPath = fileURLToPath(
      new URL('../../../src/ops/review/prompts/fix.default.md', import.meta.url),
    );
    expect(defaultFixPrompt).toBe(readFileSync(mdPath, 'utf8'));
  });
});
