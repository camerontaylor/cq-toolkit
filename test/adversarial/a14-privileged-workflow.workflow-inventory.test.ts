// §7 A14 static token isolation — the real-workflow inventory itself: every
// generated workflow scans, and every secret-reading dispatch job runs in a
// main-only environment. Split provenance:
// test/adversarial/a14-privileged-workflow.test.ts was split by subject; the
// shared fixture (including the workflow inventory) lives in
// a14-privileged-workflow.helpers.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { scanWorkflow } from '../../src/ops/gates/workflowScan.js';
import { files, ROOT } from './a14-privileged-workflow.helpers.js';

describe('§7 A14 static token isolation over the toolkit’s real workflows', () => {
  test('every generated workflow is scanned, with the trigger and job facts this row needs', () => {
    const generated = files.filter((path) => path.startsWith('.github/workflows/'));
    expect(generated.length).toBeGreaterThan(5);
    expect(files.length).toBeGreaterThan(generated.length);
    for (const path of generated) {
      const scan = scanWorkflow(readFileSync(join(ROOT, path), 'utf8'));
      expect(scan.ok, path).toBe(true);
      if (!scan.ok) continue;
      expect(Array.isArray(scan.triggers), path).toBe(true);
      expect(scan.jobs.size, path).toBeGreaterThan(0);
    }
  });

  test('every secret-reading workflow_dispatch job runs in a main-only environment', () => {
    // A write collaborator can dispatch from any branch, and that ref's copy of
    // the workflow controls the shell, so an in-step ref check is not a
    // boundary: the deployment policy must withhold the environment secrets.
    const settings = JSON.parse(
      readFileSync(join(ROOT, 'policy/templates/github-settings.json'), 'utf8'),
    ) as {
      environments: Record<string, { branch_policies: { name: string; type: string }[] }>;
    };
    const unprotected: string[] = [];
    let checked = 0;
    for (const path of files) {
      const scan = scanWorkflow(readFileSync(join(ROOT, path), 'utf8'));
      if (!scan.ok || !scan.triggers.includes('workflow_dispatch')) continue;
      for (const [id, job] of scan.jobs) {
        if (!/\bsecrets\.[A-Za-z_]/.test(job.text)) continue;
        checked += 1;
        const name = /\benvironment:\s*([A-Za-z0-9_-]+)/.exec(job.text)?.[1];
        const policies =
          name === undefined ? undefined : settings.environments[name]?.branch_policies;
        const mainOnly =
          policies?.length === 1 && policies[0]?.name === 'main' && policies[0].type === 'branch';
        if (!mainOnly) unprotected.push(`${path}:${id} (${name ?? 'no environment'})`);
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(unprotected).toEqual([]);
  });
});
