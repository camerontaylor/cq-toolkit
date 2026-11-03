// §7 A14 static token isolation — reachability: no secret-reading job and no
// promotion credential is reachable from an untrusted trigger.
// Split provenance: the old test/adversarial/a14-privileged-workflow.test.ts
// was split by subject; the shared fixture (including the workflow inventory)
// lives in a14-privileged-workflow.helpers.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { scanWorkflow } from '../../src/ops/gates/workflowScan.js';
import { files, ROOT, UNTRUSTED_TRIGGERS } from './a14-privileged-workflow.helpers.js';

describe('§7 A14 static token isolation over the toolkit’s real workflows', () => {
  test('no job that reads a repository secret is reachable from an untrusted trigger', () => {
    const carriers: string[] = [];
    for (const path of files) {
      const scan = scanWorkflow(readFileSync(join(ROOT, path), 'utf8'));
      if (!scan.ok) continue;
      const untrusted = scan.triggers.filter((t) => UNTRUSTED_TRIGGERS.includes(t));
      if (untrusted.length === 0) continue;
      for (const [id, job] of scan.jobs) {
        // `text` is normalised node text: comment lines (which name the
        // credentials they must not leak) are already dropped.
        // The direct-PR advisory job has no secrets. Trusted sibling jobs
        // explicitly exclude that event at job level, before any mint step.
        const condition = /^ {4}if: (.+)$/m.exec(job.text)?.[1] ?? '';
        const excludesUntrusted =
          !condition.includes('||') &&
          untrusted.every((event) => condition.startsWith(`github.event_name != '${event}' && `));
        if (/\bsecrets\.[A-Za-z_]/.test(job.text) && !excludesUntrusted) {
          carriers.push(`${path}:${id} (${untrusted.join(', ')})`);
        }
      }
    }
    expect(carriers).toEqual([]);
  });

  test('no promotion credential is reachable from an untrusted trigger', () => {
    /** The credentials that can promote, push as automation, or read settings. */
    const PROMOTION_CREDENTIALS =
      /\bsecrets\.(PROMOTE_TOKEN|GH_TOKEN|CQ_AUTOMATION_TOKEN|CQ_AUTOMATION_APP_KEY|CQ_DRILL_MERGE_TOKEN|CQ_SETTINGS_TOKEN|CQ_AUTOMATION_SECOND_TOKEN)\b/;
    const carriers: string[] = [];
    const exposed: string[] = [];
    for (const path of files) {
      const scan = scanWorkflow(readFileSync(join(ROOT, path), 'utf8'));
      if (!scan.ok) continue;
      const untrusted = scan.triggers.filter((t) => UNTRUSTED_TRIGGERS.includes(t));
      for (const [id, job] of scan.jobs) {
        if (!PROMOTION_CREDENTIALS.test(job.text)) continue;
        carriers.push(`${path}:${id}`);
        if (untrusted.length > 0) exposed.push(`${path}:${id} (${untrusted.join(', ')})`);
      }
    }
    expect(exposed).toEqual([]);
    // Non-vacuous: the promotion and automation workflows really are scanned,
    // and really do carry a promotion credential.
    expect(carriers).toContain('.github/workflows/self-merge-prs.yml:self-merge-prs');
    expect(carriers.length).toBeGreaterThan(4);
  });
});
