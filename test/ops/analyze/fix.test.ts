// Lane C S4 — `analyze.fix` over a REAL git repository with a SCRIPTED
// runner (the checks and the ast-grep scan answer from the bytes on disk; no
// compiler or ast-grep binary needed) and a FAKE driver factory (no model).
// Pinned: selection, preview (no write), the attended apply + recheck on all
// three paths (cluster rule, rule over files, agent patch), and every
// refusal's taxonomy.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { DriverFactory } from '../../../src/driver/factory.js';
import type { Driver, OpInvocation, WorkerResult } from '../../../src/driver/types.js';
import type { CheckCommand, RunCheck } from '../../../src/ops/gates/checkRunner.js';
import { makeAnalyzeFix, patchTargets } from '../../../src/ops/analyze/fix.js';
import { AnalyzeFixInputSchema } from '../../../src/ops/analyze/registry.js';
import { makeAnalyzeRun } from '../../../src/ops/analyze/run.js';

const BAD = 'const n: number = "forty-two";\nexport { n };\n';
const GOOD = 'const n: number = 42;\nexport { n };\n';
const RULE = JSON.stringify({
  id: 'forty-two',
  language: 'TypeScript',
  rule: { pattern: '"forty-two"' },
  fix: '42',
});
const CHECKS = [
  { adapter: 'tsc-lines' as const, command: { command: 'tsc', args: ['--noEmit'], cwd: '.' } },
];
const CONFIG = JSON.stringify({ schemaVersion: 1, checks: CHECKS });

/** The scripted runner: tsc from the file bytes; ast-grep by literal pattern. */
function scriptedRunner(hooks: { onTsc?: () => void } = {}): RunCheck & { calls: CheckCommand[] } {
  const calls: CheckCommand[] = [];
  const run = (async (cmd: CheckCommand) => {
    calls.push(cmd);
    const cwd = cmd.cwd ?? '.';
    if (cmd.command === 'ast-grep') {
      const rule = JSON.parse(cmd.args[3] ?? '{}') as { rule?: { pattern?: string }; fix?: string };
      const pattern = Buffer.from(rule.rule?.pattern ?? '', 'utf8');
      const targets = cmd.args.slice(cmd.args.indexOf('--') + 1);
      const matches: object[] = [];
      for (const file of targets) {
        const bytes = readFileSync(join(cwd, file));
        let index = bytes.indexOf(pattern);
        while (index !== -1) {
          matches.push({
            file,
            replacement: rule.fix ?? '',
            replacementOffsets: { start: index, end: index + pattern.length },
          });
          index = bytes.indexOf(pattern, index + 1);
        }
      }
      return { stdout: JSON.stringify(matches), stderr: '', exitCode: 0 };
    }
    hooks.onTsc?.();
    const text = readFileSync(join(cwd, 'src', 'index.ts'), 'utf8');
    return text.includes('"forty-two"')
      ? {
          stdout:
            "src/index.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n",
          stderr: '',
          exitCode: 1,
        }
      : { stdout: '', stderr: '', exitCode: 0 };
  }) as RunCheck & { calls: CheckCommand[] };
  run.calls = calls;
  return run;
}

