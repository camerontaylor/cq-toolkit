// Real git fixtures are deliberate: these tests exercise the validator/executor
// boundary, including config-driven hooks and observable outside-workspace writes.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import type { HarnessConfig } from '../../src/harness/config.js';
import { buildTools } from '../../src/harness/tools.js';
import type { ToolkitTool } from '../../src/harness/tools.js';
import { reviewFixHarness } from '../../src/ops/review/fixReviewItem.js';

const execFileAsync = promisify(execFile);
const closedDiffPrefix = 'command allowlist: git diff is closed-form — use exactly one of:';
const closedLogPrefix = 'command allowlist: git log is closed-form — use exactly one of:';
const plainPrefix = 'command not allowed by harness config allowlist:';
const braceExpands = execFileSync('/bin/sh', ['-c', "printf '%s' {a,b}"]).toString() === 'ab';

function runConfig(commandPatterns: string[]): HarnessConfig {
  return {
    ...defaultHarnessConfig,
    tools: {
      ...defaultHarnessConfig.tools,
      run: { enabled: true, commandPatterns, timeoutMs: 5_000, maxOutputChars: 20_000 },
    },
  };
}

function runTool(config: HarnessConfig, workspace: string): ToolkitTool {
  const tool = buildTools(config, workspace).find((candidate) => candidate.name === 'run');
  if (tool === undefined) throw new Error('fixture requires enabled run tool');
  return tool;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'closed-git-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  await mkdir(workspace);
  await mkdir(outside);
  const git = async (...args: string[]) => execFileAsync('git', args, { cwd: workspace });
  try {
    await git('init', '-q');
    await writeFile(join(workspace, 'f'), 'base f\n');
    await writeFile(join(workspace, 'staged'), 'base staged\n');
    await git('add', 'f', 'staged');
    await git(
      '-c',
      'user.name=Closed form fixture',
      '-c',
      'user.email=closed-form@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-qm',
      'closed form fixture',
    );
    await writeFile(join(workspace, 'staged'), 'STAGED_ONLY\n');
    await git('add', 'staged');
    await writeFile(join(workspace, 'f'), 'UNSTAGED_ONLY\n');
    return { root, workspace, outside, git };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type DenialRow = { row: string; command: (out: string) => string; prefix?: string };
const diffDenials: DenialRow[] = [
  { row: '1a no-index host read', command: () => 'git diff --no-index /etc/hosts /dev/null' },
  { row: '1b implicit no-index host read', command: () => 'git diff /etc/hosts /dev/null' },
  { row: '2a output equals', command: (out) => `git diff --output=${out}/o2a` },
  { row: '2b output argument', command: (out) => `git diff --output ${out}/o2b` },
  { row: '2c output abbreviation', command: (out) => `git diff --outpu=${out}/o2c` },
  { row: '3 brace expansion', command: (out) => `git diff {--,--}output=${out}/o3` },
  { row: '4a backslash output', command: (out) => `git diff \\--output=${out}/o4` },
  { row: '4b backslash no-index', command: () => 'git diff \\--no-index /etc/hosts /dev/null' },
  { row: '5a variable expansion', command: (out) => `git diff --out\${EMPTY}put=${out}/o5` },
  { row: '5b quoted output', command: (out) => `git diff "--output=${out}/o5"` },
  { row: '5c quoted option', command: (out) => `git diff '--output'=${out}/o5` },
  { row: '5d tilde expansion', command: () => 'git diff --output=~/o5' },
  {
    row: '5e shell command suffix',
    command: (out) => `git diff; touch ${out}/o5`,
  },
  {
    row: '7 lock precedes regex allowlist',
    command: (out) => `git diff --stat --output=${out}/o7`,
  },
  { row: 'path-scoped form removed', command: () => 'git diff -- f' },
  { row: 'cached path-scoped form removed', command: () => 'git diff --cached -- staged' },
  { row: 'separator-only synonym denied', command: () => 'git diff --' },
  { row: 'staged synonym denied', command: () => 'git diff --staged' },
  { row: 'alternative ordering denied', command: () => 'git diff --stat --cached' },
];

const diffForms = [
  'git diff',
  'git diff --stat',
  'git diff --name-only',
  'git diff --cached',
  'git diff --cached --stat',
  'git diff --cached --name-only',
];

const configs = [
  { name: 'shipped reviewFixHarness', config: reviewFixHarness },
  { name: 'anchored regex', config: runConfig(['re:^git diff.*$', 're:^git log.*$']) },
];

describe.each(configs)('closed git forms: $name', { timeout: 30_000 }, ({ config }) => {
  let repo: Fixture;
  let run: ToolkitTool;
  let hostContents: string;
  beforeAll(async () => {
    repo = await fixture();
    run = runTool(config, repo.workspace);
    hostContents = (await readFile('/etc/hosts', 'utf8')).trim();
    expect(hostContents.length).toBeGreaterThan(0);
  });
  afterAll(async () => {
    if (repo !== undefined) await rm(repo.root, { recursive: true, force: true });
  });

  test.each(diffDenials)('$row denies without escaping', async ({ command, prefix }) => {
    const result = await run.execute({ command: command(repo.outside) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.denial.reason.startsWith(prefix ?? closedDiffPrefix)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(hostContents);
    expect(await readdir(repo.outside)).toEqual([]);
  });

  test.each(diffForms)('P %s returns the selected real diff', async (command) => {
    const result = await run.execute({ command });
    expect(result).toMatchObject({ ok: true, exitCode: 0, killed: false });
    if (!result.ok) return;
    const cached = command.includes('--cached');
    const file = cached ? 'staged' : 'f';
    if (command.endsWith('--stat')) {
      expect(result.output).toMatch(new RegExp(`\\b${file} \\|`));
    } else if (command.endsWith('--name-only')) {
      expect(result.output).toBe(`exit 0\n--- stdout ---\n${file}\n`);
    } else {
      expect(result.output).toContain(cached ? '+STAGED_ONLY' : '+UNSTAGED_ONLY');
    }
    expect(result.output).not.toContain(cached ? '+UNSTAGED_ONLY' : '+STAGED_ONLY');
  });

  test('P normalizes whitespace before matching and authorizing', async () => {
    const result = await run.execute({ command: '\tgit\ndiff\t --cached  --name-only\n' });
    expect(result).toMatchObject({ ok: true, exitCode: 0 });
    if (result.ok) expect(result.output).toContain('\nstaged\n');
  });

  test.each(['git log --oneline -n 20', 'git log -n 1', 'git log -n 1 --stat'])(
    'R1 %s returns the fixture commit',
    async (command) => {
      const result = await run.execute({ command });
      expect(result).toMatchObject({ ok: true, exitCode: 0 });
      if (result.ok) expect(result.output).toContain('closed form fixture');
    },
  );

  test.each([
    'git log -1 -p --output=',
    'git log -n 1 --output=',
    'git log --oneline -n 20 --output=',
    'git log -n 1 --stat --output=',
    'git log --outpu=',
  ])('R1 denies log write escape %s', async (prefix) => {
    const result = await run.execute({ command: `${prefix}${repo.outside}/log-escape` });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.denial.reason.startsWith(closedLogPrefix)).toBe(true);
    expect(existsSync(join(repo.outside, 'log-escape'))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(hostContents);
  });

  test('denial advertises all six diff forms', async () => {
    const result = await run.execute({ command: 'git diff --staged' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      for (const form of diffForms) expect(result.denial.reason).toContain(form);
    }
  });
});

describe('git form authorization and token-pattern lint', { timeout: 30_000 }, () => {
  test.each([
    'git',
    'git -C',
    'git -c',
    'git "diff"',
    'git --git-dir=x',
    'git --work-tree=x',
    'git di\\ff',
    '"git" diff',
    'echo "$HOME"',
    'echo a;b',
    'echo *',
    'echo {a,b}',
  ])('L buildTools rejects unsafe pattern %s', (pattern) => {
    expect(() => buildTools(runConfig([pattern]), tmpdir())).toThrow(/harness:/);
  });

  test.each(['git diff', 'git log -n 1'])(
    'closed form %s still needs an allowlist grant',
    async (command) => {
      const result = await runTool(runConfig(['echo']), tmpdir()).execute({ command });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.denial.reason).toContain('is closed-form');
    },
  );

  test('whitespace normalization is also used for an exact regex grant', async () => {
    const repo = await fixture();
    try {
      const result = await runTool(
        runConfig(['re:^git diff --name-only$']),
        repo.workspace,
      ).execute({
        command: ' git\tdiff\n--name-only ',
      });
      expect(result).toMatchObject({ ok: true, exitCode: 0 });
    } finally {
      await rm(repo.root, { recursive: true, force: true });
    }
  });

  test.each(['"git" diff', 'git "diff"', 'git di\\ff', 'g\\it diff', "git d''iff"])(
    '6 disguised prefix %s denies under shipped tokens',
    async (prefix) => {
      const repo = await fixture();
      try {
        const result = await runTool(reviewFixHarness, repo.workspace).execute({
          command: `${prefix} --output=${repo.outside}/o6`,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.denial.reason.startsWith(plainPrefix)).toBe(true);
        expect(existsSync(join(repo.outside, 'o6'))).toBe(false);
        expect(JSON.stringify(result)).not.toContain((await readFile('/etc/hosts', 'utf8')).trim());
      } finally {
        await rm(repo.root, { recursive: true, force: true });
      }
    },
  );
});

describe('constant argv and anti-vacuity controls', { timeout: 30_000 }, () => {
  test.each(configs)(
    'K $name pins external diff, textconv, fsmonitor and prefixes',
    async ({ config }) => {
      const repo = await fixture();
      try {
        for (const [key, marker] of [
          ['diff.external', 'external'],
          ['diff.canary.textconv', 'textconv'],
          ['core.fsmonitor', 'fsmonitor'],
        ]) {
          const hook = join(repo.root, `${marker}.sh`);
          await writeFile(hook, `#!/bin/sh\ntouch '${repo.outside}/${marker}'\n`);
          await chmod(hook, 0o755);
          await repo.git('config', key!, hook);
        }
        await repo.git('config', 'diff.mnemonicPrefix', 'true');
        await repo.git('config', 'core.quotePath', 'false');
        await writeFile(join(repo.workspace, '.gitattributes'), 'f diff=canary\n');
        const run = runTool(config, repo.workspace);
        const result = await run.execute({ command: 'git diff' });
        expect(result).toMatchObject({ ok: true, exitCode: 0 });
        if (result.ok) {
          expect(result.output).toContain('diff --git a/f b/f');
          expect(result.output).toContain('+UNSTAGED_ONLY');
        }
        expect(await readdir(repo.outside)).toEqual([]);
        const logResult = await run.execute({ command: 'git log -n 1 --stat' });
        expect(logResult).toMatchObject({ ok: true, exitCode: 0 });
        expect(await readdir(repo.outside)).toEqual([]);
      } finally {
        await rm(repo.root, { recursive: true, force: true });
      }
    },
  );

  test.each([
    { row: '2a', shape: '--output=' },
    { row: '4a', shape: '\\--output=' },
  ])('$row direct shell control creates the outside canary', async ({ shape }) => {
    const repo = await fixture();
    try {
      const canary = join(repo.outside, 'control');
      await execFileAsync('/bin/sh', ['-c', `git diff ${shape}${canary}`], { cwd: repo.workspace });
      expect(existsSync(canary)).toBe(true);
      expect(await readFile(canary, 'utf8')).toContain('UNSTAGED_ONLY');
    } finally {
      await rm(repo.root, { recursive: true, force: true });
    }
  });

  test.skipIf(!braceExpands)(
    '3 direct shell brace-expansion control creates the outside canary',
    async () => {
      const repo = await fixture();
      try {
        const canary = join(repo.outside, 'control');
        await execFileAsync('/bin/sh', ['-c', `git diff {--,--}output=${canary}`], {
          cwd: repo.workspace,
        });
        expect(existsSync(canary)).toBe(true);
        expect(await readFile(canary, 'utf8')).toContain('UNSTAGED_ONLY');
      } finally {
        await rm(repo.root, { recursive: true, force: true });
      }
    },
  );
});
