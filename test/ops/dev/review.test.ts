// dev.review op tests over a REAL git repo (repo.ts) with a scripted
// reviewer CLI and a stub or capturing scanner. Pinned: the base pin, the
// per-path scan components (committed/staged/unstaged/untracked, binary
// bytes included), the scan BEFORE any reviewer run, honest completion
// recording, drift refusal, and the finding-id minting in the ledger.
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';
import { DevReviewInputSchema, registry } from '../../../src/ops/dev/registry.js';
import {
  makeRepoDiffScanner,
  type DiffSecretScanner,
  type ScanComponentInput,
} from '../../../src/ops/dev/denylist.js';
import type { Op } from '../../../src/kernel/types.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { runAgentReviewer } from '../../../src/ops/review/agentReviewer.js';
import {
  isCoverageV2Complete,
  ReviewCoverageV2Schema,
  type ReviewCoverageV2,
} from '../../../src/ops/review/internal/reviewCoverageV2.js';
import {
  makeDevReview,
  SCAN_COMPONENT_CAP_BYTES,
  type DevCycleInput,
  type DevReviewReport,
} from '../../../src/ops/dev/review.js';
import { sshAuthorTransport, type AuthorTransport } from '../../../src/ops/dev/review-transport.js';
import type { CommandResult } from '../../../src/ops/dev/effects.js';
import { makeFakeEffects, stubScanner } from './fakes.js';
import { makeTestRepo, repoEffects, type CommandHandler, type TestRepo } from './repo.js';

/** The cycle branch of the composed op. */
const cycleReview = (
  effects: Parameters<typeof makeDevReview>[0]['effects'],
  scanSecrets: DiffSecretScanner,
  patternsFile?: string,
) =>
  makeDevReview({
    effects,
    scanSecrets,
    ...(patternsFile === undefined ? {} : { patternsFile }),
  }) as Op<DevCycleInput, DevReviewReport>;

/** The admission branch: the composed op with the given transport (effects never touched). */
const admissionReview = (transport: AuthorTransport) =>
  makeDevReview({ transport, effects: makeFakeEffects(), scanSecrets: stubScanner() });

const NDJSON_OK = [
  JSON.stringify({ type: 'status', status: 'scanning' }),
  JSON.stringify({ type: 'finding', severity: 'major', fileName: 'src/a.ts', comment: 'fix this' }),
  JSON.stringify({ type: 'finding', severity: 'minor', comment: 'nit' }),
  JSON.stringify({ type: 'complete', status: 'review_completed' }),
  '',
].join('\n');

