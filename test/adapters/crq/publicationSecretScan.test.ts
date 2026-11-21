// Differential run: the same throwaway local repositories through Python's real
// `crq.secret_scan` (the secret scan `repair_tick.publish` runs over the final
// rebased publication; the oracle is test/helpers/publicationSecretScanOracle.py)
// and the TS publication secret-scan binding. The verdict, the exception class and
// text, and the report bytes must be equal. Scripted-process cases pin what a
// repository cannot produce on demand (spawn failure, invalid UTF-8, the call order,
// argument narrowings, an unavailable scanner). A fake scanner and synthetic
// patterns stand in for the real ones: no real secret, no network, no forge, no
// provider and no worktree mutation by the adapter; fixtures are made with plain `git`.
import { execFileSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GitCall, RunGit } from '../../../src/adapters/crq/ledgerGit.js';
import { gitPublicationReads } from '../../../src/adapters/crq/publicationGitReads.js';
import {
  gitPublicationSecretScan,
  SECRET_SCAN_REPORT,
  type PublicationSecretScan,
} from '../../../src/adapters/crq/publicationSecretScan.js';
import { gitPublicationVerify } from '../../../src/adapters/crq/publicationVerify.js';
import { gitPublicationWorktrees } from '../../../src/adapters/crq/publicationWorktrees.js';
import { runGitIn } from '../../../src/adapters/crq/publishSource.js';
import { fileReviewGitleaks } from '../../../src/adapters/crq/reviewGitleaks.js';
import { isPyError, PyError } from '../../../src/queue-runner/pyErrors.js';
import {
  publishRepair,
  REFUSE_SECRET_SCAN,
  type PublicationPublishEffects,
} from '../../../src/queue-runner/publicationPublish.js';
import type { ReviewScannerEffects } from '../../../src/queue-runner/reviewScan.js';
import { HARDENED_DIFF_FLAGS } from '../../../src/shared/gitHarden.js';
import { scrubbedGitEnv } from '../../helpers/git-env.js';

const ORACLE = fileURLToPath(
  new URL('../../helpers/publicationSecretScanOracle.py', import.meta.url),
);
const APPS = fileURLToPath(new URL('../../../apps/crq-python', import.meta.url));

// The structural subset the publish orchestration declares.
type Pinned = Pick<PublicationPublishEffects, keyof PublicationSecretScan>;
const pinned = (scan: PublicationSecretScan): Pinned => scan;

const JOB = 'crq-job-1';
const cleanups: string[] = [];

/**
 * One synthetic Git environment for the fixtures, the Python oracle and the TS runner:
 * no global or system config, a fixed identity and one locale, so no result depends on
 * the host's Git setup.
 */
const GIT_ENV: Record<string, string> = {
  LC_ALL: 'C.UTF-8',
  LANGUAGE: '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

/** The hardened production runner with {@link GIT_ENV} added; the adapters under test use it. */
const runGitFor =
  (repo: string): RunGit =>
  (args, options) =>
    runGitIn(repo)(args, { ...options, env: { ...GIT_ENV, ...options?.env } });

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-C',
      cwd,
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.autocrlf=false',
      ...args,
    ],
    {
      encoding: 'utf8',
      env: { ...scrubbedGitEnv(), ...GIT_ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
}

/** Synthetic denylist in the constrained format: nothing here is a real secret shape. */
const PATTERNS = `rules:
  - id: class:inline-secret-assignments
    description: synthetic inline assignment shape
    regex: 'FAKE_SECRET_[A-Z]+=\\S+'
    sample: 'FAKE_SECRET_ONE=value'
  - id: class:deny-word
    description: synthetic deny word
    regex: '\\bdenyword\\b'
    sample: 'a denyword here'
  - id: class:env-files
    description: synthetic path-scoped rule
    regex: '.+'
    path: '\\.env$'
    sample: 'anything'
    probe_path: 'x/.env'
clean_probes:
  - 'plain text that matches nothing'
`;

const EXEMPTIONS = `[[exempt]]
path = "fixtures/**"
rule = "class:inline-secret-assignments"
reason = "synthetic fixture"

[[exempt]]
path = "fixtures/**"
rule = "generic-api-key"
reason = "synthetic fixture"
`;

/** An in-process matcher with the worker's contract: line-major, strictly ordered pairs. */
const match: ReviewScannerEffects['match'] = async ({ rules, lines }) => {
  const compiled = rules.map((rule) => ({
    regex: new RegExp(rule.regex),
    path: rule.path === null ? null : new RegExp(rule.path),
  }));
  const out: (readonly [number, number])[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    for (const [ruleIndex, rule] of compiled.entries()) {
      if (rule.path !== null && !rule.path.test(line.path)) continue;
      if (rule.regex.test(line.text)) out.push([lineIndex, ruleIndex]);
    }
  }
  return out;
};

type Files = Record<string, string>;

function writeFiles(dir: string, files: Files): Promise<void[]> {
  return Promise.all(
    Object.entries(files).map(async ([name, text]) => {
      await mkdir(dirname(join(dir, name)), { recursive: true });
      await writeFile(join(dir, name), text);
    }),
  );
}

async function commitOver(clone: string, base: string, files: Files, message: string) {
  git(clone, 'checkout', '-q', '--detach', base);
  await writeFiles(clone, files);
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', message);
  return git(clone, 'rev-parse', 'HEAD');
}

/** A primary clone whose `origin/main` is the base commit, carrying `patterns` when given. */
async function makeRepo(root: string, name: string, patterns: string | null) {
  const clone = join(root, name);
  await mkdir(clone);
  git(clone, 'init', '-q', '--object-format=sha1');
  await writeFiles(clone, {
    'a.txt': 'l1\nl2\nl3\n',
    'old.txt': 'keep\ndenyword legacy\nkeep\n',
    'src/x.txt': 'x\n',
    ...(patterns === null ? {} : { 'policy/denylist/patterns.yml': patterns }),
  });
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'base');
  const b0 = git(clone, 'rev-parse', 'HEAD');
  git(clone, 'update-ref', 'refs/remotes/origin/main', b0);
  return { clone, b0 };
}

