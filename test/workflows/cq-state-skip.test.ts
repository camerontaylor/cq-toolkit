import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Required workflows select PR events and main pushes at job level.
const SKIP = `if: \${{ github.event_name == 'pull_request' || (github.event_name == 'push' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)) }}`;

const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

/** The job blocks under `jobs:`, keyed by job id (two-space `<id>:` lines). */
function jobIds(text: string): string[] {
  const lines = text.split('\n');
  const start = lines.indexOf('jobs:');
  if (start === -1) throw new Error('no jobs: block');
  const ids: string[] = [];
  for (const line of lines.slice(start + 1)) {
    // A non-indented, non-empty line is the next TOP-LEVEL key — the jobs
    // block is over, and nothing below it can be read as a job id
    // (PR #234 r1).
    if (/^\S/.test(line)) break;
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m !== null && m[1] !== undefined) ids.push(m[1]);
  }
  return ids;
}

/** The lines of one job block, from its `  <id>:` line to the next job id. */
function jobBlock(text: string, id: string): string[] {
  const lines = text.split('\n');
  const start = lines.indexOf('jobs:') + 1;
  const idLine = lines.findIndex((line, i) => i >= start && line === `  ${id}:`);
  if (idLine === -1) throw new Error(`no job ${id}`);
  const next = lines.findIndex((line, i) => i > idLine && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line));
  return lines.slice(idLine, next === -1 ? lines.length : next);
}

/** Every job id in `text` carries the job-level cq-state skip guard. */
function expectEveryJobGuarded(text: string, file: string): void {
  const jobs = jobIds(text);
  expect(jobs.length, `${file} declares jobs`).toBeGreaterThan(0);
  // The guard must sit at the JOB-KEY indent (four spaces — a direct key of
  // `  <id>:`), so a STEP-level `if:` deeper in the block cannot satisfy it
  // (CodeRabbit cycle 2). Exact-element match on the block's lines.
  const jobLevelGuard = `    ${SKIP}`;
  for (const id of jobs) {
    // The job's block runs from its id line to the next job (or EOF).
    const blockLines = jobBlock(text, id);
    const guard = blockLines.find((line) => line.startsWith('    if:'));
    expect(guard, `${file} job ${id} has event selection`).toBeDefined();
    if (file.includes('denylist')) expect(blockLines).toContain(jobLevelGuard);
    else {
      expect(guard).toContain("github.event_name == 'pull_request'");
      expect(guard).toContain(
        "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)",
      );
      expect(guard).toContain("github.event_name == 'schedule'");
    }
  }
}

describe('required workflow event selection', () => {
  it('instantiates the required-check example without drift', () => {
    const doc = read('policy/templates/required-check.md');
    const yaml = doc.split('```yaml\n')[1]?.split('\n```')[0];
    expect(yaml).toBeDefined();
    const rendered = yaml!
      .replaceAll('{{RUNNER}}', 'ubuntu-latest')
      .replaceAll('{{NODE_VERSION}}', '24')
      .replaceAll('{{INSTALL_CMD}}', 'pnpm install --frozen-lockfile');
    expect(read('.github/workflows/ci.yml')).toBe(
      `# instantiated from policy/templates/required-check.md — edit the template, not this file\n${rendered}\n`,
    );
  });
  it.each(['.github/workflows/ci.yml', '.github/workflows/denylist.yml'])(
    'every job in %s selects PRs and main pushes at the JOB level',
    (file) => {
      expectEveryJobGuarded(read(file), file);
    },
  );

  it('the required-check pattern carries the guard in its worked example', () => {
    const doc = read('policy/templates/required-check.md');
    // The worked example's fenced YAML block, pinned exactly like ci.yml
    // (PR #234 r1): a step-level guard in the template doc must fail this,
    // not pass a bare substring check.
    const open = doc.indexOf('```yaml');
    const yaml = doc.slice(open, doc.indexOf('```', open + 7));
    expectEveryJobGuarded(yaml, 'policy/templates/required-check.md worked example');
    // The template teaches the rule the guard obeys: the `on:` block of the
    // worked example stays filter-free.
    expect(yaml).toMatch(/on:\n {2}push:\n {2}pull_request:\n/);
  });
});

describe('required workflow cancellation isolation', () => {
  it.each(['.github/workflows/ci.yml', '.github/workflows/denylist.yml'])(
    '%s isolates each event and PR/ref',
    (file) => {
      const text = read(file);
      expect(text).toContain(
        'group: ${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.number || github.run_id }}',
      );
      expect(text).toContain('cancel-in-progress: true');
      expect(text).toMatch(/on:\n {2}push:\n {2}pull_request:\n/);
    },
  );
});

