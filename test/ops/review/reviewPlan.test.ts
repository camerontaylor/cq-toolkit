import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { REVIEW_SESSION_DEFAULTS } from '../../../src/ops/analyze/cqConfig.js';
import { defaultHarnessConfig } from '../../../src/harness/config.js';
import type { ScanComponentInput } from '../../../src/ops/dev/denylist.js';
import type { Finding } from '../../../src/ops/review/findings.js';
import {
  REVIEW_TIER_STEPS,
  createReviewPlan,
  type CreateReviewPlanInput,
  type PlannedReviewSession,
} from '../../../src/ops/review/internal/reviewPlan.js';
import {
  ReviewCoverageV2Schema,
  isCoverageV2Complete,
} from '../../../src/ops/review/internal/reviewCoverageV2.js';
import { partitionReview } from '../../../src/ops/review/internal/reviewPartitions.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);

function tracked(path: string, added: readonly string[] = ['changed']): ScanComponentInput {
  return {
    component: `tracked:${path}`,
    path,
    text: [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -1 +1,${String(added.length)} @@`,
      ...added.map((line) => `+${line}`),
      '',
    ].join('\n'),
  };
}

function untracked(path: string, text: string): ScanComponentInput {
  return { component: `untracked:${path}`, path, text };
}

function planInput(
  components: readonly ScanComponentInput[],
  extra: Partial<CreateReviewPlanInput> = {},
): CreateReviewPlanInput {
  return { head, base, scope: 'full', components, ...extra };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    source: 'agent',
    severity: 'major',
    text: 'stale producer',
    status: 'open',
    ...overrides,
  };
}

function expectExactPlacements(
  session: PlannedReviewSession,
  componentText: ReadonlyMap<string, string>,
): void {
  for (const placement of session.placements) {
    const source = componentText.get(placement.component);
    expect(source).toBeDefined();
    const length = placement.end - placement.start;
    expect(session.prompt.slice(placement.offset, placement.offset + length)).toBe(
      source!.slice(placement.start, placement.end),
    );
  }
}

describe('createReviewPlan session mode', () => {
  it('plans one piece per original component and sends every reviewed byte once', () => {
    const components = [
      tracked('src/a.ts', ['export const a = 1;', 'export const b = 2;']),
      untracked('src/new.ts', 'export function fresh(): number {\n  return 1;\n}\n'),
    ];
    const plan = createReviewPlan(
      planInput(components, {
        branch: 'fix/483-c',
        intent: 'Align the reviewer prompt with the tools it has.',
        fileList: '2\t0\tsrc/a.ts\n3\t0\tsrc/new.ts',
      }),
    );

    expect(plan.coverage.version).toBe(2);
    expect(plan.coverage.head).toBe(head);
    expect(plan.coverage.base).toBe(base);
    expect(plan.coverage.scope).toBe('full');
    expect(plan.coverage.mode).toBe('session');
    expect(plan.coverage.modeReason).toContain('small');
    expect(plan.coverage.sessions).toEqual([]);
    expect(plan.coverage.pieces).toHaveLength(2);
    expect(plan.coverage.pieces.map((piece) => piece.state)).toEqual(['planned', 'planned']);
    for (const [index, component] of components.entries()) {
      expect(plan.coverage.pieces[index]).toMatchObject({
        component: component.component,
        path: component.path,
        sha256: sha256(component.text),
        chars: component.text.length,
        bytes: Buffer.byteLength(component.text, 'utf8'),
      });
    }
    expect(isCoverageV2Complete(plan.coverage)).toBe(false);
    expect(() => ReviewCoverageV2Schema.parse(plan.coverage)).not.toThrow();

    expect(plan.sessions).toHaveLength(1);
    const [session] = plan.sessions;
    expect(session!.id).toBe('session-1');
    expect(session!.tools).toBe(true);
    expect(session!.placements.map((placement) => placement.component)).toEqual([
      'tracked:src/a.ts',
      'untracked:src/new.ts',
    ]);
    expectExactPlacements(
      session!,
      new Map(
        components.map((component): [string, string] => [component.component, component.text]),
      ),
    );
    for (const component of components)
      expect(session!.prompt.split(component.text)).toHaveLength(2);
    expect(session!.prompt).toContain('Branch: fix/483-c');
    expect(session!.prompt).toContain('## Intent');
    expect(session!.prompt).toContain('Align the reviewer prompt');
    expect(session!.prompt).toContain('## Changed files');
    expect(session!.prompt).toContain('Most reviews need 0-2 lookups');
    expect(session!.prompt).toContain('budget of 4 model steps');
    expect(session!.prompt).toContain('the last step has no tools and is your JSON answer');
    expect(session!.prompt).toContain('"findings"');
    expect(session!.prompt).not.toMatch(/receipt/i);
    expect(plan.advisories).toEqual([]);
    expect(plan.limitations).toEqual([]);
    expect('findings' in plan).toBe(false);
  });

  it('records exact builder offsets when component text repeats and data is empty', () => {
    const repeated = 'same repeated payload\n';
    const components = [
      tracked('src/a.ts', ['same repeated payload']),
      untracked('src/b.ts', repeated),
      untracked('src/c.ts', repeated),
      untracked('src/empty.ts', ''),
    ];
    const plan = createReviewPlan(
      planInput(components, {
        session: { maxInputChars: 60_000 },
      }),
    );
    expect(plan.coverage.mode).toBe('session');
    const session = plan.sessions[0]!;
    expectExactPlacements(
      session,
      new Map(
        components.map((component): [string, string] => [component.component, component.text]),
      ),
    );
    const empty = session.placements.find(
      (placement) => placement.component === 'untracked:src/empty.ts',
    );
    expect(empty).toMatchObject({ start: 0, end: 0 });
    expect(empty!.offset).toBeGreaterThan(0);
    expect(
      plan.coverage.pieces.find((piece) => piece.component === 'untracked:src/empty.ts'),
    ).toMatchObject({
      chars: 0,
      bytes: 0,
      sha256: sha256(''),
    });
  });

  it('scales the exploration budget to the medium tier and honours custom thresholds', () => {
    const components = Array.from({ length: 6 }, (_, index) =>
      tracked(`src/m${String(index)}.ts`, ['a', 'b', 'c']),
    );
    const defaults = createReviewPlan(planInput(components));
    expect(defaults.coverage.mode).toBe('session');
    expect(defaults.coverage.modeReason).toContain('medium');
    expect(defaults.sessions[0]!.prompt).toContain('Prioritise contracts other code depends on');
  });

  it('uses the documented small and medium tiers with configurable thresholds', () => {
    const three = [tracked('src/a.ts', ['a', 'b', 'c']), tracked('src/b.ts', ['d'])];
    const medium = createReviewPlan(
      planInput(three, {
        size: {
          small: { maxChangedLines: 2, maxFiles: 2 },
          medium: { maxChangedLines: 8, maxFiles: 4 },
        },
      }),
    );
    expect(medium.coverage.mode).toBe('session');
    expect(medium.coverage.modeReason).toContain('medium');
    expect(medium.sessions[0]!.prompt).toContain('Prioritise contracts other code depends on');

    const small = createReviewPlan(
      planInput([tracked('src/a.ts', ['a', 'b'])], {
        size: { small: { maxChangedLines: 2 }, medium: { maxChangedLines: 8 } },
      }),
    );
    expect(small.coverage.modeReason).toContain('small');

    const large = createReviewPlan(
      planInput(three, {
        size: { small: { maxChangedLines: 2 }, medium: { maxChangedLines: 3 } },
      }),
    );
    expect(large.coverage.mode).toBe('partitioned');
    expect(large.coverage.modeReason).toBe('large change above the medium size tier');
  });

  it('chooses the size tier from reviewed content while retaining excluded coverage', () => {
    const components = [
      tracked('src/a.ts', ['changed']),
      tracked(
        'pnpm-lock.yaml',
        Array.from({ length: 1000 }, () => 'generated'),
      ),
      ...Array.from({ length: 21 }, (_, index) => tracked(`generated/${String(index)}.ts`)),
    ];
    const plan = createReviewPlan(
      planInput(components, {
        exclude: [
          { pattern: 'pnpm-lock.yaml', assuredBy: 'lockfile check' },
          { pattern: 'generated/**', assuredBy: 'generator check' },
        ],
      }),
    );
    expect(plan.coverage.mode).toBe('session');
    expect(plan.coverage.modeReason).toContain('small');
    expect(plan.coverage.pieces.filter((piece) => piece.state === 'excluded')).toHaveLength(22);
    expect(plan.sessions[0]!.prompt).toContain('pnpm-lock.yaml');
  });

  it('adds the documentation and configuration instruction only for docs/config changes', () => {
    const docs = createReviewPlan(
      planInput([tracked('docs/guide.md', ['new value'])], {
        intent: 'Document the default.',
      }),
    );
    expect(docs.sessions[0]!.prompt).toContain(
      'check every documented value against its source of truth',
    );

    const code = createReviewPlan(
      planInput([tracked('src/value.ts', ['export const value = 1;'])]),
    );
    expect(code.sessions[0]!.prompt).not.toContain('check every documented value');
    expect(code.sessions[0]!.prompt).toContain('check every contract other code depends on');
  });

  it('includes contract scrutiny on a small diff and prior findings with dispositions', () => {
    const prior = [
      finding({
        id: 'f1',
        file: 'src/a.ts',
        line: 12,
        rule: 'causal',
        status: 'fixed',
        text: 'stale reader survived the rename',
      }),
      finding({
        id: 'f2',
        severity: 'minor',
        status: 'rejected',
        reason: 'false positive in generated file',
        text: 'generated lockfile mismatch',
      }),
    ];
    const plan = createReviewPlan(
      planInput([tracked('src/a.ts', ['export type Kind = "a" | "b";'])], { priorFindings: prior }),
    );
    const prompt = plan.sessions[0]!.prompt;
    expect(prompt).toContain('## Prior findings and dispositions');
    expect(prompt).toContain('stale reader survived the rename (fixed)');
    expect(prompt).toContain(
      'generated lockfile mismatch (rejected: false positive in generated file)',
    );
    expect(prompt).toContain('check that the fixes hold and look for regressions');
    expect(prompt).toContain('check every contract other code depends on');
  });

  it('caps intent, file list and prior-findings context at 4000 characters', () => {
    const intent = `start-${'i'.repeat(5_000)}-end`;
    const fileList = `start-${'f'.repeat(5_000)}-end`;
    const prior = [finding({ text: `start-${'p'.repeat(5_000)}-end` })];
    const plan = createReviewPlan(
      planInput([tracked('src/a.ts')], { intent, fileList, priorFindings: prior }),
    );
    const prompt = plan.sessions[0]!.prompt;
    expect(prompt).not.toContain('i'.repeat(5_000));
    expect(prompt).not.toContain('f'.repeat(5_000));
    expect(prompt).not.toContain('p'.repeat(5_000));
    expect(prompt.match(/\[truncated: /g)).toHaveLength(3);
  });

  it('never recovers placements by searching repeated text', () => {
    const marker = '### src/other.ts (component tracked:src/other.ts, UTF-16 range 0:1)';
    const components = [
      tracked('src/a.ts', [marker]),
      untracked('src/b.ts', 'prefix\n'),
      tracked('src/c.ts', [marker]),
    ];
    const plan = createReviewPlan(planInput(components));
    const session = plan.sessions[0]!;
    expect(session.prompt.split(marker).length).toBeGreaterThan(2);
    expectExactPlacements(
      session,
      new Map(
        components.map((component): [string, string] => [component.component, component.text]),
      ),
    );
  });

  it('keeps a session above the default harness prompt cap but inside the session budget', () => {
    const text = 'y'.repeat(25_000);
    const plan = createReviewPlan(planInput([untracked('src/wide.ts', text)]));
    expect(plan.coverage.mode).toBe('session');
    expect(plan.sessions[0]!.tools).toBe(true);
    expect(plan.sessions[0]!.prompt.length).toBeGreaterThan(20_000);
    expect(plan.sessions[0]!.prompt.length).toBeLessThanOrEqual(60_000);
    const placement = plan.sessions[0]!.placements[0]!;
    expect(
      plan.sessions[0]!.prompt.slice(
        placement.offset,
        placement.offset + (placement.end - placement.start),
      ),
    ).toBe(text);
  });
});

describe('createReviewPlan session step budget', () => {
  const small = tracked('src/a.ts', ['export const a = 1;']);
  const medium = tracked(
    'src/big.ts',
    Array.from({ length: 400 }, (_, index) => `export const v${String(index)} = ${String(index)};`),
  );

  it('gives a small change the small-tier budget and says so in the prompt', () => {
    const session = createReviewPlan(planInput([small])).sessions[0]!;
    expect(session.maxSteps).toBe(REVIEW_TIER_STEPS.small);
    expect(session.maxSteps).toBeLessThan(REVIEW_SESSION_DEFAULTS.maxSteps);
    expect(session.prompt).toContain(`budget of ${String(REVIEW_TIER_STEPS.small)} model steps`);
    expect(session.prompt).toContain('Stop and answer');
  });

  it('gives a medium change the larger medium-tier budget', () => {
    const session = createReviewPlan(planInput([medium])).sessions[0]!;
    expect(session.maxSteps).toBe(REVIEW_TIER_STEPS.medium);
    expect(session.prompt).toContain(`budget of ${String(REVIEW_TIER_STEPS.medium)} model steps`);
  });

  it('never exceeds a lower configured session.maxSteps', () => {
    const session = createReviewPlan(planInput([small], { session: { maxSteps: 2 } })).sessions[0]!;
    expect(session.maxSteps).toBe(2);
    expect(session.prompt).toContain('budget of 2 model steps');
  });
});

describe('createReviewPlan partitioned fallback', () => {
  it('falls back above the medium tier with tool-less plain partitions and no receipt', () => {
    const components = Array.from({ length: 21 }, (_, index) =>
      tracked(`src/f${String(index)}.ts`, ['export const value = 1;']),
    );
    const plan = createReviewPlan(planInput(components, { priorFindings: [finding()] }));
    expect(plan.coverage.mode).toBe('partitioned');
    expect(plan.coverage.modeReason).toBe('large change above the medium size tier');
    expect(plan.coverage.pieces).toHaveLength(21);
    expect(plan.sessions).toHaveLength(21);
    expect(plan.sessions.map((session) => session.id)).toEqual(
      components.map((_, index) => `partition-${String(index + 1)}`),
    );
    expect(new Set(plan.sessions.map((session) => session.id)).size).toBe(21);
    expect(plan.sessions.every((session) => !session.tools)).toBe(true);
    expect(plan.advisories).toHaveLength(1);
    expect(plan.advisories[0]).toContain('large change: 21 changed lines across 21 files');
    expect(plan.advisories[0]).toContain('partitioned fallback');
    expect('findings' in plan).toBe(false);
    const textByComponent = new Map<string, string>(
      components.map((component): [string, string] => [component.component, component.text]),
    );
    for (const session of plan.sessions) {
      expect(session.prompt).not.toMatch(/receipt/i);
      expect(session.prompt).toContain('Prior findings and dispositions');
      expect(session.prompt).toContain('stale producer (open)');
      expect(session.prompt).toContain('check that the fixes hold and look for regressions');
      expect(session.prompt).toContain('check every contract other code depends on');
      expect(session.prompt).not.toContain('check every documented value');
      expect(session.prompt).toContain('partition data');
      expectExactPlacements(session, textByComponent);
      expect(() => ReviewCoverageV2Schema.parse(plan.coverage)).not.toThrow();
    }
    expect(plan.coverage.sessions).toEqual([]);
    expect(isCoverageV2Complete(plan.coverage)).toBe(false);
  });

  it('retains bounded intent, visible excluded paths, prior dispositions and docs/config guidance', () => {
    const reviewed = Array.from({ length: 21 }, (_, index) =>
      tracked(`docs/note-${String(index)}.md`, ['doc value']),
    );
    const excluded = tracked('docs/generated.md', ['generated bytes']);
    const plan = createReviewPlan(
      planInput([...reviewed, excluded], {
        intent: 'Document the new default accurately.',
        fileList: '1\t0\tdocs/note-0.md',
        priorFindings: [
          finding({
            file: 'docs/note-0.md',
            line: 1,
            rule: 'docs',
            status: 'fixed',
            reason: 'value corrected',
            text: 'stale documented value',
          }),
        ],
        exclude: [{ pattern: 'docs/generated.md', assuredBy: 'dev.check generated docs' }],
      }),
    );
    expect(plan.coverage.mode).toBe('partitioned');
    expect(plan.sessions).toHaveLength(21);
    expect(plan.coverage.pieces.find((piece) => piece.path === 'docs/generated.md')).toMatchObject({
      state: 'excluded',
    });
    expect(plan.limitations).toEqual([]);
    const textByComponent = new Map<string, string>(
      reviewed.map((component): [string, string] => [component.component, component.text]),
    );
    for (const session of plan.sessions) {
      const prompt = session.prompt;
      expect(prompt).toContain('Document the new default accurately.');
      expect(prompt).toContain('Changed files (excluded paths remain listed as context):');
      expect(prompt).toContain('docs/generated.md');
      expect(prompt).toContain('stale documented value (fixed: value corrected)');
      expect(prompt).toContain('check that the fixes hold and look for regressions');
      expect(prompt).toContain('check every documented value against its source of truth');
      expect(prompt).not.toContain('check every contract other code depends on');
      expect(prompt).not.toContain('generated bytes');
      expect(prompt.length).toBeLessThanOrEqual(
        defaultHarnessConfig.promptBudget.maxSystemPromptChars,
      );
      expectExactPlacements(session, textByComponent);
      const placement = session.placements[0]!;
      expect(placement.offset + (placement.end - placement.start)).toBe(prompt.length);
    }
  });

  it('keeps a long bounded instruction prefix inside the partition prompt cap', () => {
    const cap = defaultHarnessConfig.promptBudget.maxSystemPromptChars;
    const long = 'z'.repeat(30_000);
    const components = [
      untracked('src/long.ts', long),
      ...Array.from({ length: 20 }, (_, index) => tracked(`src/f${String(index)}.ts`, ['x'])),
    ];
    const plan = createReviewPlan(
      planInput(components, {
        intent: `intent-start-${'i'.repeat(5_000)}-intent-end`,
        fileList: components.map((component) => component.path).join('\n'),
        priorFindings: [
          finding({
            text: `prior-start-${'p'.repeat(5_000)}-prior-end`,
            status: 'fixed',
            reason: 'addressed',
          }),
        ],
      }),
    );
    expect(plan.coverage.mode).toBe('partitioned');
    expect(plan.sessions.length).toBeGreaterThan(21);
    const textByComponent = new Map<string, string>(
      components.map((component): [string, string] => [component.component, component.text]),
    );
    for (const session of plan.sessions) {
      expect(session.prompt.length).toBeLessThanOrEqual(cap);
      expect(session.prompt).not.toContain('i'.repeat(5_000));
      expect(session.prompt).not.toContain('p'.repeat(5_000));
      expectExactPlacements(session, textByComponent);
      const placement = session.placements[0]!;
      expect(placement.offset + (placement.end - placement.start)).toBe(session.prompt.length);
    }
  });

  it('falls back over the session input budget and keeps partition offsets exact', () => {
    const text = 'x'.repeat(33_000);
    const components = [untracked('src/long.ts', text)];
    const plan = createReviewPlan(planInput(components, { session: { maxInputChars: 1_000 } }));
    expect(plan.coverage.mode).toBe('partitioned');
    expect(plan.coverage.modeReason).toBe('over session input budget');
    expect(plan.advisories[0]).toContain('over the session input budget of 1000');
    expect(plan.sessions.length).toBeGreaterThan(1);
    const session = plan.sessions[0]!;
    const placement = session.placements[0]!;
    expect(
      session.prompt.slice(placement.offset, placement.offset + (placement.end - placement.start)),
    ).toBe(text.slice(placement.start, placement.end));
    expect(session.prompt).not.toMatch(/receipt/i);
    expectExactPlacements(session, new Map<string, string>([['untracked:src/long.ts', text]]));
  });

  it('omits the receipt line only when the caller opts out', () => {
    const components = [tracked('src/a.ts')];
    const legacy = partitionReview({ head, base, scope: 'full', components });
    const toolFree = partitionReview({
      head,
      base,
      scope: 'full',
      components,
      requireReceipt: false,
    });
    expect(legacy.partitions[0]!.prompt).toContain('receipt: ');
    expect(legacy.partitions[0]!.prompt).toContain('and the exact receipt');
    expect(toolFree.partitions[0]!.prompt).not.toContain('receipt');
    expect(toolFree.partitions[0]!.prompt).toContain('evidence-based text');
    expect(toolFree.partitions[0]!.receipt).toBe(legacy.partitions[0]!.receipt);
  });
});

describe('createReviewPlan exclusions', () => {
  it('keeps one piece per original component and only sends reviewed bytes', () => {
    const components = [
      tracked('src/a.ts', ['export const a = 1;']),
      tracked('pnpm-lock.yaml', ['lockfile change']),
      tracked('docs/guide.md', ['doc change']),
    ];
    const plan = createReviewPlan(
      planInput(components, {
        fileList: '1\t0\tsrc/a.ts',
        exclude: [
          { pattern: '**/pnpm-lock.yaml', assuredBy: 'dev.check lockfile integrity' },
          { pattern: 'docs/**' },
        ],
      }),
    );
    const lock = plan.coverage.pieces.find((piece) => piece.path === 'pnpm-lock.yaml');
    const docs = plan.coverage.pieces.find((piece) => piece.path === 'docs/guide.md');
    expect(lock).toMatchObject({
      state: 'excluded',
      exclusion: { rule: '**/pnpm-lock.yaml', assuredBy: 'dev.check lockfile integrity' },
    });
    expect(docs).toMatchObject({
      state: 'excluded',
      exclusion: { rule: 'docs/**' },
    });
    expect(docs!.exclusion?.limitation).toContain('no assuredBy check');
    expect(plan.limitations).toEqual([docs!.exclusion!.limitation]);
    const prompt = plan.sessions[0]!.prompt;
    expect(prompt).not.toContain('lockfile change');
    expect(prompt).not.toContain('doc change');
    expect(prompt).toContain('export const a = 1;');
    expect(prompt).toContain('## Changed files');
    expect(prompt).toContain('pnpm-lock.yaml');
    expect(prompt).toContain('docs/guide.md');
    expect(() => ReviewCoverageV2Schema.parse(plan.coverage)).not.toThrow();
  });

  it('reports a zero-content review when every component is excluded', () => {
    const components = [tracked('docs/a.md', ['a']), tracked('docs/b.md', ['b'])];
    const plan = createReviewPlan(planInput(components, { exclude: [{ pattern: 'docs/**' }] }));
    expect(plan.sessions).toEqual([]);
    expect(plan.advisories).toEqual(['agent review covered no content: all components excluded']);
    expect(plan.coverage.pieces.map((piece) => piece.state)).toEqual(['excluded', 'excluded']);
    expect(plan.limitations).toHaveLength(2);
    expect(plan.coverage.sessions).toEqual([]);
    expect(() => ReviewCoverageV2Schema.parse(plan.coverage)).not.toThrow();
    expect(isCoverageV2Complete(plan.coverage)).toBe(true);
  });
});

describe('createReviewPlan boundary validation', () => {
  const component = tracked('src/a.ts');

  it('rejects an effective medium tier below the effective small tier', () => {
    expect(() =>
      createReviewPlan(planInput([component], { size: { medium: { maxChangedLines: 1 } } })),
    ).toThrow(/medium maxChangedLines/);
    expect(() =>
      createReviewPlan(planInput([component], { size: { medium: { maxFiles: 4 } } })),
    ).toThrow(/medium maxFiles/);
  });

  it('rejects negative, fractional or NaN thresholds', () => {
    expect(() =>
      createReviewPlan(planInput([component], { size: { small: { maxChangedLines: -1 } } })),
    ).toThrow(/size\.small\.maxChangedLines/);
    expect(() =>
      createReviewPlan(planInput([component], { size: { small: { maxFiles: 1.5 } } })),
    ).toThrow(/size\.small\.maxFiles/);
    expect(() =>
      createReviewPlan(
        planInput([component], { size: { medium: { maxChangedLines: Number.NaN } } }),
      ),
    ).toThrow(/size\.medium\.maxChangedLines/);
  });

  it('rejects invalid session bounds', () => {
    expect(() =>
      createReviewPlan(planInput([component], { session: { maxInputChars: 0 } })),
    ).toThrow(/session\.maxInputChars/);
    expect(() => createReviewPlan(planInput([component], { session: { maxSteps: 0 } }))).toThrow(
      /session\.maxSteps/,
    );
    expect(() =>
      createReviewPlan(planInput([component], { session: { concurrency: Number.NaN } })),
    ).toThrow(/session\.concurrency/);
    expect(() => createReviewPlan(planInput([component], { session: { concurrency: 0 } }))).toThrow(
      /session\.concurrency/,
    );
    expect(() =>
      createReviewPlan(planInput([component], { session: { maxInputChars: Number.NaN } })),
    ).toThrow(/session\.maxInputChars/);
  });

  it('rejects empty, duplicate or unnamable components', () => {
    expect(() => createReviewPlan(planInput([]))).toThrow(/at least one scan component/);
    expect(() =>
      createReviewPlan(planInput([{ component: '', path: 'src/a.ts', text: 'x' }])),
    ).toThrow(/identities must not be empty/);
    expect(() =>
      createReviewPlan(planInput([component, { ...component, path: 'src/b.ts' }])),
    ).toThrow(/duplicate component identity/);
  });

  it('rejects empty exclusion rules and empty assurance names', () => {
    expect(() => createReviewPlan(planInput([component], { exclude: [{ pattern: '' }] }))).toThrow(
      /patterns must not be empty/,
    );
    expect(() =>
      createReviewPlan(planInput([component], { exclude: [{ pattern: 'src/**', assuredBy: '' }] })),
    ).toThrow(/empty assuredBy/);
  });

  it('is deterministic across calls', () => {
    const input = planInput([tracked('src/a.ts', ['a']), tracked('src/b.ts', ['b'])]);
    expect(createReviewPlan(input)).toEqual(createReviewPlan(input));
  });
});
