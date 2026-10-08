// W1.10 fix round (P1 composition review H1/M1/L1/L2) — the D-A.1
// default-ref dispatch guards and the gate's trigger-data invariants, pinned
// over both the templates and the instantiations where both exist.
//
// Pinned here:
//   1. Every privileged workflow that carries `workflow_dispatch` gates its
//      job(s) to the default ref (D-A.1): a dispatch on any other ref would
//      run that ref's copy of the file. The seven files below either hold a
//      promotion-adjacent credential or dispatch one; the carriers that are
//      not dispatch (`push`, `schedule`, `workflow_run`, `status`) carry no
//      dispatcher-chosen ref, so their disjuncts admit them without the ref
//      clause (merge-queue-gate's `status` disjunct also filters the
//      context and state; its dispatch disjunct is `!= 'status'` + ref).
//   2. `gate.yml`'s `wake` job consumes exactly ONE field of the
//      `workflow_run` payload — the run id — and re-reads everything else
//      from the API by that id (path, event, branch, head repository id,
//      each refused loudly on mismatch). `head_sha` in particular is never
//      read: it is dispatcher-shaped data.
//   3. `decide`'s one privileged write — the cq-verify dispatch — targets
//      only `cq-verify.yml` and only the default branch.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const bothCopies = (template: string, instance = template): Array<[string, string]> => [
  [`policy/templates/${template}`, readFileSync(join(ROOT, 'policy/templates', template), 'utf8')],
  [
    `.github/workflows/${instance}`,
    readFileSync(join(ROOT, '.github/workflows', instance), 'utf8'),
  ],
];

const instanceOnly = (name: string): Array<[string, string]> => [
  [`.github/workflows/${name}`, readFileSync(join(ROOT, '.github/workflows', name), 'utf8')],
];

/** Non-comment lines only: rationale comments may name what the code must not do. */
function code(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/** The body of one top-level job (four-space indented block after `<id>:`). */
function jobBlock(text: string, jobId: string): string {
  const block = new RegExp(`^ {2}${jobId}:\\n((?: {4}.*\\n|\\n)*)`, 'm').exec(text)?.[1];
  expect(block, `no job ${jobId}`).toBeDefined();
  return block ?? '';
}

const DEFAULT_REF = "format('refs/heads/{0}', github.event.repository.default_branch)";

/**
 * The guard a job must carry: the default-ref clause ALWAYS, plus one
 * unconditional disjunct per non-dispatch carrier (which carries no
 * dispatcher-chosen ref).
 */
const carriers: Readonly<Record<string, readonly string[]>> = {
  'merge-queue-gate.yml': ['status'],
  'sync-merge-queue.yml': ['push'],
  'init-merge-queue.yml': [],
  'self-merge-prs.yml': ['schedule'],
  'live-review.yml': [],
  'live-merge.yml': [],
  'live-drivers.yml': [],
};

/** Where each file's guarded job lives (all seven are single-job workflows). */
const jobId: Readonly<Record<string, string>> = {
  'merge-queue-gate.yml': 'gate',
  'sync-merge-queue.yml': 'sync',
  'init-merge-queue.yml': 'init',
  'self-merge-prs.yml': 'self-merge-prs',
  'live-review.yml': 'live-review',
  'live-merge.yml': 'live-merge',
  'live-drivers.yml': 'live-drivers',
};

const sources: Record<string, Array<[string, string]>> = {
  'merge-queue-gate.yml': bothCopies('merge-queue-gate.yml'),
  'sync-merge-queue.yml': bothCopies('sync-merge-queue.yml'),
  'init-merge-queue.yml': bothCopies('init-merge-queue.yml'),
  'self-merge-prs.yml': bothCopies('self-host/self-merge-prs.yml', 'self-merge-prs.yml'),
  'live-merge.yml': bothCopies('live-merge.yml'),
  'live-review.yml': instanceOnly('live-review.yml'),
  'live-drivers.yml': instanceOnly('live-drivers.yml'),
};

describe('every dispatch carrier is gated to the default ref (D-A.1)', () => {
  it.each(
    Object.entries(sources).flatMap(([file, copies]) =>
      copies.map(([label, text]) => [file, label, text] as const),
    ),
  )('%s (%s)', (file, _label, text) => {
    const guard = code(jobBlock(text, jobId[file] ?? ''));
    expect(guard).toContain(DEFAULT_REF);
    for (const event of carriers[file] ?? []) {
      expect(guard).toContain(`github.event_name == '${event}'`);
    }
    // The dispatch carrier itself is admitted ONLY through the ref clause:
    // a bare `workflow_dispatch ||` disjunct would re-open every ref.
    expect(guard).not.toMatch(/event_name == 'workflow_dispatch'/);
  });
});

describe('gate.yml wake: the run id is the only payload field it consumes', () => {
  const gate = bothCopies('gate.yml')[0]?.[1] ?? '';
  const wake = jobBlock(gate, 'wake');

  it('the wake job consumes only the numeric run id from the workflow_run payload', () => {
    const refs = [...wake.matchAll(/github\.event\.workflow_run\.([A-Za-z_]+)/g)].map(
      (m) => m[1] ?? '',
    );
    expect(refs).toEqual(['id']);
    expect(wake).toMatch(/RUN_ID: \$\{\{ github\.event\.workflow_run\.id \}\}/);
  });

  it('the template: everything else is re-read from the API by id and refused on mismatch', () => {
    const body = code(wake);
    expect(body).toContain('gh api "repos/${REPO}/actions/runs/${RUN_ID}"');
    expect(body).toMatch(/case "\$path" in/);
    expect(body).toContain('.github/workflows/ci.yml|.github/workflows/cq-measure.yml');
    expect(body).toMatch(/\[ "\$event" = 'push' \]/);
    expect(body).toMatch(/\[ "\$branch" = 'merge-queue' \]/);
    expect(body).toMatch(/\[ "\$head_repo" = "\$REPO_ID" \]/);
  });

  it('the template: wake never reads head_sha (the dispatcher-shaped field)', () => {
    expect(code(wake)).not.toContain('head_sha');
  });
});

describe("decide's cq-verify dispatch is cq-verify.yml on the default ref only", () => {
  const gate = code(readFileSync(join(ROOT, '.github/workflows/gate.yml'), 'utf8'));
  const cli = code(readFileSync(join(ROOT, 'src/selfhost/promote-gate.ts'), 'utf8'));

  it('the workflow wires DEFAULT_BRANCH to the event’s default branch and passes it to the CLI', () => {
    expect(gate).toContain('DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}');
    expect(gate).toContain('--defaultBranch="$DEFAULT_BRANCH"');
  });

  it('every dispatches POST in the gate CLI targets cq-verify.yml', () => {
    expect(cli).toContain("VERIFY_WORKFLOW = 'cq-verify.yml'");
    const posts = [...cli.matchAll(/actions\/workflows\/[^`/]*\/dispatches/g)].map((m) => m[0]);
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every((p) => p === 'actions/workflows/${VERIFY_WORKFLOW}/dispatches')).toBe(true);
  });

  it('the dispatch ref is the configured default branch (behavioral: promote-gate.test.ts)', () => {
    expect(cli).toContain('`ref=${cfg.defaultBranch}`');
  });
});
