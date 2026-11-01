// W1.10 fix round (P1 composition review H1/M1/L1/L2) — the D-A.1
// default-ref dispatch guards and the gate's trigger-data invariants, pinned
// over both the templates and the instantiations where both exist.
//
// Pinned here:
//   1. Every privileged workflow that carries `workflow_dispatch` gates its
//      job(s) to the default ref (D-A.1): a dispatch on any other ref would
//      run that ref's copy of the file. The six files below either hold a
//      promotion-adjacent credential or dispatch one; the carriers that are
//      not dispatch (`push`, `schedule`, `workflow_run`) carry no
//      dispatcher-chosen ref, so their disjuncts admit them without the ref
//      clause.
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
  'self-merge-prs.yml': ['schedule'],
  'live-review.yml': [],
  'live-merge.yml': [],
  'live-drivers.yml': [],
};

/** Where each file's guarded job lives (all six are single-job workflows). */
const jobId: Readonly<Record<string, string>> = {
  'self-merge-prs.yml': 'self-merge-prs',
  'live-review.yml': 'live-review',
  'live-merge.yml': 'live-merge',
  'live-drivers.yml': 'live-drivers',
};

const sources: Record<string, Array<[string, string]>> = {
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