/** Writes a fake `gitleaks` into `dir` that answers per `spec` and ignores everything else. */
async function installGitleaks(
  dir: string,
  spec: { exit: number; findings: { rule: string; needle: string }[] },
) {
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'gitleaks');
  await writeFile(
    path,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const report = args[args.indexOf('--report-path') + 1];
const spec = ${JSON.stringify(spec)};
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const lines = Buffer.concat(chunks).toString('utf8').split('\\n');
  const findings = spec.findings.map((f) => ({
    RuleID: f.rule,
    StartLine: lines.findIndex((line) => line.includes(f.needle)) + 1,
  }));
  if (spec.exit === 0) fs.writeFileSync(report, JSON.stringify(findings));
  process.exit(spec.exit);
});
`,
  );
  await chmod(path, 0o755);
}

interface Fixture {
  root: string;
  /** The primary clone; `origin/main` is `b0`. */
  clone: string;
  /** Base commits: none, a valid exemption file, and three kinds of broken one. */
  bases: { b0: string; valid: string; syntax: string; notExemptible: string; incomplete: string };
  /** Directories whose `gitleaks` answers per scenario, and a PATH with no `gitleaks` at all. */
  paths: Record<'none' | 'clean' | 'generic' | 'provider' | 'error', string>;
  heads: Map<string, Map<string, string>>;
  /** A clone whose `origin/main` has no patterns file, and one whose file is garbage. */
  noPatterns: { clone: string; base: string; head: string };
  garbagePatterns: { clone: string; base: string; head: string };
  scratch: string;
}

/** Content a head adds over a base, by name. */
const HEADS: Record<string, Files> = {
  clean: { 'a.txt': 'l1 changed\nl2\nl3\n' },
  deny: { 'src/y.txt': 'one\nuse denyword here\nthree\n' },
  removed: { 'old.txt': 'keep\nkeep\n' },
  allow: {
    'node_modules/p/x.txt': 'denyword\n',
    'dist/a.js': 'denyword\n',
    'policy/denylist/patterns.yml': `${PATTERNS}# denyword note\n`,
  },
  envScoped: { 'cfg/.env': 'anything\n', 'cfg/notenv.txt': 'anything\n' },
  secret: {
    'fixtures/s.txt': 'FAKE_SECRET_ONE=value1\n',
    'src/s.txt': 'FAKE_SECRET_TWO=value2\n',
  },
  secretFixtureOnly: { 'fixtures/s.txt': 'FAKE_SECRET_ONE=value1\n' },
  secretAndDeny: { 'fixtures/s.txt': 'FAKE_SECRET_ONE=value1\ndenyword\n' },
  // The finding sits where the head's own exemption would cover it (`fixtures/**`), so a
  // lookup in the head instead of the base would answer clean and fail the differential.
  selfExempt: {
    '.crq/scan-exemptions.toml': EXEMPTIONS,
    'fixtures/s.txt': 'FAKE_SECRET_ONE=value1\n',
  },
  multi: {
    'a.txt': 'l1\ndenyword two\nl3\nl4 denyword\n',
    'old.txt': 'keep\nkeep\n',
    'src/z.txt': 'z1\nz2 denyword\nz3\nFAKE_SECRET_ZZ=zed\n',
    'cfg/.env': 'x\n',
  },
  noNewline: { 'nonl.txt': 'denyword at eof' },
  glPlain: { 'src/g.txt': 'GLTOKEN_ONE\n' },
  glFixture: { 'fixtures/g.txt': 'GLTOKEN_ONE\n' },
};

let fx: Fixture;