const ran = (
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
function wireRequest(prompt: string): {
  text: string;
  contents: { text: string }[];
} {
  return {
    text: JSON.stringify({ prompt: [{ role: 'user', content: prompt }] }),
    contents: [{ text: prompt }],
  };
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function reviewCoverage(
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
const reviewer =
  (result: CommandResult | (() => CommandResult | Promise<CommandResult>)): CommandHandler =>
  async (command) =>
    command === 'coderabbit' ? (typeof result === 'function' ? result() : result) : undefined;

/** A scanner that records the components it was handed. */
function capturingScanner(): DiffSecretScanner & { seen: ScanComponentInput[] } {
  const seen: ScanComponentInput[] = [];
  const scan = ((components: readonly ScanComponentInput[]) => {
    seen.push(...components);
    return components.map((c) => ({ component: c.component, hits: [] }));
  }) as unknown as DiffSecretScanner & { seen: ScanComponentInput[] };
  scan.seen = seen;
  return scan;
}

let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
});
afterEach(async () => {
  await repo.cleanup();
});

const reviewerCalls = (effects: { calls: { command: string; args: readonly string[] }[] }) =>
  effects.calls.filter((call) => call.command === 'coderabbit');

// The independent review's probe (PR #334 review 5562869931): the REAL
// project scanner over a real repo whose src/a.ts carries a synthetic
// sentinel. A valid rule must block it before any upload; a MALFORMED rule
// must fail CLOSED — refuse the review with zero uploads — never parse into
// a weaker regex that lets the reviewer run.
describe('dev.review pre-upload project scan fails closed', () => {
  const SENTINEL = 'review334_forbidden_probe';
  const patterns = (regex: string): string =>
    [
      'rules:',
      '  - id: class:review334-probe',
      '    description: synthetic sentinel',
      `    regex: ${regex}`,
      `    sample: '${SENTINEL}'`,
      'clean_probes:',
      "  - 'an ordinary sentence'",
      '',
    ].join('\n');

  /** The policy with one raw byte spliced in right after the sentinel inside the quoted regex. */
  const withByteAfterSentinel = (byte: number): Buffer => {
    const text = patterns(`'${SENTINEL}'`);
    const at = text.indexOf(SENTINEL) + SENTINEL.length;
    return Buffer.concat([
      Buffer.from(text.slice(0, at)),
      Buffer.from([byte]),
      Buffer.from(text.slice(at)),
    ]);
  };

  test.each([
    ['a valid rule', patterns(`'${SENTINEL}'`), 'class:review334-probe in committed:src/a.ts'],
    [
      'a malformed single-quoted rule',
      patterns(`'${SENTINEL}' # typo'`),
      'unterminated single-quoted value',
    ],
    ['invalid UTF-8 inside the rule regex', withByteAfterSentinel(0xff), 'not valid UTF-8'],
    [
      'a truncated UTF-8 sequence in the rule regex',
      withByteAfterSentinel(0xc3),
      'not valid UTF-8',
    ],
  ])('%s refuses the review with zero uploads', async (_label, policy, reason) => {
    await repo.write('policy/denylist/patterns.yml', policy);
    await repo.write('src/a.ts', `export const leak = '${SENTINEL}';\n`);
    repo.commitAll('sentinel');
    let uploads = 0;
    const effects = repoEffects(repo, (command) => {
      if (command !== 'coderabbit') return undefined;
      uploads += 1;
      return ran(0);
    });
    const result = await cycleReview(
      effects,
      makeRepoDiffScanner(repo.root),
    )({
      repoRoot: repo.root,
    });
    expect({ status: result.status, uploads }).toEqual({ status: 'needs-human', uploads: 0 });
    expect(result.status === 'needs-human' && result.reason).toContain(reason);
    expect(effects.openLedger('feature/x').load().records).toEqual([]);
  });
});

describe('dev.review cycle', () => {
  test('refuses agent cycles when a changed policy file is excluded from the upload scan', async () => {
    await repo.write('policy/denylist/patterns.yml', 'rules: []\n');
    repo.commitAll('change scanner policy');
    const effects = repoEffects(repo);
    const runAgentReviewer = vi.fn(async () => ({
      status: 'needs-human' as const,
      reason: 'fixture runner must not be called',
    }));
    const op = makeDevReview({
      effects,
      scanSecrets: stubScanner(),
      runAgentReviewer,
      patternsFile: 'policy/denylist/patterns.yml',
    }) as Op<DevCycleInput, DevReviewReport>;
    const result = await op({ repoRoot: repo.root, reviewer: 'agent:reviewer' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human')
      expect(result.reason).toContain('excluded from the pre-upload scan');
    expect(runAgentReviewer).not.toHaveBeenCalled();
    expect(effects.openLedger('feature/x').load().records).toEqual([]);
  });

  test('refuses CodeRabbit uploads when the configured corpus itself changed', async () => {
    await repo.write('custom/rules.yml', 'rules:\n');
    repo.commitAll('change configured scanner corpus');
    let uploads = 0;
    const effects = repoEffects(repo, (command) => {
      if (command === 'coderabbit') uploads += 1;
      return command === 'coderabbit' ? ran(0) : undefined;
    });
    const result = await cycleReview(
      effects,
      stubScanner(),
      'custom/rules.yml',
    )({
      repoRoot: repo.root,
    });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('custom/rules.yml');
    expect(uploads).toBe(0);
    expect(effects.openLedger('feature/x').load().records).toEqual([]);
  });

  test('agent:reviewer runs the scripted read-only reviewer and records a terminal ledger cycle', async () => {
    const effects = repoEffects(repo);
    const run = vi.fn(
      async (invocation: {
        prompt: string;
        toolPolicy: { mode?: string; allow?: string[] };
        outputSchema?: unknown;
      }) => {
        expect(invocation.toolPolicy.mode).toBe('allowlist');
        expect(invocation.toolPolicy.allow).toEqual(['read', 'grep', 'glob']);
        expect(invocation.outputSchema).toBeDefined();
        return {
          stopReason: 'complete' as const,
          structuredOutput: {
            findings: [
              {
                file: 'src/a.ts',
                line: 1,
                rule: 'fixture-rule',
                severity: 'high',
                text: 'Seeded agent finding',
              },
            ],
          },
          usage: { input: 12, output: 4, cacheRead: 0, cacheWrite: 0 },
          denials: [],
        };
      },
    );
    let wire = '';
    const drivers = {
      resolve: (request: {
        beforeRequest?: (
          text: string,
          contents?: readonly { text: string }[],
          context?: { kind: 'model-request' | 'tool-output' },
        ) => void | Promise<void>;
      }) => {
        const resolved = {
          lane: 'ai-sdk',
          modelSpec: { provider: 'scripted', model: 'reviewer' },
          driver: {
            run: async (invocation: { prompt: string }) => {
              const payload = wireRequest(invocation.prompt);
              wire = payload.text;
              await request.beforeRequest?.(payload.text, payload.contents, {
                kind: 'model-request',
              });
              return run(invocation as never);
            },
          },
        };
        return resolved;
      },
    } as unknown as DriverFactory;
    const op = makeDevReview({
      effects,
      scanSecrets: stubScanner(),
      runAgentReviewer: (input) =>
        runAgentReviewer(drivers, {
          ...input,
          scanSecrets: stubScanner(),
          role: { provider: 'scripted', model: 'reviewer' },
          maxTokens: 500,
          wallMs: 1000,
          severityMap: { high: 'major', medium: 'minor' },
        }),
    }) as Op<DevCycleInput, DevReviewReport>;
    const result = await op({ repoRoot: repo.root, reviewer: 'agent:reviewer' });
    expect(result.status, result.status === 'needs-human' ? result.reason : '').toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.reviewer).toBe('agent:reviewer');
    expect(result.value.completion).toEqual({ kind: 'terminal' });
    expect(result.value.findings).toEqual([
      expect.objectContaining({
        severity: 'major',
        fileName: 'src/a.ts',
        excerpt: 'Seeded agent finding',
      }),
    ]);
    expect(wire).toContain('"role":"user"');
    const [cycle] = effects.openLedger('feature/x').load().records;
    expect(cycle).toMatchObject({
      kind: 'cycle',
      reviewer: 'agent:reviewer',
      completion: { kind: 'terminal' },
    });
    expect(effects.logs[0]).toContain('coverage: v2 mode=session');
    expect(effects.logs[0]).toContain('advisories: none');
    expect(run).toHaveBeenCalledOnce();
  });

  test('an ok agent result with incomplete coverage is blocked, never terminal', async () => {
    const effects = repoEffects(repo);
    const op = makeDevReview({
      effects,
      scanSecrets: stubScanner(),
      runAgentReviewer: async (input) => ({
        status: 'ok',
        value: {
          findings: [],
          usage: 1,
          coverage: reviewCoverage(input.head, input.base, input.scope, 'planned'),
          advisories: [],
          limitations: [],
        },
      }),
    }) as Op<DevCycleInput, DevReviewReport>;
    const result = await op({ repoRoot: repo.root, reviewer: 'agent:reviewer' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('no verifiable coverage proof');
      expect(result.reason).toContain('coverage is incomplete');
    }
    const [cycle] = effects.openLedger('feature/x').load().records;
    expect(cycle).toMatchObject({
      kind: 'cycle',
      completion: { kind: 'blocked' },
    });
  });

  test('an ok agent result with mismatched coverage is blocked, never terminal', async () => {
    const effects = repoEffects(repo);
    const op = makeDevReview({
      effects,
      scanSecrets: stubScanner(),
      runAgentReviewer: async (input) => ({
        status: 'ok',
        value: {
          findings: [],
          usage: 1,
          coverage: reviewCoverage(input.head, 'c'.repeat(40), input.scope, 'excluded'),
          advisories: [],
          limitations: [],
        },
      }),
    }) as Op<DevCycleInput, DevReviewReport>;
    const result = await op({ repoRoot: repo.root, reviewer: 'agent:reviewer' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human')
      expect(result.reason).toContain('does not match the reviewed record');
  });

  test('an ok agent result without coverage is blocked, never terminal', async () => {
    const effects = repoEffects(repo);
    const op = makeDevReview({
      effects,
      scanSecrets: stubScanner(),
      runAgentReviewer: async () => ({
        status: 'ok',
        value: {
          findings: [],
          usage: 1,
          coverage: undefined as never,
          advisories: [],
          limitations: [],
        },
      }),
    }) as Op<DevCycleInput, DevReviewReport>;
    const result = await op({ repoRoot: repo.root, reviewer: 'agent:reviewer' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('no coverage evidence');
  });

  test('legacy v1 coverage is labelled report-only and never settles terminal', async () => {
    const effects = repoEffects(repo);
    const op = makeDevReview({
      effects,
      scanSecrets: stubScanner(),
      runAgentReviewer: async (input) => ({
        status: 'ok',
        value: {
          findings: [],
          usage: 1,
          coverage: {
            head: input.head,
            base: input.base,
            scope: input.scope,
            components: [
              {
                component: 'tracked:src/a.ts',
                path: 'src/a.ts',
                sha256: sha256(''),
                chars: 0,
                bytes: 0,
              },
            ],
            partitions: [
              {
                receipt: 'a'.repeat(64),
                ranges: [{ component: 0, start: 0, end: 0 }],
                complete: true,
                promptChars: 1,
                requests: [{ serializedChars: 1, decodedChars: 0 }],
              },
            ],
          } as never,
          advisories: [],
          limitations: [],
        },
      }),
    }) as Op<DevCycleInput, DevReviewReport>;
    const result = await op({ repoRoot: repo.root, reviewer: 'agent:reviewer' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human')
      expect(result.reason).toContain('legacy v1 agent review coverage is report only');
    const [cycle] = effects.openLedger('feature/x').load().records;
    expect(cycle).toMatchObject({ kind: 'cycle', completion: { kind: 'blocked' } });
  });

  test('complete excluded coverage settles terminal and persists advisories', async () => {
    const effects = repoEffects(repo);
    const op = makeDevReview({
      effects,
      scanSecrets: stubScanner(),
      runAgentReviewer: async (input) => {
        const coverage = reviewCoverage(input.head, input.base, input.scope, 'excluded');
        expect(isCoverageV2Complete(coverage)).toBe(true);
        return {
          status: 'ok',
          value: {
            findings: [],
            usage: 3,
            coverage,
            advisories: ['fixture advisory'],
            limitations: ['fixture exclusion limitation'],
          },
        };
      },
    }) as Op<DevCycleInput, DevReviewReport>;
    const result = await op({ repoRoot: repo.root, reviewer: 'agent:reviewer' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.advisories).toEqual(['fixture advisory']);
    const [cycle] = effects.openLedger('feature/x').load().records;
    expect(cycle).toMatchObject({
      kind: 'cycle',
      completion: { kind: 'terminal' },
      advisories: ['fixture advisory'],
    });
    expect(effects.logs[0]).toContain('coverage: v2 mode=session');
    expect(effects.logs[0]).toContain('exclusions: src/a.ts (fixture/**; limitation=');
    expect(effects.logs[0]).toContain('limitations: fixture exclusion limitation');
    expect(effects.logs[0]).toContain('advisories: fixture advisory');
  });

  test('a terminal cycle: ok report with completion, pinned base, recorded ids and log', async () => {
    const effects = repoEffects(repo, reviewer(ran(0)));
    const result = await cycleReview(effects, stubScanner())({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const base = repo.git('rev-parse', 'origin/merge-queue').trim();
    const head = repo.git('rev-parse', 'HEAD').trim();
    expect(result.value).toMatchObject({
      reviewer: 'coderabbit',
      scope: 'full',
      target: 'merge-queue',
      base,
      head,
      dirtySha256: 'clean-tree',
      completion: { kind: 'terminal' },
    });
    expect(result.value.cycleId).toBe(`c001-${head.slice(0, 8)}`);
    expect(result.value.findings.map((f) => [f.id, f.severity])).toEqual([
      [`c001-${head.slice(0, 8)}#f1`, 'major'],
      [`c001-${head.slice(0, 8)}#f2`, 'minor'],
    ]);
    expect(reviewerCalls(effects)[0]?.args).toEqual(['review', '--agent', '--base-commit', base]);
    expect(effects.logs[0]).toContain(`base: ${base}`);
    const ledger = effects.openLedger('feature/x').load();
    expect(ledger.records.map((r) => r.kind)).toEqual(['cycle']);
  });

  test('scan components: one per (leg, path) with its path; binary bytes visible; untracked read', async () => {
    await repo.write('bin/blob.dat', Buffer.from([0, 1, 2, ...Buffer.from('TOKEN-in-binary'), 0]));
    repo.commitAll('binary');
    await repo.write('src/staged.ts', 'export const s = 1;\n');
    repo.git('add', 'src/staged.ts');
    await repo.write('README.md', '# edited\n');
    await repo.write('notes/new.env', 'KEY=1\n');
    const scanner = capturingScanner();
    const result = await cycleReview(
      repoEffects(repo, reviewer(ran(0))),
      scanner,
    )({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    expect(scanner.seen.map((c) => [c.component, c.path])).toEqual([
      ['committed:bin/blob.dat', 'bin/blob.dat'],
      ['committed:src/a.ts', 'src/a.ts'],
      ['staged:src/staged.ts', 'src/staged.ts'],
      ['unstaged:README.md', 'README.md'],
      ['untracked:notes/new.env', 'notes/new.env'],
    ]);
    expect(scanner.seen[0]?.text).toContain('TOKEN-in-binary');
    expect(scanner.seen[3]?.text).toContain('-# fixture');
    expect(scanner.seen[4]?.text).toBe('KEY=1\n');
  });

  test('a legacy-named file without configured corpus remains in the scanner input', async () => {
    repo.git('reset', '-q', '--hard', 'origin/merge-queue');
    await repo.write('policy/denylist/patterns.yml', 'LEGACY_SECRET_PROBE\n');
    repo.commitAll('legacy-named secret');
    const scanner = capturingScanner();
    let uploads = 0;
    const result = await cycleReview(
      repoEffects(repo, (command) => {
        if (command === 'coderabbit') uploads += 1;
        return command === 'coderabbit' ? ran(0) : undefined;
      }),
      (components) => {
        scanner.seen.push(...components);
        const hit = components.some((component) => component.text.includes('LEGACY_SECRET_PROBE'));
        return components.map((component) => ({
          component: component.component,
          hits:
            hit && component.path === 'policy/denylist/patterns.yml'
              ? [{ ruleId: 'fixture:legacy-secret', lines: [1] }]
              : [],
        }));
      },
    )({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    expect(scanner.seen.map((component) => component.path)).toContain(
      'policy/denylist/patterns.yml',
    );
    expect(uploads).toBe(0);
  });

  test('THE SCAN GATES THE UPLOAD: a hit or a scanner fault refuses before the reviewer runs', async () => {
    const hit = repoEffects(repo, reviewer(ran(0)));
    const refused = await cycleReview(
      hit,
      stubScanner([{ component: 'committed:src/a.ts', ruleId: 'class:secret' }]),
    )({ repoRoot: repo.root });
    expect(refused.status).toBe('needs-human');
    if (refused.status === 'needs-human')
      expect(refused.reason).toContain('class:secret in committed:src/a.ts');
    expect(reviewerCalls(hit)).toEqual([]);

    const fault = repoEffects(repo, reviewer(ran(0)));
    const faulted = await cycleReview(fault, () => {
      throw new Error('gitleaks missing');
    })({ repoRoot: repo.root });
    expect(faulted.status).toBe('needs-human');
    if (faulted.status === 'needs-human') expect(faulted.reason).toContain('gitleaks missing');
    expect(reviewerCalls(fault)).toEqual([]);
    expect(fault.openLedger('feature/x').load().records).toEqual([]);
  });

  test('an unscannable untracked file (symlink, oversized) refuses — never silently skipped', async () => {
    await symlink('/etc/hostname', join(repo.root, 'link'));
    const linked = repoEffects(repo, reviewer(ran(0)));
    const result = await cycleReview(linked, stubScanner())({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain("untracked file 'link'");
    expect(reviewerCalls(linked)).toEqual([]);

    await rm(join(repo.root, 'link'));
    await repo.write('big.txt', 'x'.repeat(SCAN_COMPONENT_CAP_BYTES + 1));
    const big = await cycleReview(
      repoEffects(repo, reviewer(ran(0))),
      stubScanner(),
    )({
      repoRoot: repo.root,
    });
    expect(big.status).toBe('needs-human');
    if (big.status === 'needs-human') expect(big.reason).toContain('per-file scan cap');
  });

  test('an explicit base resolves once; an unresolvable one is needs-human with no run', async () => {
    const base = repo.git('rev-parse', 'HEAD~1').trim();
    const pinned = repoEffects(repo, reviewer(ran(0)));
    const ok = await cycleReview(
      pinned,
      stubScanner(),
    )({ repoRoot: repo.root, base: base.slice(0, 10) });
    expect(ok.status === 'ok' && ok.value.base).toBe(base);

    const missing = repoEffects(repo, reviewer(ran(0)));
    const result = await cycleReview(
      missing,
      stubScanner(),
    )({ repoRoot: repo.root, base: 'deadbeef' });
    expect(result.status).toBe('needs-human');
    expect(reviewerCalls(missing)).toEqual([]);
  });

  test.each([
    ['a non-zero exit', ran(2), 'exited 2'],
    ['a malformed stream', ran(0, 'garbage\n'), 'MALFORMED'],
    ['a timeout', ran(null, '', { timedOut: true }), 'timed out'],
  ])(
    '%s is a BLOCKED cycle: recorded with the reason, never ok',
    async (_label, outcome, reason) => {
      const effects = repoEffects(repo, reviewer(outcome));
      const result = await cycleReview(effects, stubScanner())({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human') expect(result.reason).toContain(reason);
      const [cycle] = effects.openLedger('feature/x').load().records;
      expect(cycle?.kind === 'cycle' && cycle.completion.kind).toBe('blocked');
    },
  );

  test('a TIMED-OUT run is blocked but keeps the findings it emitted before the kill', async () => {
    const partial = `${JSON.stringify({ type: 'finding', severity: 'critical', comment: 'early' })}\n`;
    const effects = repoEffects(repo, reviewer(ran(null, partial, { timedOut: true })));
    const result = await cycleReview(effects, stubScanner())({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    const [cycle] = effects.openLedger('feature/x').load().records;
    expect(cycle?.kind === 'cycle' && cycle.findings.map((f) => f.severity)).toEqual(['critical']);
  });

  test('a reviewer spawn fault is a blocked cycle naming the fault, not a crash', async () => {
    const effects = repoEffects(repo, (command) => {
      if (command === 'coderabbit') throw new Error('coderabbit could not be spawned — ENOENT');
      return undefined;
    });
    const result = await cycleReview(effects, stubScanner())({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('ENOENT');
  });

  test('drift DURING the run refuses the cycle and records nothing', async () => {
    const effects = repoEffects(
      repo,
      reviewer(async () => {
        await repo.write('src/a.ts', 'export const a = 99;\n');
        return ran(0);
      }),
    );
    const result = await cycleReview(effects, stubScanner())({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('during the review run');
    expect(effects.openLedger('feature/x').load().records).toEqual([]);
  });

  test('the uncommitted scope reads no committed leg and passes --uncommitted', async () => {
    await repo.write('README.md', '# edited\n');
    const scanner = capturingScanner();
    const effects = repoEffects(repo, reviewer(ran(0)));
    const result = await cycleReview(effects, scanner)({ repoRoot: repo.root, uncommitted: true });
    expect(result.status === 'ok' && result.value.scope).toBe('uncommitted');
    expect(scanner.seen.map((c) => c.component)).toEqual(['unstaged:README.md']);
    expect(reviewerCalls(effects)[0]?.args.at(-1)).toBe('--uncommitted');
  });

  test('an empty scope is needs-human before the scan or the run', async () => {
    const effects = repoEffects(repo, reviewer(ran(0)));
    const result = await cycleReview(
      effects,
      stubScanner(),
    )({ repoRoot: repo.root, uncommitted: true });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('no diff to review');
    expect(reviewerCalls(effects)).toEqual([]);
  });

  test('an agent reviewer is refused when the configured agent runner is unavailable', async () => {
    const effects = repoEffects(repo, reviewer(ran(0)));
    const result = await cycleReview(
      effects,
      stubScanner(),
    )({
      repoRoot: repo.root,
      reviewer: 'agent:some/model',
    });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human')
      expect(result.reason).toContain('agent reviewer is unavailable');
    expect(effects.calls).toEqual([]);
  });

  test.each([
    [{ repoRoot: '/repo', reviewer: 1 }],
    [{ repoRoot: '/repo', reviewer: 'gpt' }],
    [{ repoRoot: '' }],
    [{ repoRoot: '/repo', action: 'bogus' }],
  ])('a schema-bypassing input %j is a failed result before any effect', async (input) => {
    const effects = makeFakeEffects();
    const result = await cycleReview(effects, stubScanner())(input as unknown as DevCycleInput);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('dev.review: invalid input');
    expect(effects.commands).toEqual([]);
  });

  test('a null input is failed, never a TypeError', async () => {
    const result = await cycleReview(
      makeFakeEffects(),
      stubScanner(),
    )(null as unknown as DevCycleInput);
    expect(result.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// The author-admission branch (the merged worker-transport suite — every
// assertion carried over verbatim, routed through the composed op).
// ---------------------------------------------------------------------------

const admissionInput = {
  action: 'enroll',
  requestId: 'worker-1',
  base: 'a'.repeat(40),
  head: 'b'.repeat(40),
  target: 'origin/merge-queue',
  cycle: 1,
} as const;
const admissionBinding = {
  request_id: admissionInput.requestId,
  base: admissionInput.base,
  head: admissionInput.head,
  target: admissionInput.target,
  cycle: admissionInput.cycle,
};
const waitingDecision = {
  v: 1,
  request_id: admissionInput.requestId,
  binding: admissionBinding,
  issuer: 'waiting',
  reviewer: null,
  deadline_at: '2026-10-17T00:25:00Z',
  decided_at: null,
  dispatch: false,
};

describe('dev.review worker admission (no local issuer)', () => {
  it('exposes the operation through the lazy registry', async () => {
    const entry = registry.find((item) => item.name === 'dev.review');
    expect(entry?.name).toBe('dev.review');
    expect(await entry?.importer()).toBeTypeOf('function');
    expect(DevReviewInputSchema.safeParse({ ...admissionInput, spool: 'promotion' }).success).toBe(
      false,
    );
    expect(
      DevReviewInputSchema.safeParse({ ...admissionInput, head: admissionInput.base }).success,
    ).toBe(false);
    expect(() => sshAuthorTransport('-oProxyCommand=bad')).toThrow();
  });

  it('disables SSH sharing and unrelated agent keys for the author identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cq-author-ssh-'));
    try {
      await writeFile(
        join(root, 'ssh'),
        [
          '#!/bin/sh',
          '[ "$1" = "-T" ] || exit 20',
          '[ "$2" = "-S" ] && [ "$3" = "none" ] || exit 21',
          'identity_only=no; connect_timeout=no; attempts=no',
          'for arg do [ "$arg" != "IdentitiesOnly=yes" ] || identity_only=yes; done',
          'for arg do [ "$arg" != "ConnectTimeout=15" ] || connect_timeout=yes; done',
          'for arg do [ "$arg" != "ConnectionAttempts=1" ] || attempts=yes; done',
          '[ "$identity_only" = yes ] || exit 22',
          '[ "$connect_timeout" = yes ] && [ "$attempts" = yes ] || exit 23',
          'cat >/dev/null',
          `printf '%s\\n' '${JSON.stringify(waitingDecision)}'`,
          '',
        ].join('\n'),
        { mode: 0o700 },
      );
      vi.stubEnv('PATH', root + ':' + process.env['PATH']);
      const reply = await admissionReview(sshAuthorTransport('fixture-author'))(admissionInput);
      expect(reply).toEqual({ status: 'ok', value: waitingDecision });
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('round-trips the real Python versioned wire encoder/decoder at this SHA', async () => {
    const transport: AuthorTransport = (request) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          'python3',
          ['-B', '-c', 'from test_author_transport import fixture_main; fixture_main()'],
          {
            cwd: fileURLToPath(new URL('../../../apps/crq-python/', import.meta.url)),
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
        let output = '';
        let error = '';
        child.stdout.on('data', (s: Buffer) => {
          output += s.toString();
        });
        child.stderr.on('data', (s: Buffer) => {
          error += s.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve(output) : reject(new Error(error))));
        child.stdin.end(request);
      });
    expect(await admissionReview(transport)(admissionInput)).toEqual({
      status: 'ok',
      value: waitingDecision,
    });
  });

  it('does not retry or dispatch after uncertain delivery', async () => {
    let calls = 0;
    const op = admissionReview(async () => {
      calls++;
      throw new Error('timeout');
    });
    expect((await op(admissionInput)).status).toBe('indeterminate');
    expect(calls).toBe(1);
  });

  it.each([
    { ...waitingDecision, request_id: 'other' },
    { ...waitingDecision, binding: { ...admissionBinding, head: 'c'.repeat(40) } },
    { ...waitingDecision, v: 2 },
    { ...waitingDecision, dispatch: true },
    {
      ...waitingDecision,
      issuer: 'agent',
      reviewer: 'agent:configured',
      dispatch: true,
      decided_at: '2026-10-17T00:25:00Z',
    },
  ])('refuses mismatched, unsupported or unsolicited dispatch replies', async (reply) => {
    expect((await admissionReview(async () => JSON.stringify(reply))(admissionInput)).status).toBe(
      'indeterminate',
    );
  });

  it('returns only explicit one-shot agent permission from a fallback request', async () => {
    const reply = {
      ...waitingDecision,
      issuer: 'agent',
      reviewer: 'agent:configured',
      dispatch: true,
      decided_at: '2026-10-17T00:25:00Z',
    };
    const op = admissionReview(async () => JSON.stringify(reply));
    expect(await op({ ...admissionInput, action: 'fallback' })).toEqual({
      status: 'ok',
      value: reply,
    });
  });
});

// ---------------------------------------------------------------------------
// The ONE-op union contract: dispatch on `action`, branch strictness, and
// the byte-for-byte crq invocation.
// ---------------------------------------------------------------------------

describe('dev.review — one op discriminated on action', () => {
  it('accepts an explicit action "cycle" as the review cycle', async () => {
    const effects = repoEffects(repo, reviewer(ran(0)));
    const result = await cycleReview(
      effects,
      stubScanner(),
    )({
      repoRoot: repo.root,
      action: 'cycle',
    });
    expect(result.status).toBe('ok');
  });

  it('refuses an unknown action with the failed taxonomy (never a silent cycle)', async () => {
    const effects = repoEffects(repo, reviewer(ran(0)));
    const result = await cycleReview(
      effects,
      stubScanner(),
    )({
      repoRoot: repo.root,
      action: 'bogus',
    } as unknown as DevCycleInput);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('action');
    expect(reviewerCalls(effects)).toEqual([]);
  });

  it('the union schema refuses branch-crossing spellings', () => {
    expect(DevReviewInputSchema.safeParse({ repoRoot: '/repo', action: 'bogus' }).success).toBe(
      false,
    );
    // An admission action without the transport binding fields matches no branch.
    expect(DevReviewInputSchema.safeParse({ repoRoot: '/repo', action: 'enroll' }).success).toBe(
      false,
    );
    // A cycle-only key on the transport branch matches no branch.
    expect(DevReviewInputSchema.safeParse({ ...admissionInput, repoRoot: '/repo' }).success).toBe(
      false,
    );
  });

  it('keeps the crq worker-transport invocation working byte-for-byte (worker-transport.md:29)', () => {
    // The exact CLI spelling from apps/crq-python/ops/worker-transport.md:29;
    // the CLI JSON-parses flag values, so --cycle=1 arrives as the number 1.
    expect(
      DevReviewInputSchema.safeParse({
        action: 'enroll',
        requestId: 'branch-cycle-1',
        base: 'a'.repeat(40),
        head: 'b'.repeat(40),
        target: 'origin/merge-queue',
        cycle: 1,
      }).success,
    ).toBe(true);
  });

  it('the registry admission dispatch without the ambient alias reports the configuration gap', async () => {
    const entry = registry.find((item) => item.name === 'dev.review');
    const op = await entry?.importer();
    const previous = process.env['CQ_AUTHOR_SSH_ALIAS'];
    delete process.env['CQ_AUTHOR_SSH_ALIAS'];
    try {
      const result = await op?.(admissionInput);
      expect(result).toMatchObject({ status: 'needs-human' });
      if (result !== null && typeof result === 'object' && 'reason' in result) {
        expect(String(result.reason)).toContain('CQ_AUTHOR_SSH_ALIAS');
      }
    } finally {
      if (previous !== undefined) process.env['CQ_AUTHOR_SSH_ALIAS'] = previous;
    }
  });
});

// ---------------------------------------------------------------------------
// Late-thread hardening: exact-byte identity hashing, binary blob scanning,
// and the post-run drift refusal.
// ---------------------------------------------------------------------------

test.each(['queued', 'running', 'expired'] as const)(
  'bounded review persists blocked evidence when %s without a completed review',
  async (mode) => {
    const repo = await makeTestRepo();
    try {
      const controller = new AbortController();
      let remaining = 1000;
      const effects = repoEffects(
        repo,
        reviewer(() => {
          if (mode === 'running') controller.abort(new Error('parent cancelled running reviewer'));
          if (mode === 'expired') remaining = 0;
          return ran(0);
        }),
      );
      if (mode === 'queued')
        effects.withHostLock = async (_fn, signal) => {
          expect(signal).toBe(controller.signal);
          controller.abort(new Error('parent cancelled queued review'));
          signal!.throwIfAborted();
          throw new Error('unreachable');
        };
      const run = effects.runCommand;
      effects.runCommand = async (command, args, opts) => {
        if (command === 'coderabbit') {
          expect(opts.timeoutMs).toBe(1000);
          expect(opts.signal).toBe(controller.signal);
        }
        return run(command, args, opts);
      };
      const result = await makeDevReview({
        effects,
        scanSecrets: stubScanner(),
        signal: controller.signal,
        remainingWallMs: () => remaining,
      })({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      const cycles = effects
        .openLedger('feature/x')
        .load()
        .records.filter((entry) => entry.kind === 'cycle');
      expect(cycles).toHaveLength(1);
      expect(cycles[0]?.completion).toMatchObject({ kind: 'blocked' });
      expect(effects.logs.join(' ')).toMatch(mode === 'queued' ? /cancel/ : /stdout/);
      expect(cycles[0]?.findings).toHaveLength(mode === 'queued' ? 0 : 2);
      expect(effects.calls.filter((call) => call.command === 'coderabbit')).toHaveLength(
        mode === 'queued' ? 0 : 1,
      );
    } finally {
      await repo.cleanup();
    }
  },
);