// Evaluate actual keys with no string comparisons: property lookup and || only.
// JavaScript string equality would not model GitHub's case-insensitive equality.
describe('concurrency collisions', () => {
  it.each(['ci.yml', 'denylist.yml'])('%s isolates cancellation axes', (file) => {
    const workflow = parse(read(`.github/workflows/${file}`)) as { concurrency: { group: string } };
    expect(workflow.concurrency.group).not.toMatch(/==|!=|format\(/);
    const key = (event: string, ref: string, run: number, pr = 0): string =>
      workflow.concurrency.group
        .replace(/\$\{\{([\s\S]*?)\}\}/g, (_whole: string, expression: string) =>
          String(
            runInNewContext(expression, {
              github: {
                workflow: file,
                event_name: event,
                ref,
                run_id: run,
                sha: 'same-sha',
                event: { repository: { default_branch: 'main' }, pull_request: { number: pr } },
              },
              format: (pattern: string, value: string) => pattern.replace('{0}', value),
            }),
          ),
        )
        .toLowerCase();
    const main = key('push', 'refs/heads/main', 1);
    // Every push finishes independently, including incremental main scans.
    expect(key('push', 'refs/heads/main', 2)).not.toBe(main);
    for (const ref of ['refs/heads/feature', 'refs/heads/Main', 'refs/tags/v1']) {
      expect(key('push', ref, 3)).not.toBe(main);
    }
    const pr = key('pull_request', 'refs/pull/7/merge', 4, 7);
    expect(key('pull_request', 'refs/pull/7/merge', 5, 7)).toBe(pr);
    expect(key('pull_request', 'refs/pull/8/merge', 6, 8)).not.toBe(pr);
    expect(key('push', 'refs/heads/feature', 7)).not.toBe(pr);
    expect(main).not.toBe(pr);
  });
});

// The fail-closed aggregation is the property that took two review rounds to
// get right (a skipped required job counts as SUCCESS, so `static` must run
// and fail rather than skip). The byte-identity pin between the template and
// the instance cannot see a consistent edit, so this block binds the
// semantics themselves: remove the guard step, the `needs` list or the shard
// flag and these fail.
describe('unit shard aggregation', () => {
  const ci = read('.github/workflows/ci.yml');
  const staticLines = jobBlock(ci, 'static');
  const staticText = staticLines.join('\n');
  const unitText = jobBlock(ci, 'unit').join('\n');

  it('the required static job waits for the shard matrix', () => {
    expect(staticText).toContain('    needs: [changes, unit]');
  });

  it('a failed shard fails static instead of skipping it', () => {
    const guard = staticLines.find(
      (line) => line.startsWith('        if:') && line.includes('needs.unit.result'),
    );
    expect(guard, 'static has a first step that reads needs.unit.result').toBeDefined();
    expect(guard).toContain("needs.unit.result == 'failure'");
    expect(staticText).toContain('      - name: Unit shards passed');
    expect(staticText).toContain('        run: exit 1');
  });

  it('a cancelled shard fails static on every event except a push', () => {
    const guard = staticLines.find(
      (line) => line.startsWith('        if:') && line.includes('needs.unit.result'),
    );
    expect(guard).toContain("github.event_name != 'push'");
    expect(guard).toContain("needs.unit.result == 'cancelled'");
    expect(guard).toContain("needs.changes.result == 'cancelled'");
  });

  it('static itself never skips a pull request', () => {
    const condition = staticLines.find(
      (line) => line.startsWith('    if:') && line.includes('needs.unit.result'),
    );
    expect(condition, 'static has a job-level if reading needs.unit.result').toBeDefined();
    expect(condition).toContain('!cancelled()');
    // The unit gate's OWN arm, not the independent event guard later on the
    // same line: `github.event_name == 'pull_request'` also appears there, so
    // only the whole arm pins the property. The fail-open form (skip static on
    // a pull request whose shards were cancelled) must be absent, because a
    // skipped required job counts as SUCCESS.
    expect(condition).toContain(
      "(needs.unit.result != 'cancelled' || github.event_name != 'push')",
    );
    expect(condition).not.toContain("|| github.event_name == 'push')");
    expect(condition).not.toContain("needs.unit.result == 'cancelled'");
  });

  it('the shards are four and the composite does not repeat the suite', () => {
    expect(unitText).toContain('shard: [1, 2, 3, 4]');
    expect(unitText).toContain('pnpm run test:unit --shard=${{ matrix.shard }}/4');
    expect(staticText).toContain('          unit: skip');
  });
});