beforeAll(async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'crq-pub-scan-')));
  cleanups.push(root);
  const { clone, b0 } = await makeRepo(root, 'clone', PATTERNS);
  const base = (toml: string, name: string) =>
    commitOver(clone, b0, { '.crq/scan-exemptions.toml': toml }, name);
  const bases = {
    b0,
    valid: await base(EXEMPTIONS, 'valid exemptions'),
    syntax: await base('[[exempt]\npath =\n', 'syntax error'),
    notExemptible: await base(
      '[[exempt]]\npath = "**"\nrule = "class:deny-word"\nreason = "no"\n',
      'non-exemptible rule',
    ),
    incomplete: await base('[[exempt]]\npath = "x"\nrule = "generic-api-key"\n', 'no reason'),
  };
  const heads = new Map<string, Map<string, string>>();
  for (const [baseName, baseCommit] of Object.entries(bases)) {
    const byName = new Map<string, string>();
    for (const [name, files] of Object.entries(HEADS))
      byName.set(name, await commitOver(clone, baseCommit, files, `${baseName}: ${name}`));
    heads.set(baseName, byName);
  }
  git(clone, 'checkout', '-q', '--detach', b0);

  const bin = join(root, 'bin');
  const gitBinary = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const withGit = join(bin, 'git-only');
  await mkdir(withGit, { recursive: true });
  await symlink(gitBinary, join(withGit, 'git'));
  const scenario = async (
    name: string,
    spec: { exit: number; findings: { rule: string; needle: string }[] },
  ) => {
    await installGitleaks(join(bin, name), spec);
    return `${join(bin, name)}:${withGit}`;
  };
  const paths = {
    none: withGit,
    clean: await scenario('clean', { exit: 0, findings: [] }),
    generic: await scenario('generic', {
      exit: 0,
      findings: [{ rule: 'generic-api-key', needle: 'GLTOKEN_ONE' }],
    }),
    provider: await scenario('provider', {
      exit: 0,
      findings: [
        { rule: 'generic-api-key', needle: 'GLTOKEN_ONE' },
        { rule: 'fake-provider-token', needle: 'GLTOKEN_ONE' },
      ],
    }),
    error: await scenario('error', { exit: 2, findings: [] }),
  };

  const bare = async (name: string, patterns: string | null) => {
    const repo = await makeRepo(root, name, patterns);
    const head = await commitOver(repo.clone, repo.b0, HEADS['clean'] as Files, 'head');
    git(repo.clone, 'checkout', '-q', '--detach', repo.b0);
    return { clone: repo.clone, base: repo.b0, head };
  };
  const scratch = join(root, 'scratch');
  await mkdir(scratch);
  fx = {
    root,
    clone,
    bases,
    paths,
    heads,
    noPatterns: await bare('no-patterns', null),
    garbagePatterns: await bare('garbage-patterns', 'this is not a patterns file\n'),
    scratch,
  };
});

