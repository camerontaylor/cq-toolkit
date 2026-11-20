/**
 * Local repair-patch scanner adapter tests.
 *
 * The adapter reuses the existing denylist engine and gitleaks defaults
 * scanner. Gitleaks is faked through `GitleaksEffects`; no external binary or
 * network participates. The tests pin the Python `ALLOWLIST_PATHS` decisions,
 * per-line added/removed scanning, typed verdicts, and that no matched text is
 * ever returned.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeRepairScan } from '../../../src/adapters/crq/repairScan.js';
import type { GitleaksEffects } from '../../../src/ops/dev/denylist.js';
import { JsonObject, parseJsonValue, type JsonValue } from '../../../src/policy/crq/jsonValue.js';
import {
  fullSourceScanPatch,
  fixInstructionsScanPatch,
} from '../../../src/policy/crq/repairGates.js';

const SOURCE = 'a'.repeat(40);
const SECRET = 'SECRET';

const fixture = asObject(
  parseJsonValue(
    readFileSync(
      new URL('../../../apps/crq-python/fixtures/repair-prepare/cases.json', import.meta.url),
      'utf8',
    ),
  ),
);

function asObject(value: JsonValue | undefined): JsonObject {
  if (!(value instanceof JsonObject)) throw new Error('expected a JSON object');
  return value;
}

function asArray(value: JsonValue | undefined): JsonValue[] {
  if (!Array.isArray(value)) throw new Error('expected a JSON array');
  return value;
}

function asString(value: JsonValue | undefined): string {
  if (typeof value !== 'string') throw new Error('expected a JSON string');
  return value;
}

function asBoolean(value: JsonValue | undefined): boolean {
  if (typeof value !== 'boolean') throw new Error('expected a JSON boolean');
  return value;
}

function fakeGitleaks(options: {
  readonly exitCode?: number;
  readonly report?: unknown;
  readonly throwOnRun?: boolean;
}): GitleaksEffects {
  return {
    async makeScratchDir(): Promise<string> {
      return mkdtempSync(join(tmpdir(), 'repair-scan-'));
    },
    async removeScratchDir(path: string): Promise<void> {
      await rm(path, { recursive: true, force: true });
    },
    async runCommand(_command, args) {
      if (options.throwOnRun === true) throw new Error('spawn failed');
      const reportAt = args.indexOf('--report-path');
      if (reportAt >= 0) {
        const path = args[reportAt + 1];
        // A real gitleaks run always writes its report, even when empty:
        // an omitted report fixture means a clean [], never a missing file.
        if (path !== undefined) writeFileSync(path, JSON.stringify(options.report ?? []));
      }
      return {
        exitCode: options.exitCode ?? 0,
        stdout: '',
        stderr: '',
        timedOut: false,
      };
    },
  };
}

describe('repair scan adapter allowlist and denylist', () => {
  const scan = makeRepairScan({
    rules: [{ id: 'secret', description: 'test', regex: SECRET }],
    gitleaksEffects: fakeGitleaks({}),
    gitleaksAvailable: () => false,
  });

  for (const row of asArray(fixture.get('allowlist_cases')).map(asObject)) {
    const path = asString(row.get('path'));
    test(`allowlist ${path}`, async () => {
      const result = await scan.scanDiff({
        patch: fullSourceScanPatch(path, `${SECRET}\n`),
        name: 'scan.json',
        base: null,
        head: SOURCE,
      });
      const allow = asBoolean(row.get('allow'));
      expect(result.report.denylistHits).toBe(allow ? 0 : 1);
      expect(result.report.gitleaks).toBe('not-run');
      expect(result.report.gitleaksHits).toBe(0);
      expect(result.clean).toBe(allow);
      expect(JSON.stringify(result)).not.toContain(SECRET);
    });
  }

  test('a path-scoped rule only fires on matching paths', async () => {
    const scoped = makeRepairScan({
      rules: [{ id: 'scoped', description: 'test', regex: SECRET, path: '^src/' }],
      gitleaksEffects: fakeGitleaks({}),
      gitleaksAvailable: () => false,
    });
    const source = await scoped.scanDiff({
      patch: fullSourceScanPatch('src/lock.ts', `${SECRET}\n`),
      name: 'scan.json',
      base: null,
      head: SOURCE,
    });
    const docs = await scoped.scanDiff({
      patch: fullSourceScanPatch('docs/x.md', `${SECRET}\n`),
      name: 'scan.json',
      base: null,
      head: SOURCE,
    });
    expect(source.report.denylistHits).toBe(1);
    expect(docs.report.denylistHits).toBe(0);
  });

  test('Git-quoted paths are decoded before path rules apply; undecodable ones fail closed', async () => {
    const scoped = makeRepairScan({
      rules: [{ id: 'scoped', description: 'test', regex: SECRET, path: '^src/\u00e9' }],
      gitleaksEffects: fakeGitleaks({}),
      gitleaksAvailable: () => false,
    });
    const quoted =
      'diff --git "a/src/\\303\\251.ts" "b/src/\\303\\251.ts"\n' +
      '--- "a/src/\\303\\251.ts"\n' +
      '+++ "b/src/\\303\\251.ts"\n' +
      '@@ -0,0 +1 @@\n' +
      `+${SECRET}\n`;
    const hit = await scoped.scanDiff({
      patch: quoted,
      name: 'scan.json',
      base: null,
      head: SOURCE,
    });
    expect(hit.report.denylistHits).toBe(1);
    const bad = await scoped.scanDiff({
      patch: quoted.replaceAll('\\303\\251', '\\777'),
      name: 'scan.json',
      base: null,
      head: SOURCE,
    });
    expect(bad.clean).toBe(false);
  });

  test('a git-quoted header path is decoded before path rules apply', async () => {
    const scoped = makeRepairScan({
      rules: [{ id: 'scoped', description: 'test', regex: SECRET, path: '^src/' }],
      gitleaksEffects: fakeGitleaks({}),
      gitleaksAvailable: () => false,
    });
    const patch =
      'diff --git "a/src/a\\tb.ts" "b/src/a\\tb.ts"\n' +
      '--- "a/src/a\\tb.ts"\n' +
      '+++ "b/src/a\\tb.ts"\n' +
      '@@ -0,0 +1 @@\n' +
      `+${SECRET}\n`;
    const result = await scoped.scanDiff({ patch, name: 'scan.json', base: null, head: SOURCE });
    expect(result.report.denylistHits).toBe(1);
  });

  test('an unquoted space-name header keeps its git tab delimiter out of the path', async () => {
    const scoped = makeRepairScan({
      rules: [{ id: 'scoped', description: 'test', regex: SECRET, path: '[.]env$' }],
      gitleaksEffects: fakeGitleaks({}),
      gitleaksAvailable: () => false,
    });
    // Real git output: a literal tab trails an unquoted name containing a space.
    const patch =
      'diff --git a/space name.env b/space name.env\n' +
      '--- a/space name.env\t\n' +
      '+++ b/space name.env\t\n' +
      '@@ -0,0 +1 @@\n' +
      `+${SECRET}\n`;
    const result = await scoped.scanDiff({ patch, name: 'scan.json', base: null, head: SOURCE });
    expect(result.report.denylistHits).toBe(1);
  });

  test('a C-quoted space-name header keeps its git tab delimiter out of the path', async () => {
    const scoped = makeRepairScan({
      rules: [{ id: 'scoped', description: 'test', regex: SECRET, path: '[.]env$' }],
      gitleaksEffects: fakeGitleaks({}),
      gitleaksAvailable: () => false,
    });
    // Git quotes a non-ASCII name and still appends a raw tab when it has a space.
    const patch =
      'diff --git "a/sp\\303\\251 name.env" "b/sp\\303\\251 name.env"\n' +
      '--- "a/sp\\303\\251 name.env"\t\n' +
      '+++ "b/sp\\303\\251 name.env"\t\n' +
      '@@ -0,0 +1 @@\n' +
      `+${SECRET}\n`;
    const result = await scoped.scanDiff({ patch, name: 'scan.json', base: null, head: SOURCE });
    expect(result.report.denylistHits).toBe(1);
  });

  test('removed and added lines are scanned; context and headers are not', async () => {
    const patch =
      'diff --git a/src/lock.ts b/src/lock.ts\n' +
      '--- a/src/lock.ts\n' +
      '+++ b/src/lock.ts\n' +
      '@@ -1,2 +1,2 @@\n' +
      `-${SECRET}\n` +
      `+${SECRET}\n` +
      ` ${SECRET}\n`;
    const result = await scan.scanDiff({
      patch,
      name: 'scan.json',
      base: null,
      head: SOURCE,
    });
    expect(result.report.denylistHits).toBe(2);
  });

  test('CRLF patch lines keep Python splitlines semantics', async () => {
    const patch =
      'diff --git a/src/lock.ts b/src/lock.ts\r\n' +
      '--- /dev/null\r\n' +
      '+++ b/src/lock.ts\r\n' +
      '@@ -0,0 +1,1 @@\r\n' +
      `+${SECRET}\r\n`;
    const result = await scan.scanDiff({
      patch,
      name: 'scan.json',
      base: null,
      head: SOURCE,
    });
    expect(result.report.denylistHits).toBe(1);
  });

  test('a lone CR does not hide instruction text from the scan', async () => {
    const patch = fixInstructionsScanPatch(`fix it\r${SECRET}`);
    const result = await scan.scanDiff({
      patch,
      name: 'scan.json',
      base: null,
      head: SOURCE,
    });
    expect(result.report.denylistHits).toBe(1);
    expect(result.clean).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe('repair scan adapter gitleaks classification', () => {
  const cleanPatch = fullSourceScanPatch('src/lock.ts', 'nothing\n');

  test('not-run stays clean and reports not-run', async () => {
    const scan = makeRepairScan({
      rules: [],
      gitleaksEffects: fakeGitleaks({}),
      gitleaksAvailable: () => false,
    });
    const result = await scan.scanDiff({
      patch: cleanPatch,
      name: 'scan.json',
      base: null,
      head: SOURCE,
    });
    expect(result.report.gitleaks).toBe('not-run');
    expect(result.clean).toBe(true);
  });

  test('a clean gitleaks run stays clean', async () => {
    const scan = makeRepairScan({
      rules: [],
      gitleaksEffects: fakeGitleaks({ exitCode: 0 }),
      gitleaksAvailable: () => true,
    });
    const result = await scan.scanDiff({
      patch: cleanPatch,
      name: 'scan.json',
      base: null,
      head: SOURCE,
    });
    expect(result.report.gitleaks).toBe('clean');
    expect(result.report.gitleaksHits).toBe(0);
    expect(result.clean).toBe(true);
  });

  test('exit 0 with mapped findings is hits, never clean', async () => {
    const scan = makeRepairScan({
      rules: [],
      gitleaksEffects: fakeGitleaks({
        exitCode: 0,
        report: [{ File: 'component-0.txt', StartLine: 1, RuleID: 'gitleaks-test' }],
      }),
      gitleaksAvailable: () => true,
    });
    const result = await scan.scanDiff({
      patch: cleanPatch,
      name: 'scan.json',
      base: null,
      head: SOURCE,
    });
    expect(result.report.gitleaks).toBe('hits');
    expect(result.report.gitleaksHits).toBe(1);
    expect(result.clean).toBe(false);
  });

  test('exit 0 with an unmappable report row is an error, not clean', async () => {
    const scan = makeRepairScan({
      rules: [],
      gitleaksEffects: fakeGitleaks({
        exitCode: 0,
        report: [{ File: 'elsewhere.txt', StartLine: 1, RuleID: 'gitleaks-test' }],
      }),
      gitleaksAvailable: () => true,
    });
    const result = await scan.scanDiff({
      patch: cleanPatch,
      name: 'scan.json',
      base: null,
      head: SOURCE,
    });
    expect(result.report.gitleaks).toBe('error');
    expect(result.report.gitleaksHits).toBe(0);
    expect(result.clean).toBe(false);
    expect(JSON.stringify(result)).not.toContain('elsewhere.txt');
    expect(JSON.stringify(result)).not.toContain('gitleaks-test');
  });

  test('gitleaks findings are dirty and redacted', async () => {
    const scan = makeRepairScan({
      rules: [],
      gitleaksEffects: fakeGitleaks({
        exitCode: 1,
        report: [{ File: 'component-0.txt', StartLine: 1, RuleID: 'gitleaks-test' }],
      }),
      gitleaksAvailable: () => true,
    });
    const result = await scan.scanDiff({
      patch: cleanPatch,
      name: 'scan.json',
      base: null,
      head: SOURCE,
    });
    expect(result.report.gitleaks).toBe('hits');
    expect(result.report.gitleaksHits).toBe(1);
    expect(result.clean).toBe(false);
    expect(JSON.stringify(result)).not.toContain('gitleaks-test');
  });

  test('a nonzero gitleaks run is an error, not clean', async () => {
    const scan = makeRepairScan({
      rules: [],
      gitleaksEffects: fakeGitleaks({ exitCode: 2 }),
      gitleaksAvailable: () => true,
    });
    const result = await scan.scanDiff({
      patch: cleanPatch,
      name: 'scan.json',
      base: null,
      head: SOURCE,
    });
    expect(result.report.gitleaks).toBe('error');
    expect(result.clean).toBe(false);
  });

  test('an unavailable probe is an error, not clean', async () => {
    const scan = makeRepairScan({
      rules: [],
      gitleaksEffects: fakeGitleaks({}),
      gitleaksAvailable: () => {
        throw new Error('which failed');
      },
    });
    const result = await scan.scanDiff({
      patch: cleanPatch,
      name: 'scan.json',
      base: null,
      head: SOURCE,
    });
    expect(result.report.gitleaks).toBe('error');
    expect(result.clean).toBe(false);
  });
});
