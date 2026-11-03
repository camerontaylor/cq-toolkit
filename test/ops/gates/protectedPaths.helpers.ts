// Split provenance: test/ops/gates/protectedPaths.test.ts was split by subject
// into protectedPaths.{definitionSet,patternLiveness,privilegedList,policyPath,trustedJobs,trustBuild,closure}.test.ts;
// this module holds the fixtures they share.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { scanWorkflow } from '../../../src/ops/gates/workflowScan.js';

export const REPO_ROOT = join(__dirname, '..', '..', '..');

/**
 * Every job that builds or runs the trust checkout, with the invocation
 * classification the trusted-jobs suites assert over. A factory, not a
 * module-level constant: only the files that need it pay for the scan.
 */
export function trustedJobsFixture() {
  const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');
  const workflows = readdirSync(WORKFLOWS_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((file) => ({ file, text: readFileSync(join(WORKFLOWS_DIR, file), 'utf8') }));

  /** A job's lines without comments or step names (prose, not commands). */
  const commandLines = (text: string): string =>
    text
      .split('\n')
      .filter((line) => !/^\s*#/.test(line) && !/^\s*(?:-\s+)?name:/.test(line))
      .join('\n');

  /** A job builds or runs the trust checkout when its commands name `trust` as a path. */
  const TRUST_PATH = /(?:^|[\s"'=:])trust(?:\/|[ \t]*$)/m;

  /** Every job that builds or runs the trust checkout, with its workflow's head (env, defaults). */
  const trustedJobs = workflows.flatMap(({ file, text }) => {
    const scan = scanWorkflow(text);
    if (!scan.ok) throw new Error(`${file}: workflow does not scan`);
    const head = commandLines(text.slice(0, Math.max(0, text.search(/^jobs:/m))));
    return [...scan.jobs.values()]
      .map((job) => ({
        key: `${file}:${job.id}`,
        code: commandLines(job.text),
        head,
        localUses: job.localUses,
      }))
      .filter((job) => TRUST_PATH.test(job.code));
  });

  /** The one `node` form a trusted job may use, and the `pnpm` forms that build it. */
  const NODE_TOKEN = /(?<![\w-])node(?![\w.-])/g;
  const NODE_ENTRY = /^node\s+trust\/dist\/selfhost\/([\w-]+)\.js(?=[\s\\"';|)]|$)/;
  const PNPM_TOKEN = /(?<![\w./-])pnpm(?![\w./-])/g;
  const PNPM_FORMS = /^pnpm (?:install --frozen-lockfile --ignore-scripts|run build)[ \t]*$/m;
  /** Ways to load or run code a job's argv does not name, in the job or its workflow head. */
  const LOADERS =
    /\b(?:NODE_OPTIONS|NODE_PATH|nodejs|npx|pnpx|bunx?|deno|tsx|ts-node)\b|--(?:import|require|loader|experimental-loader)\b|\$\{?NODE\b|node_modules\/\.bin\b|^\s*shell:(?![ \t]*bash[ \t]*$)/m;

  /** One trusted job's selfhost entries, and every invocation of any other form. */
  function classifyTrustedJob(job: {
    key: string;
    code: string;
    head: string;
    localUses: readonly string[];
  }): { entries: string[]; unclassified: string[] } {
    const { key, code } = job;
    const entries: string[] = [];
    const unclassified: string[] = [];
    for (const m of code.matchAll(NODE_TOKEN)) {
      const entry = NODE_ENTRY.exec(code.slice(m.index))?.[1];
      // `/usr/bin/node …`: a node named by path is not the runner's `node`.
      if (entry === undefined || code[m.index - 1] === '/') {
        unclassified.push(`${key}: ${code.slice(Math.max(0, m.index - 20), m.index + 60)}`);
      } else entries.push(entry);
    }
    for (const m of code.matchAll(PNPM_TOKEN)) {
      if (!PNPM_FORMS.test(code.slice(m.index).split('\n')[0]!)) {
        unclassified.push(`${key}: ${code.slice(m.index).split('\n')[0]!}`);
      }
    }
    for (const [where, text] of [
      ['job', code],
      ['workflow head', job.head],
    ] as const) {
      const loader = LOADERS.exec(text);
      if (loader !== null) unclassified.push(`${key}: ${where} loads code via ${loader[0].trim()}`);
    }
    for (const local of job.localUses) unclassified.push(`${key}: runs local action ./${local}`);
    return { entries, unclassified };
  }

  /** Each trusted job's entries, computed once. */
  const TRUSTED = trustedJobs.map((job) => ({ key: job.key, ...classifyTrustedJob(job) }));

  return { workflows, TRUST_PATH, TRUSTED, classifyTrustedJob };
}