afterAll(async () => {
  await Promise.all(cleanups.map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Outcome {
  ok?: boolean;
  error?: string;
  message?: string;
  report: string | null;
}

interface Case {
  name: string;
  clone: string;
  base: string;
  head: string;
  path: string;
  /** The job directory exists in both state roots unless false. */
  jobDir?: boolean;
  /** Python's `tomllib` words a TOML syntax error its own way: compare the prefix only. */
  looseExemptionError?: boolean;
}

interface Placed extends Case {
  job: string;
  pyOut: string;
  tsState: string;
  pyState: string;
}

async function place(cases: Case[]): Promise<Placed[]> {
  const pyState = join(fx.root, `py-${String(cleanups.length)}`);
  const tsState = join(fx.root, `ts-${String(cleanups.length)}`);
  const placed: Placed[] = [];
  for (const [index, item] of cases.entries()) {
    const job = `crq-job-${String(index)}`;
    if (item.jobDir !== false) {
      await mkdir(join(pyState, 'repair', job), { recursive: true });
      await mkdir(join(tsState, 'repair', job), { recursive: true });
    }
    placed.push({
      ...item,
      job,
      pyState,
      tsState,
      pyOut: join(pyState, 'repair', job, SECRET_SCAN_REPORT),
    });
  }
  return placed;
}

function runOracle(cases: Placed[]): Outcome[] {
  const stdout = execFileSync('python3', ['-I', ORACLE, APPS], {
    input: JSON.stringify({
      cases: cases.map((item) => ({
        clone: item.clone,
        base: item.base,
        head: item.head,
        out: item.pyOut,
        path: item.path,
      })),
    }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: process.env['PATH'] ?? '', ...GIT_ENV },
  });
  return (JSON.parse(stdout) as { results: Outcome[] }).results;
}

/** The exception names Python raises where the TS seam raises its `OSError`. */
const PY_CLASS: Record<string, string> = { FileNotFoundError: 'OSError' };

async function readReport(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function runTs(item: Placed): Promise<Outcome> {
  const scan = gitPublicationSecretScan({
    stateRoot: item.tsState,
    clone: item.clone,
    runGitFor,
    match,
    gitleaks: fileReviewGitleaks({ path: item.path, scratchRoot: fx.scratch }),
  });
  const report = join(item.tsState, 'repair', item.job, SECRET_SCAN_REPORT);
  try {
    const ok = await scan.secretScan(item.job, item.base, item.head);
    return { ok, report: await readReport(report) };
  } catch (error) {
    return {
      error:
        error instanceof PyError ? error.kind : error instanceof Error ? error.name : 'unknown',
      message: error instanceof Error ? error.message : String(error),
      report: await readReport(report),
    };
  }
}

function normalise(report: string | null, loose: boolean | undefined): unknown {
  if (report === null || loose !== true) return report;
  const parsed = JSON.parse(report) as { exemption_error?: string };
  const prefix = '.crq/scan-exemptions.toml: ';
  if (parsed.exemption_error?.startsWith(prefix) === true) parsed.exemption_error = prefix;
  return parsed;
}

describe('publication secret scan: Python differential', () => {
  const head = (base: keyof Fixture['bases'], name: string): string => {
    const found = fx.heads.get(base)?.get(name);
    if (found === undefined) throw new Error(`no fixture head ${base}/${name}`);
    return found;
  };
  const on = (
    base: keyof Fixture['bases'],
    name: string,
    path: keyof Fixture['paths'] = 'none',
    extra: Partial<Case> = {},
  ): Case => ({
    name: `${base}/${name} [gitleaks ${path}]`,
    clone: fx.clone,
    base: fx.bases[base],
    head: head(base, name),
    path: fx.paths[path],
    ...extra,
  });

  const cases = (): Case[] => [
    on('b0', 'clean'),
    on('b0', 'deny'),
    on('b0', 'removed'),
    on('b0', 'allow'),
    on('b0', 'envScoped'),
    on('b0', 'secret'),
    on('b0', 'multi'),
    on('b0', 'noNewline'),
    // A head equal to its base has an empty diff.
    { ...on('b0', 'clean'), name: 'empty diff', head: fx.bases.b0 },
    // Exemptions are read from the base only.
    on('b0', 'selfExempt'),
    on('valid', 'secret'),
    on('valid', 'secretFixtureOnly'),
    on('valid', 'secretAndDeny'),
    on('valid', 'multi'),
    on('syntax', 'secretFixtureOnly', 'none', { looseExemptionError: true }),
    on('syntax', 'clean', 'none', { looseExemptionError: true }),
    on('notExemptible', 'secretFixtureOnly'),
    on('incomplete', 'secretFixtureOnly'),
    // gitleaks: absent, clean, a generic hit, exempted, vetoed, and a failing binary.
    on('b0', 'clean', 'clean'),
    on('b0', 'glPlain', 'generic'),
    on('valid', 'glFixture', 'generic'),
    on('valid', 'glFixture', 'provider'),
    on('b0', 'glFixture', 'generic'),
    on('b0', 'clean', 'error'),
    on('valid', 'secretFixtureOnly', 'clean'),
    // Failures: an unknown head, a missing or unusable patterns file, a missing job directory.
    {
      name: 'unknown head',
      clone: fx.clone,
      base: fx.bases.b0,
      head: 'f'.repeat(40),
      path: fx.paths.none,
    },
    {
      name: 'no patterns file on origin/main',
      clone: fx.noPatterns.clone,
      base: fx.noPatterns.base,
      head: fx.noPatterns.head,
      path: fx.paths.none,
    },
    {
      name: 'garbage patterns file',
      clone: fx.garbagePatterns.clone,
      base: fx.garbagePatterns.base,
      head: fx.garbagePatterns.head,
      path: fx.paths.none,
    },
    on('b0', 'deny', 'none', { name: 'missing job directory', jobDir: false }),
    on('b0', 'clean', 'none', { name: 'missing job directory, clean', jobDir: false }),
  ];

  it('agrees with Python on the verdict, the exception class and text, and the report bytes', async () => {
    const all = await place(cases());
    const oracle = runOracle(all);
    const verdicts = new Map<string, Outcome>();
    for (const [index, item] of all.entries()) {
      const ts = await runTs(item);
      const py = oracle[index] as Outcome;
      const label = item.name;
      const expected = {
        ok: py.ok,
        error: py.error === undefined ? undefined : (PY_CLASS[py.error] ?? py.error),
        // An OS error's text is the platform's wording and the state root's path: class only.
        message: py.error !== undefined && py.error in PY_CLASS ? undefined : py.message,
      };
      expect({
        label,
        ok: ts.ok,
        error: ts.error,
        message: expected.message === undefined ? undefined : ts.message,
      }).toEqual({
        label,
        ...expected,
      });
      expect({ label, report: normalise(ts.report, item.looseExemptionError) }).toEqual({
        label,
        report: normalise(py.report, item.looseExemptionError),
      });
      verdicts.set(label, py);
    }
    const of = (label: string): Outcome => {
      const found = verdicts.get(label);
      if (found === undefined) throw new Error(`no case ${label}`);
      return found;
    };
    // The oracle exercised every verdict, so the differential is not vacuous.
    expect(of('b0/clean [gitleaks none]').ok).toBe(true);
    expect(of('b0/deny [gitleaks none]').ok).toBe(false);
    expect(of('b0/removed [gitleaks none]').ok).toBe(false);
    expect(of('b0/allow [gitleaks none]').ok).toBe(true);
    expect(of('b0/envScoped [gitleaks none]').ok).toBe(false);
    expect(of('b0/selfExempt [gitleaks none]').ok).toBe(false);
    expect(of('valid/secretFixtureOnly [gitleaks none]').ok).toBe(true);
    expect(of('valid/secret [gitleaks none]').ok).toBe(false);
    expect(of('valid/secretAndDeny [gitleaks none]').ok).toBe(false);
    expect(of('syntax/secretFixtureOnly [gitleaks none]').ok).toBe(false);
    expect(of('b0/glPlain [gitleaks generic]').ok).toBe(false);
    expect(of('valid/glFixture [gitleaks generic]').ok).toBe(true);
    expect(of('valid/glFixture [gitleaks provider]').ok).toBe(false);
    expect(of('b0/clean [gitleaks error]').ok).toBe(false);
    expect(of('b0/clean [gitleaks clean]').ok).toBe(true);
    expect(of('unknown head').error).toBe('RuntimeError');
    expect(of('no patterns file on origin/main').error).toBe('RuntimeError');
    expect(of('garbage patterns file').message).toBe('denylist parse failed (fail closed)');
    expect(of('missing job directory').error).toBe('FileNotFoundError');
    // The exemption outcomes and the gitleaks statuses are what the reports record.
    const reportOf = (label: string) =>
      JSON.parse(of(label).report ?? 'null') as {
        gitleaks: string;
        exempted?: { denylist: unknown[]; gitleaks: unknown[] };
        exemption_error?: string;
      } | null;
    expect(reportOf('valid/secretFixtureOnly [gitleaks none]')?.exempted?.denylist).toHaveLength(1);
    expect(reportOf('valid/glFixture [gitleaks generic]')?.exempted?.gitleaks).toHaveLength(1);
    expect(reportOf('syntax/clean [gitleaks none]')?.exemption_error).toContain('scan-exemptions');
    expect(reportOf('b0/clean [gitleaks none]')?.gitleaks).toBe('not-run');
    expect(reportOf('b0/clean [gitleaks error]')?.gitleaks).toBe('exit 2');
    expect(of('missing job directory').report).toBeNull();
  });

  it('never records matched content in the report', async () => {
    const [item] = await place([on('b0', 'secret')]);
    const result = await runTs(item as Placed);
    expect(result.ok).toBe(false);
    expect(result.report).not.toContain('value1');
    expect(result.report).not.toContain('value2');
  });
});

function call(code: number | null, stdout: string | Uint8Array = '', stderr = ''): GitCall {
  return {
    args: [],
    code,
    stdout: typeof stdout === 'string' ? new TextEncoder().encode(stdout) : stdout,
    stderr,
  };
}

const BASE = 'b'.repeat(40);
const HEAD = 'a'.repeat(40);
const CLEAN_DIFF =
  'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-l1\n+l1 changed';
const DIRTY_DIFF =
  'diff --git a/src/y.txt b/src/y.txt\n--- a/src/y.txt\n+++ b/src/y.txt\n@@ -0,0 +1 @@\n+use denyword here';

describe('publication secret scan: scripted process', () => {
  const stateRoots: string[] = [];

  async function stateRoot(withJob = true): Promise<string> {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'crq-pub-scan-state-')));
    cleanups.push(root);
    stateRoots.push(root);
    if (withJob) await mkdir(join(root, 'repair', JOB), { recursive: true });
    return root;
  }

  interface Script {
    diff?: GitCall;
    size?: GitCall;
    blob?: GitCall;
    patterns?: GitCall;
  }

  /** Answers a clean, exemption-free scan by default; `script` replaces single replies. */
  function scripted(script: Script = {}) {
    const log: { cwd: string; args: readonly string[] }[] = [];
    const runner =
      (cwd: string): RunGit =>
      async (args) => {
        log.push({ cwd, args });
        const reply =
          args[0] === 'diff'
            ? (script.diff ?? call(0, CLEAN_DIFF))
            : args[0] === 'cat-file' && args[1] === '-s'
              ? (script.size ?? call(0))
              : args[0] === 'cat-file'
                ? (script.blob ?? call(0))
                : args[0] === 'show'
                  ? (script.patterns ?? call(0, PATTERNS))
                  : call(0);
        return { ...reply, args };
      };
    return { log, runner };
  }

  const build = async (
    script: Script = {},
    overrides: Partial<Parameters<typeof gitPublicationSecretScan>[0]> = {},
  ) => {
    const root = await stateRoot();
    const { log, runner } = scripted(script);
    const scan = gitPublicationSecretScan({
      stateRoot: root,
      clone: '/repos/primary',
      runGitFor: runner,
      match,
      gitleaks: async () => ({ kind: 'not-run' }),
      ...overrides,
    });
    return { root, log, scan, report: join(root, 'repair', JOB, SECRET_SCAN_REPORT) };
  };

  it('runs the exact argv in Python order, all in the primary clone', async () => {
    const { log, scan, report } = await build();
    await expect(scan.secretScan(JOB, BASE, HEAD)).resolves.toBe(true);
    expect(log.map((entry) => entry.cwd)).toEqual([
      '/repos/primary',
      '/repos/primary',
      '/repos/primary',
    ]);
    expect(log.map((entry) => entry.args)).toEqual([
      ['diff', ...HARDENED_DIFF_FLAGS, '--unified=0', BASE, HEAD],
      ['cat-file', '-s', `${BASE}:.crq/scan-exemptions.toml`],
      ['show', 'origin/main:policy/denylist/patterns.yml'],
    ]);
    const written = JSON.parse(await readFile(report, 'utf8')) as Record<string, unknown>;
    expect(written).toMatchObject({
      base: BASE,
      head: HEAD,
      denylist_rules: 3,
      denylist_hits: [],
      gitleaks: 'not-run',
      gitleaks_hits: [],
    });
    expect(written).not.toHaveProperty('exempted');
  });

  it('reads the exemption blob only when the base has the file, and applies it', async () => {
    const { log, scan, report } = await build({
      diff: call(
        0,
        'diff --git a/fixtures/s.txt b/fixtures/s.txt\n--- a/fixtures/s.txt\n+++ b/fixtures/s.txt\n@@ -0,0 +1 @@\n+FAKE_SECRET_ONE=value1',
      ),
      size: call(0, '123\n'),
      blob: call(0, EXEMPTIONS),
    });
    await expect(scan.secretScan(JOB, BASE, HEAD)).resolves.toBe(true);
    expect(log.map((entry) => entry.args.slice(0, 2))).toEqual([
      ['diff', '--text'],
      ['cat-file', '-s'],
      ['cat-file', 'blob'],
      ['show', 'origin/main:policy/denylist/patterns.yml'],
    ]);
    const written = JSON.parse(await readFile(report, 'utf8')) as {
      exempted: { denylist: { rule: string; file: string; reason: string }[] };
    };
    expect(written.exempted.denylist).toEqual([
      {
        rule: 'class:inline-secret-assignments',
        file: 'fixtures/s.txt',
        diff_line: 5,
        reason: 'synthetic fixture',
      },
    ]);
  });

  it('answers false for a dirty scan, and still writes the report', async () => {
    const { scan, report } = await build({ diff: call(0, DIRTY_DIFF) });
    await expect(scan.secretScan(JOB, BASE, HEAD)).resolves.toBe(false);
    const written = JSON.parse(await readFile(report, 'utf8')) as { denylist_hits: unknown[] };
    expect(written.denylist_hits).toEqual([
      { rule: 'class:deny-word', file: 'src/y.txt', diff_line: 5 },
    ]);
  });

  it('strips and decodes git output the way text mode does', async () => {
    const { scan, report } = await build({
      diff: call(0, `\n${DIRTY_DIFF.replaceAll('\n', '\r\n')}\r\n\n`),
    });
    await expect(scan.secretScan(JOB, BASE, HEAD)).resolves.toBe(false);
    expect(JSON.parse(await readFile(report, 'utf8'))).toMatchObject({
      denylist_hits: [{ diff_line: 5 }],
    });
  });

  it('refuses a commit that is not 40 hex, and a bad job id, before any Git call', async () => {
    const { log, scan } = await build();
    for (const [target, head] of [
      ['--output=x', HEAD],
      [BASE, 'HEAD~0'],
      ['main', HEAD],
      [BASE, ''],
    ] as const) {
      await expect(scan.secretScan(JOB, target, head)).rejects.toMatchObject({
        kind: 'ValueError',
      });
    }
    await expect(scan.secretScan('../escape', BASE, HEAD)).rejects.toMatchObject({
      kind: 'ValueError',
    });
    await expect(scan.secretScan(7, BASE, HEAD)).rejects.toMatchObject({ kind: 'TypeError' });
    expect(log).toEqual([]);
  });

  it('is RuntimeError with the c.git text when a read exits non-zero', async () => {
    const stderr = `fatal: bad object ${HEAD}\n${'x'.repeat(600)}`;
    const { scan, log } = await build({ diff: call(128, '', stderr) });
    const failure = await scan.secretScan(JOB, BASE, HEAD).catch((error: unknown) => error);
    expect(isPyError(failure, 'RuntimeError')).toBe(true);
    expect((failure as Error).message).toBe(
      `git diff --no-color --no-ext-diff --unified=0 ${BASE} … exit 128: ${stderr.trim().slice(0, 400)}`,
    );
    expect(log).toHaveLength(1);

    const patterns = await build({ patterns: call(128, '', 'fatal: path does not exist\n') });
    await expect(patterns.scan.secretScan(JOB, BASE, HEAD)).rejects.toMatchObject({
      kind: 'RuntimeError',
      message:
        'git show origin/main:policy/denylist/patterns.yml … exit 128: fatal: path does not exist',
    });
  });

  it('is OSError when a process never answered, not a verdict', async () => {
    for (const script of [
      { diff: call(null, '', 'timed out') },
      { size: call(null, '', 'timed out') },
      { patterns: call(null, '', 'timed out') },
    ] satisfies Script[]) {
      const { scan, report } = await build(script);
      await expect(scan.secretScan(JOB, BASE, HEAD)).rejects.toMatchObject({ kind: 'OSError' });
      await expect(readFile(report, 'utf8')).rejects.toThrow();
    }
  });

  it('is ValueError for invalid UTF-8 in the diff or the patterns', async () => {
    const bad = new Uint8Array([0xff, 0xfe, 0x0a]);
    for (const script of [{ diff: call(0, bad) }, { patterns: call(0, bad) }] satisfies Script[]) {
      const { scan } = await build(script);
      await expect(scan.secretScan(JOB, BASE, HEAD)).rejects.toMatchObject({ kind: 'ValueError' });
    }
  });

  it('fails closed on an exemption blob it cannot read, and still scans', async () => {
    const dirty = call(0, DIRTY_DIFF);
    for (const blob of [call(null, '', 'timed out'), call(0, new Uint8Array([0xff, 0xfe]))]) {
      const { scan, report } = await build({ diff: dirty, size: call(0, '9'), blob });
      await expect(scan.secretScan(JOB, BASE, HEAD)).resolves.toBe(false);
      const written = JSON.parse(await readFile(report, 'utf8')) as {
        exemption_error: string;
        denylist_hits: unknown[];
      };
      expect(written.exemption_error).toMatch(/^\.crq\/scan-exemptions\.toml: /);
      expect(written.denylist_hits).toHaveLength(1);
    }
    // A blob read that exits non-zero prints nothing: an empty file, so no exemptions and no error.
    const { scan, report } = await build({ size: call(0, '9'), blob: call(128, '', 'fatal') });
    await expect(scan.secretScan(JOB, BASE, HEAD)).resolves.toBe(true);
    expect(JSON.parse(await readFile(report, 'utf8'))).not.toHaveProperty('exemption_error');
  });

  it('is RuntimeError("denylist parse failed (fail closed)") for patterns it cannot use', async () => {
    for (const text of ['', 'not a patterns file\n', 'rules:\n']) {
      const { scan } = await build({ patterns: call(0, text) });
      await expect(scan.secretScan(JOB, BASE, HEAD)).rejects.toMatchObject({
        kind: 'RuntimeError',
        message: 'denylist parse failed (fail closed)',
      });
    }
  });

  it('is OSError when the report cannot be written, and never a clean verdict', async () => {
    const root = await stateRoot(false);
    const { runner } = scripted();
    const scan = gitPublicationSecretScan({
      stateRoot: root,
      clone: '/repos/primary',
      runGitFor: runner,
      match,
      gitleaks: async () => ({ kind: 'not-run' }),
    });
    await expect(scan.secretScan(JOB, BASE, HEAD)).rejects.toMatchObject({ kind: 'OSError' });
    // `Path.write_text` does not create the job directory.
    await expect(readFile(join(root, 'repair', JOB, SECRET_SCAN_REPORT), 'utf8')).rejects.toThrow();
  });

  it('propagates an unavailable matcher or gitleaks without writing a report', async () => {
    const matcher = await build(
      {},
      {
        match: async () => {
          throw new Error('worker lost');
        },
      },
    );
    await expect(matcher.scan.secretScan(JOB, BASE, HEAD)).rejects.toThrow(
      'review scan matcher unavailable',
    );
    await expect(readFile(matcher.report, 'utf8')).rejects.toThrow();

    const gitleaks = await build(
      {},
      {
        gitleaks: async () => {
          throw new Error('crashed');
        },
      },
    );
    await expect(gitleaks.scan.secretScan(JOB, BASE, HEAD)).rejects.toThrow(
      'review gitleaks unavailable',
    );
    await expect(readFile(gitleaks.report, 'utf8')).rejects.toThrow();
  });

  it('treats a gitleaks exit as a hit and a missing report as a refusal, never clean', async () => {
    const failing = await build(
      {},
      { gitleaks: async () => ({ kind: 'exit', code: 2, hits: null }) },
    );
    await expect(failing.scan.secretScan(JOB, BASE, HEAD)).resolves.toBe(false);
    expect(JSON.parse(await readFile(failing.report, 'utf8'))).toMatchObject({
      gitleaks: 'exit 2',
      gitleaks_hits: [{ rule: 'gitleaks-error', diff_line: null }],
    });
    const unreadable = await build(
      {},
      { gitleaks: async () => ({ kind: 'exit', code: 0, hits: null }) },
    );
    await expect(unreadable.scan.secretScan(JOB, BASE, HEAD)).rejects.toThrow(
      'gitleaks report unavailable',
    );
  });

  it('is a structural subset of the publish effects', () => {
    const scan = gitPublicationSecretScan({
      stateRoot: '/state',
      clone: '/repos/primary',
      gitleaks: async () => ({ kind: 'not-run' }),
    });
    expect(pinned(scan).secretScan).toBeTypeOf('function');
  });
});

describe('publication secret scan through publishRepair (real repositories)', () => {
  /** A primary clone whose `origin/main` carries the patterns; the repair adds `files`. */
  async function repairRepo(files: Files) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'crq-pub-scan-e2e-')));
    cleanups.push(root);
    const wtRoot = join(root, 'wt');
    const state = join(root, 'state');
    await mkdir(wtRoot);
    await mkdir(join(state, 'repair', JOB), { recursive: true });
    const { clone, b0 } = await makeRepo(root, 'clone', PATTERNS);
    const repair = await commitOver(clone, b0, files, `fix ${JOB}: one`);
    git(clone, 'checkout', '-q', '--detach', b0);
    return { root, clone, wtRoot, state, base: b0, repair };
  }

  function effects(
    repo: { clone: string; wtRoot: string; state: string },
    calls: string[],
    patched: string[] = [],
  ) {
    const reads = gitPublicationReads({ clone: repo.clone, worktreeRoot: repo.wtRoot, runGitFor });
    const writes = gitPublicationWorktrees({
      clone: repo.clone,
      worktreeRoot: repo.wtRoot,
      worktreePrefix: 'crq-',
      runGitFor,
    });
    const verify = gitPublicationVerify({ worktreeRoot: repo.wtRoot, runGitFor });
    const scan = gitPublicationSecretScan({
      stateRoot: repo.state,
      clone: repo.clone,
      runGitFor,
      match,
      gitleaks: async () => ({ kind: 'not-run' }),
    });
    return {
      ...reads,
      ...writes,
      ...verify,
      ...scan,
      async removeWorktree(worktree: { path: string; branch: string }) {
        calls.push('remove');
        await writes.removeWorktree(worktree);
      },
      readJournal: async () => null,
      async writePatch(_job: unknown, text: string) {
        patched.push(text);
      },
      async hackDetector() {
        calls.push('detector');
      },
      async updateRef() {
        calls.push('updateRef');
        throw new Error('stop after the scan');
      },
      async writeJournal() {
        calls.push('journal');
      },
      async push() {
        calls.push('push');
      },
      iso: () => '2026-01-01T00:00:00Z',
    } as unknown as PublicationPublishEffects;
  }

  const run = (repo: Awaited<ReturnType<typeof repairRepo>>, calls: string[]) => {
    const record: Record<string, unknown> = { jobs: [JOB], open_pr: false, base: repo.base };
    return publishRepair(effects(repo, calls), {}, { id: 'x' }, 'run1', record, [
      { commits: [repo.repair], job: JOB },
    ]).then(
      () => ({ record, failure: undefined as unknown }),
      (failure: unknown) => ({ record, failure }),
    );
  };

  it('refuses a dirty publication: ValueError, worktree removed, nothing journaled or pushed', async () => {
    const repo = await repairRepo({ 'src/y.txt': 'one\nuse denyword here\n' });
    const calls: string[] = [];
    const { record, failure } = await run(repo, calls);
    expect(isPyError(failure, 'ValueError')).toBe(true);
    expect((failure as Error).message).toBe(REFUSE_SECRET_SCAN);
    expect(calls).toEqual(['detector', 'remove']);
    expect(record['publication']).toBeUndefined();
    const written = JSON.parse(
      await readFile(join(repo.state, 'repair', JOB, SECRET_SCAN_REPORT), 'utf8'),
    ) as { base: string; denylist_hits: { rule: string; file: string }[] };
    expect(written.base).toBe(repo.base);
    expect(written.denylist_hits).toMatchObject([{ rule: 'class:deny-word', file: 'src/y.txt' }]);
  });

  it('refuses a removed line that carried the denied shape, as Python scans both directions', async () => {
    const repo = await repairRepo({ 'old.txt': 'keep\nkeep\n' });
    const calls: string[] = [];
    const { failure } = await run(repo, calls);
    expect((failure as Error).message).toBe(REFUSE_SECRET_SCAN);
    expect(calls).toEqual(['detector', 'remove']);
  });

  it('lets a clean publication reach the ref update', async () => {
    const repo = await repairRepo({ 'a.txt': 'l1 fixed\nl2\nl3\n' });
    const calls: string[] = [];
    const { failure } = await run(repo, calls);
    expect((failure as Error).message).toBe('stop after the scan');
    expect(calls).toEqual(['detector', 'updateRef', 'remove']);
    const written = JSON.parse(
      await readFile(join(repo.state, 'repair', JOB, SECRET_SCAN_REPORT), 'utf8'),
    ) as { denylist_hits: unknown[]; gitleaks_hits: unknown[]; gitleaks: string };
    expect(written).toMatchObject({ denylist_hits: [], gitleaks_hits: [], gitleaks: 'not-run' });
  });

  it('removes the worktree and propagates when the scan itself cannot run', async () => {
    const repo = await repairRepo({ 'a.txt': 'l1 fixed\nl2\nl3\n' });
    await rm(join(repo.state, 'repair', JOB), { recursive: true });
    const calls: string[] = [];
    const { record, failure } = await run(repo, calls);
    expect(isPyError(failure, 'OSError')).toBe(true);
    expect(calls).toEqual(['detector', 'remove']);
    expect(record['publication']).toBeUndefined();
  });
});
