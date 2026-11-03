// Split provenance: test/ops/gates/workflowScan.test.ts was split by subject
// into workflowScan.{scan,reject,differential,privilege,producers,lint,headCheckout,diff,repo}.test.ts;
// this module holds the fixtures they share.
import { join } from 'node:path';
import {
  lintWorkflow,
  scanWorkflow,
  type WorkflowFinding,
  type WorkflowScan,
} from '../../../src/ops/gates/workflowScan.js';

export const REPO_ROOT = join(__dirname, '..', '..', '..');
export const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');
export const PATH = '.github/workflows/x.yml';

/** Build a workflow from lines (keeps fixtures readable and indentation exact). */
export const wf = (...lines: string[]): string => `${lines.join('\n')}\n`;

export function ok(text: string): WorkflowScan & { ok: true } {
  const scan = scanWorkflow(text);
  if (!scan.ok) throw new Error(`expected ok scan, got: ${scan.reason}`);
  return scan;
}

export const job = (text: string, id: string) => {
  const found = ok(text).jobs.get(id);
  if (!found) throw new Error(`no job ${id}`);
  return found;
};

export const kinds = (findings: readonly WorkflowFinding[]): string[] =>
  findings.map((f) => f.kind);

/** Lint reasons for a workflow that scans ok. */
export const lintReasons = (text: string) => lintWorkflow(PATH, ok(text)).map((f) => f.reason);

/** A read-only single-job workflow, the baseline most cases perturb. */
export const READ_ONLY = wf(
  'name: ci',
  'on:',
  '  push:',
  '  pull_request:',
  'permissions:',
  '  contents: read',
  'jobs:',
  '  build:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v5',
  '        with:',
  '          persist-credentials: false',
  '      - run: npm test',
);