const repos: string[] = [];
async function fixture(options: { commit?: boolean; config?: boolean } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cq-fix-')));
  repos.push(dir);
  const git = (args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git(['init', '-q']);
  git(['config', 'user.email', 'fix@example.invalid']);
  git(['config', 'user.name', 'fix test']);
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'index.ts'), BAD);
  writeFileSync(join(dir, 'tsconfig.json'), '{}\n');
  if (options.config !== false) writeFileSync(join(dir, 'cq.json'), CONFIG);
  if (options.commit !== false) {
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
  }
  const analysis = await makeAnalyzeRun(scriptedRunner())({
    dir,
    checks: CHECKS,
  });
  if (analysis.status !== 'ok')
    throw new Error(`fixture analysis failed: ${JSON.stringify(analysis)}`);
  const clusterId = analysis.value.clusters[0]?.id ?? '';
  return { dir, git, clusterId, sidecarPath: analysis.value.sidecarPath };
}
afterEach(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const source = (dir: string) => readFileSync(join(dir, 'src', 'index.ts'), 'utf8');

describe('analyze.fix — selection', () => {
  test('both selections, neither, and an empty file list are failed', async () => {
    const { dir, clusterId } = await fixture();
    const fix = makeAnalyzeFix({ run: scriptedRunner() });
    const both = await fix({ dir, clusterId, rule: RULE, files: ['src/index.ts'] });
    expect(both.status).toBe('failed');
    const neither = await fix({ dir });
    expect(neither.status).toBe('failed');
    if (neither.status === 'failed') expect(neither.error).toContain('--clusterId');
    expect((await fix({ dir, rule: RULE, files: [] })).status).toBe('failed');
  });

  test('a cluster without --rule or --model → failed naming both', async () => {
    const { dir, clusterId } = await fixture();
    const result = await makeAnalyzeFix({ run: scriptedRunner() })({ dir, clusterId });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('--rule');
      expect(result.error).toContain('--model');
    }
  });

  test('an unknown cluster id → failed listing the known ids', async () => {
    const { dir, clusterId } = await fixture();
    const result = await makeAnalyzeFix({ run: scriptedRunner() })({
      dir,
      clusterId: '00000000',
      rule: RULE,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain(clusterId);
  });

  test('no sidecar yet → failed naming analyze.run', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cq-fix-nosidecar-')));
    repos.push(dir);
    const result = await makeAnalyzeFix({ run: scriptedRunner() })({
      dir,
      clusterId: 'deadbeef',
      rule: RULE,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('analyze.run');
  });
});

describe('analyze.fix — cluster + rule', () => {
  test('preview: one planned edit, a digest, the --apply hint, nothing written', async () => {
    const { dir, clusterId, sidecarPath } = await fixture();
    const result = await makeAnalyzeFix({ run: scriptedRunner() })({ dir, clusterId, rule: RULE });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.mode).toBe('preview');
    const preview = result.value.preview;
    expect(preview.kind).toBe('cluster-codemod');
    if (preview.kind !== 'cluster-codemod') return;
    expect(preview.plannedEdits).toBe(1);
    expect(preview.sidecarPath).toBe(sidecarPath);
    expect(preview.files[0]?.diff).toContain('+const n: number = 42;');
    expect(preview.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.value.next).toContain('--apply');
    expect(source(dir)).toBe(BAD);
  });

  test('apply: the file changes and the recheck reports 1 → 0, resolved', async () => {
    const { dir, clusterId, git } = await fixture();
    const fix = makeAnalyzeFix({ run: scriptedRunner() });
    const preview = await fix({ dir, clusterId, rule: RULE });
    if (preview.status !== 'ok') throw new Error('preview failed');
    const result = await fix({
      dir,
      clusterId,
      rule: RULE,
      apply: true,
      previewDigest: preview.value.preview.digest,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.mode).toBe('applied');
    expect(result.value.applied?.files).toEqual(['src/index.ts']);
    expect(result.value.recheck).toMatchObject({ before: 1, after: 0, resolved: true });
    expect(source(dir)).toBe(GOOD);
    // Only the target changed in the tracked tree.
    expect(git(['status', '--porcelain', '--untracked-files=no'])).toBe('M src/index.ts');
  });

  test('a reviewed digest that no longer matches → needs-human, nothing written', async () => {
    const { dir, clusterId } = await fixture();
    const result = await makeAnalyzeFix({ run: scriptedRunner() })({
      dir,
      clusterId,
      rule: RULE,
      apply: true,
      previewDigest: `sha256:${'0'.repeat(64)}`,
    });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('preview changed');
    expect(source(dir)).toBe(BAD);
  });

  test('a dirty tree → needs-human naming the dirty path; nothing written', async () => {
    const { dir, clusterId } = await fixture();
    writeFileSync(join(dir, 'scratch.txt'), 'uncommitted');
    const result = await makeAnalyzeFix({ run: scriptedRunner() })({
      dir,
      clusterId,
      rule: RULE,
      apply: true,
    });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('workspace dirty');
      expect(result.reason).toContain("'scratch.txt'");
    }
    expect(source(dir)).toBe(BAD);
  });

  test('a repository without a commit → needs-human asking for a commit', async () => {
    const { dir, clusterId } = await fixture({ commit: false });
    const result = await makeAnalyzeFix({ run: scriptedRunner() })({
      dir,
      clusterId,
      rule: RULE,
      apply: true,
    });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('at least one commit');
    expect(source(dir)).toBe(BAD);
  });

  test('--apply without configured checks → failed before writing', async () => {
    const { dir, clusterId } = await fixture({ config: false });
    const result = await makeAnalyzeFix({ run: scriptedRunner() })({
      dir,
      clusterId,
      rule: RULE,
      apply: true,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('analyze.init');
    expect(source(dir)).toBe(BAD);
  });

  test('a sidecar that changes between preview and write is not confirmed → needs-human', async () => {
    const { dir, clusterId, sidecarPath } = await fixture();
    // The before-check runs between the preview and the apply: append a
    // byte to the sidecar there (still valid JSON — only its digest moves).
    const run = scriptedRunner({
      onTsc: () => writeFileSync(sidecarPath, `${readFileSync(sidecarPath, 'utf8')}\n`),
    });
    const result = await makeAnalyzeFix({ run })({ dir, clusterId, rule: RULE, apply: true });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('not the one previewed');
    expect(source(dir)).toBe(BAD);
  });

  test('a target edited after analysis → failed stale sidecar with the analyze.run hint', async () => {
    const { dir, clusterId } = await fixture();
    writeFileSync(join(dir, 'src', 'index.ts'), `${BAD}// edited\n`);
    const result = await makeAnalyzeFix({ run: scriptedRunner() })({ dir, clusterId, rule: RULE });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('cq analyze.run');
  });
});

describe('analyze.fix — a custom report directory', () => {
  test('the custom out is exempt like .cq/: the apply proceeds over its untracked reports', async () => {
    const { dir } = await fixture();
    const run = scriptedRunner();
    const analysis = await makeAnalyzeRun(run)({ dir, checks: CHECKS, out: 'reports/cq' });
    if (analysis.status !== 'ok') throw new Error('analysis failed');
    const result = await makeAnalyzeFix({ run })({
      dir,
      out: 'reports/cq',
      clusterId: analysis.value.clusters[0]?.id ?? '',
      rule: RULE,
      apply: true,
    });
    expect(result.status, JSON.stringify(result)).toBe('ok');
    expect(source(dir)).toBe(GOOD);
  });
});

describe('analyze.fix — rule over files', () => {
  test('preview then apply; recheck counts go down', async () => {
    const { dir } = await fixture();
    const fix = makeAnalyzeFix({ run: scriptedRunner() });
    const preview = await fix({ dir, rule: RULE, files: ['src/index.ts'] });
    expect(preview.status === 'ok' && preview.value.preview.kind).toBe('rule-codemod');
    expect(source(dir)).toBe(BAD);
    const applied = await fix({ dir, rule: RULE, files: ['src/index.ts'], apply: true });
    expect(applied.status).toBe('ok');
    if (applied.status !== 'ok') return;
    expect(applied.value.recheck).toMatchObject({ before: 1, after: 0, resolved: true });
    expect(source(dir)).toBe(GOOD);
  });

  test('nothing matched → preview mode with "nothing to apply", even with --apply', async () => {
    const { dir } = await fixture();
    const rule = JSON.stringify({
      id: 'x',
      language: 'TypeScript',
      rule: { pattern: 'zzz' },
      fix: 'y',
    });
    const result = await makeAnalyzeFix({ run: scriptedRunner() })({
      dir,
      rule,
      files: ['src/index.ts'],
      apply: true,
    });
    expect(result.status === 'ok' && result.value.mode).toBe('preview');
    expect(result.status === 'ok' && result.value.next).toContain('nothing to apply');
  });
});

/** A fake driver factory returning a canned proposal. */
function fakeFactory(output: unknown, stopReason: WorkerResult['stopReason'] = 'complete') {
  const invocations: OpInvocation[] = [];
  const driver = {
    run: async (invocation: OpInvocation): Promise<WorkerResult> => {
      invocations.push(invocation);
      return {
        stopReason,
        structuredOutput: output,
        usage: { inputTokens: 1, outputTokens: 1 },
        denials: [],
      } as unknown as WorkerResult;
    },
  } as unknown as Driver;
  const factory: DriverFactory = {
    resolve: (request) => ({ driver, lane: 'ai-sdk' as const, modelSpec: request.modelSpec }),
  };
  return { factory, invocations };
}

const PATCH = [
  'diff --git a/src/index.ts b/src/index.ts',
  '--- a/src/index.ts',
  '+++ b/src/index.ts',
  '@@ -1,2 +1,2 @@',
  '-const n: number = "forty-two";',
  '+const n: number = 42;',
  ' export { n };',
  '',
].join('\n');
const MODEL = { provider: 'zai', model: 'glm-test' };

describe('analyze.fix — agent proposal', () => {
  test('two steps: preview stores the patch; a one-step apply is refused; apply with the digest writes it', async () => {
    const { dir, clusterId } = await fixture();
    const { factory, invocations } = fakeFactory({ summary: 'use a number', patch: PATCH });
    const fix = makeAnalyzeFix({ run: scriptedRunner(), drivers: factory });
    const budget = { maxTokens: 1000 };
    const preview = await fix({ dir, clusterId, model: MODEL, budget });
    expect(preview.status).toBe('ok');
    if (preview.status !== 'ok' || preview.value.preview.kind !== 'agent-patch') {
      throw new Error(`expected an agent-patch preview: ${JSON.stringify(preview)}`);
    }
    expect(invocations[0]?.toolPolicy.mode).toBe('none');
    expect(invocations[0]?.sandboxPolicy.level).toBe('read-only');
    expect(invocations[0]?.budget).toEqual(budget);
    expect(preview.value.preview.targets).toEqual(['src/index.ts']);
    expect(readFileSync(preview.value.preview.proposalPath, 'utf8')).toBe(PATCH);
    expect(source(dir)).toBe(BAD);
    // ONE step (model + apply, no digest): a fresh, unseen proposal — refused.
    const oneStep = await fix({ dir, clusterId, model: MODEL, apply: true });
    expect(oneStep.status).toBe('needs-human');
    if (oneStep.status === 'needs-human')
      expect(oneStep.reason).toContain('--previewDigest=sha256:');
    expect(source(dir)).toBe(BAD);
    // TWO steps: the reviewed digest applies exactly the stored proposal.
    const calls = invocations.length;
    const applied = await fix({
      dir,
      clusterId,
      model: MODEL,
      apply: true,
      previewDigest: preview.value.preview.digest,
    });
    expect(invocations.length).toBe(calls);
    expect(applied.status).toBe('ok');
    if (applied.status !== 'ok') return;
    expect(applied.value.applied?.patch).toBe(PATCH);
    expect(applied.value.recheck).toMatchObject({ before: 1, after: 0, resolved: true });
    expect(source(dir)).toBe(GOOD);
  });

  test('--previewDigest applies the STORED proposal without asking the model again', async () => {
    const { dir, clusterId } = await fixture();
    const first = fakeFactory({ summary: 'use a number', patch: PATCH });
    const preview = await makeAnalyzeFix({ run: scriptedRunner(), drivers: first.factory })({
      dir,
      clusterId,
      model: MODEL,
    });
    if (preview.status !== 'ok') throw new Error('preview failed');
    const second = fakeFactory({ summary: 'different', patch: 'garbage' });
    const applied = await makeAnalyzeFix({ run: scriptedRunner(), drivers: second.factory })({
      dir,
      clusterId,
      previewDigest: preview.value.preview.digest,
      apply: true,
    });
    expect(applied.status).toBe('ok');
    expect(
      applied.status === 'ok' &&
        applied.value.preview.kind === 'agent-patch' &&
        applied.value.preview.source,
    ).toBe('stored-proposal');
    expect(second.invocations).toEqual([]);
    expect(source(dir)).toBe(GOOD);
  });

  test('a stored proposal is bound to its analysis: a changed sidecar refuses the digest', async () => {
    const { dir, clusterId, sidecarPath } = await fixture();
    const { factory } = fakeFactory({ summary: 'use a number', patch: PATCH });
    const fix = makeAnalyzeFix({ run: scriptedRunner(), drivers: factory });
    const preview = await fix({ dir, clusterId, model: MODEL });
    if (preview.status !== 'ok') throw new Error('preview failed');
    writeFileSync(sidecarPath, `${readFileSync(sidecarPath, 'utf8')}\n`);
    const result = await fix({
      dir,
      clusterId,
      apply: true,
      previewDigest: preview.value.preview.digest,
    });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('preview changed');
    expect(source(dir)).toBe(BAD);
  });

  test('a stale sidecar is refused before the model is asked', async () => {
    const { dir, clusterId } = await fixture();
    writeFileSync(join(dir, 'src', 'index.ts'), `${BAD}// moved on\n`);
    const { factory, invocations } = fakeFactory({ summary: 'x', patch: PATCH });
    const result = await makeAnalyzeFix({ run: scriptedRunner(), drivers: factory })({
      dir,
      clusterId,
      model: MODEL,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('stale sidecar');
    expect(invocations).toEqual([]);
  });

  test('a summary-only proposal is a preview with nothing to apply', async () => {
    const { dir, clusterId } = await fixture();
    const { factory } = fakeFactory({ summary: 'needs a human look' });
    const result = await makeAnalyzeFix({ run: scriptedRunner(), drivers: factory })({
      dir,
      clusterId,
      model: MODEL,
      apply: true,
    });
    expect(result.status === 'ok' && result.value.preview.kind).toBe('agent-summary');
    expect(result.status === 'ok' && result.value.mode).toBe('preview');
    expect(source(dir)).toBe(BAD);
  });

  test('an agent error → failed; a patch escaping the project → failed; nothing written', async () => {
    const { dir, clusterId } = await fixture();
    const broken = fakeFactory(undefined, 'error');
    const failed = await makeAnalyzeFix({ run: scriptedRunner(), drivers: broken.factory })({
      dir,
      clusterId,
      model: MODEL,
    });
    expect(failed.status).toBe('failed');
    const escaping = fakeFactory({
      summary: 'escape',
      patch: PATCH.replaceAll('src/index.ts', '../outside.ts'),
    });
    const refused = await makeAnalyzeFix({ run: scriptedRunner(), drivers: escaping.factory })({
      dir,
      clusterId,
      model: MODEL,
      apply: true,
    });
    expect(refused.status).toBe('failed');
    if (refused.status === 'failed') expect(refused.error).toContain('escapes');
    expect(source(dir)).toBe(BAD);
  });

  test('a patch that does not apply cleanly → failed, kept for inspection', async () => {
    const { dir, clusterId } = await fixture();
    const { factory } = fakeFactory({
      summary: 'stale',
      patch: PATCH.replace('forty-two', 'forty-three'),
    });
    const result = await makeAnalyzeFix({ run: scriptedRunner(), drivers: factory })({
      dir,
      clusterId,
      model: MODEL,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('does not apply cleanly');
  });
});

describe('patchTargets', () => {
  test('parses git and plain unified headers', () => {
    expect(patchTargets(PATCH)).toEqual({ ok: true, targets: ['src/index.ts'] });
    expect(patchTargets('--- a/x.ts\t2020\n+++ b/x.ts\t2020\n@@ -1 +1 @@\n-a\n+b\n')).toEqual({
      ok: true,
      targets: ['x.ts'],
    });
    expect(patchTargets('--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+a\n')).toEqual({
      ok: true,
      targets: ['new.ts'],
    });
  });

  test('hunk body lines that look like headers are content, not paths', () => {
    const patch = [
      '--- a/q.sql',
      '+++ b/q.sql',
      '@@ -1,2 +1,2 @@',
      '-- comment',
      '+++ x',
      ' select 1;',
      '',
    ]
      .join('\n')
      .replace('-- comment', '--- comment');
    expect(patchTargets(patch)).toEqual({ ok: true, targets: ['q.sql'] });
    const escaping = patch.replace('--- comment', '--- ../notes');
    expect(patchTargets(escaping)).toEqual({ ok: true, targets: ['q.sql'] });
  });

  test.each([
    ['--- a/../x\n+++ b/../x\n', 'escapes'],
    ['--- a/.git/config\n+++ b/.git/config\n', 'escapes'],
    ['--- a/.cq/analysis/r.json\n+++ b/.cq/analysis/r.json\n', 'report area'],
    ['diff --git a/x b/x\nGIT binary patch\n', 'binary'],
    ['diff --git a/l b/l\nnew file mode 120000\n', 'symlink'],
    ['--- "a/sp ace"\n+++ "b/sp ace"\n', 'quoted'],
    ['hello\n', 'names no files'],
  ])('refuses %j', (patch, reason) => {
    const result = patchTargets(patch);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });
});

describe('AnalyzeFixInputSchema', () => {
  test('an all-digit cluster id the CLI parsed as a number is recovered exactly', () => {
    expect(AnalyzeFixInputSchema.parse({ dir: '.', clusterId: 12345678 }).clusterId).toBe(
      '12345678',
    );
    expect(AnalyzeFixInputSchema.safeParse({ dir: '.', clusterId: 'xyz' }).success).toBe(false);
  });

  test('a JSON-object rule (what the CLI parses) becomes rule text', () => {
    const parsed = AnalyzeFixInputSchema.parse({ dir: '.', rule: { id: 'r' }, files: ['a.ts'] });
    expect(parsed.rule).toBe('{"id":"r"}');
  });

  test('strict, with the previewDigest shape enforced', () => {
    expect(AnalyzeFixInputSchema.safeParse({ dir: '.', bogus: 1 }).success).toBe(false);
    expect(AnalyzeFixInputSchema.safeParse({ dir: '.', previewDigest: 'abc' }).success).toBe(false);
    expect(
      AnalyzeFixInputSchema.safeParse({
        dir: '.',
        apply: true,
        model: { provider: 'p', model: 'm' },
      }).success,
    ).toBe(true);
  });
});
