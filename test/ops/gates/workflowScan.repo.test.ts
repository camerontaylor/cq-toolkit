// Split provenance: test/ops/gates/workflowScan.test.ts was split by subject
// into workflowScan.{scan,reject,differential,privilege,producers,lint,headCheckout,diff,repo}.test.ts.
// This file covers the repository's own workflows.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { lintWorkflow, producersOf, scanWorkflow } from '../../../src/ops/gates/workflowScan.js';
import { ok, WORKFLOW_DIR } from './workflowScan.helpers.js';

describe('the repository workflows', () => {
  const files = readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f));
  const read = (f: string) => readFileSync(join(WORKFLOW_DIR, f), 'utf8');

  test.each(files)('%s scans ok', (f) => {
    const scan = scanWorkflow(read(f));
    expect(scan.ok ? 'ok' : scan.reason).toBe('ok');
  });

  test.each([
    ['ci.yml', 'static', ['static']],
    ['denylist.yml', 'denylist', ['denylist']],
    ['ratchet.yml', 'ratchet', ['ratchet']],
  ])('%s produces %s', (f, check, producers) => {
    expect(producersOf(ok(read(f)), check)).toEqual(producers);
  });

  test('cq-measure.yml jobs are not privileged under permissions: {}', () => {
    const scan = ok(read('cq-measure.yml'));
    expect(scan.jobs.size).toBeGreaterThan(0);
    for (const j of scan.jobs.values()) expect(j.privileged).toBe(false);
  });

  test('every repository workflow lints clean (W1.10 scoped the cq-verify fetch credential)', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect([f, lintWorkflow(`.github/workflows/${f}`, ok(read(f)))]).toEqual([f, []]);
    }
  });
});
