import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Packed-consumer smoke orchestration (#394, P4) — MOCKED/fixture tests only.
// The REAL build → pack → install → smoke runs in CI
// (.github/workflows/pack-audit.yml); these tests never build, never pack
// from the real tree, and never touch the network. They drive the actual
// script (scripts/packed-smoke.mjs) as a child process against FIXTURE
// tarballs and a fake `npm` on PATH, asserting the orchestration contracts:
//   - usage errors exit 2;
//   - a failing `npm install` fails the run with the leg named;
//   - the temp consumer prefix is cleaned up on success AND failure;
//   - the happy path (a stub installed package with stub dist files) passes
//     all legs: the SDK identity probe, the `cq` usage-artifact contract, a
//     REAL bounded MCP initialize → tools/list → EOF-0 stdio round trip
//     against a stub bin, and the artifact/tarball identity summary;
//   - broken artifacts (a missing required file, a refusing MCP bin, a cq
//     bin that violates the usage contract) FAIL the run.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'scripts', 'packed-smoke.mjs');
const TMPDIR = realpathSync(tmpdir());

const roots: string[] = [];
function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(TMPDIR, 'cq-packed-smoke-test-')));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run the smoke script with an optional fake-`npm` dir prepended to PATH. */
function runSmoke(
  args: string[],
  options: { fakeBinDir?: string; timeoutMs?: number } = {},
): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (options.fakeBinDir !== undefined) env.PATH = `${options.fakeBinDir}:${env.PATH ?? ''}`;
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 60_000,
    env,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Install a fake `npm` whose behavior is defined by a JS module (written to
 * disk, run by the real node): the module receives the prefix and tarball
 * as argv and may populate the prefix or exit nonzero.
 */
function installFakeNpm(
  binDir: string,
  behavior:
    | 'fail'
    | 'populate'
    | 'populate-strip-patterns'
    | 'populate-broken-cli'
    | 'populate-refusing-mcp',
): string {
  mkdirSync(binDir, { recursive: true });
  const helper = join(binDir, 'fake-npm-behavior.cjs');
  const stubs = stubDistSources();
  const behaviors: Record<string, string> = {
    fail: 'process.exitCode = 3;',
    populate: `populate(prefix, ${stubs});`,
    'populate-strip-patterns': `populate(prefix, ${stubs}); require('node:fs').rmSync(require('node:path').join(prefix, 'node_modules/@camerontaylor/cq-toolkit/policy/denylist/patterns.yml'));`,
    'populate-broken-cli': `populate(prefix, ${stubs}); require('node:fs').writeFileSync(require('node:path').join(prefix, 'node_modules/@camerontaylor/cq-toolkit/dist/cli.js'), "console.log('hello from a broken cli'); process.exit(0);\\n");`,
    'populate-refusing-mcp': `populate(prefix, ${stubs}); require('node:fs').writeFileSync(require('node:path').join(prefix, 'node_modules/@camerontaylor/cq-toolkit/dist/harness/mcp/bin.js'), "process.stderr.write('cq-harness-mcp: refusing to start — fixture\\\\n'); process.exit(78);\\n");`,
  };
  writeFileSync(
    helper,
    [
      `'use strict';`,
      `const fs = require('node:fs');`,
      `const path = require('node:path');`,
      `const [prefix, tarball] = process.argv.slice(2);`,
      `function populate(prefix, stubs) {`,
      `  const pkg = path.join(prefix, 'node_modules/@camerontaylor/cq-toolkit');`,
      `  fs.mkdirSync(path.join(pkg, 'dist/harness/mcp'), { recursive: true });`,
      `  fs.mkdirSync(path.join(pkg, 'policy/denylist'), { recursive: true });`,
      `  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({`,
      `    name: '@camerontaylor/cq-toolkit', version: '9.9.9-fixture',`,
      `    main: './dist/index.js', _integrity: 'sha512-fixture' }));`,
      `  for (const [rel, source] of Object.entries(stubs)) {`,
      `    fs.mkdirSync(path.dirname(path.join(pkg, rel)), { recursive: true });`,
      `    fs.writeFileSync(path.join(pkg, rel), source);`,
      `  }`,
      `  fs.writeFileSync(path.join(pkg, 'policy/denylist/patterns.yml'), 'patterns: []\\n');`,
      `}`,
      behaviors[behavior],
    ].join('\n'),
  );
  const npm = join(binDir, 'npm');
  writeFileSync(
    npm,
    [
      '#!/bin/sh',
      '# The smoke always calls: npm install --prefix <prefix> <tarball> ...',
      'prefix=""',
      'prefix_next=0',
      'for arg in "$@"; do',
      '  case "$arg" in',
      '    --prefix) prefix_next=1 ;;',
      '    --prefix=*) prefix="${arg#--prefix=}" ;;',
      '    *) if [ "$prefix_next" = 1 ]; then prefix="$arg"; prefix_next=0; fi ;;',
      '  esac',
      'done',
      `exec node "${helper}" "$prefix" "$1"`,
    ].join('\n'),
  );
  chmodSync(npm, 0o755);
  return binDir;
}

/**
 * The stub dist sources a populated fake install carries. They deliberately
 * encode fixture-only identity values (SEAM_VERSION 'fixture-seam') so the
 * happy-path test proves the SDK leg resolved the INSTALLED package, never
 * this checkout's real dist.
 */
function stubDistSources(): string {
  const sdkStub = [
    `export const SEAM_VERSION = 'fixture-seam';`,
    `export const defaultHarnessConfig = { tools: { read: {}, edit: {} }, promptBudget: { maxTools: 6 } };`,
    ``,
  ].join('\n');
  const cliStub = `if (process.argv.slice(2).includes('--json')) { console.log(JSON.stringify({ error: { kind: 'usage' } })); } process.exit(2);\n`;
  const mcpLines = [
    `{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"cq-harness","version":"9.9.9-fixture"}}}`,
    `{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"read"},{"name":"edit"},{"name":"bash"}]}}`,
  ];
  // The stub MCP bin reads its requests, then serves the two canned replies
  // in order, then exits 0 on EOF — enough surface for the round trip.
  const mcpStub = [
    `const lines = require('node:fs').readFileSync(0, 'utf8').split('\\n').filter(Boolean);`,
    `for (const line of lines) JSON.parse(line);`,
    `for (const line of ${JSON.stringify(mcpLines)}) process.stdout.write(line + '\\n');`,
    `process.exit(0);`,
    ``,
  ].join('\n');
  return JSON.stringify({
    'dist/index.js': sdkStub,
    'dist/cli.js': cliStub,
    'dist/harness/mcp/bin.js': mcpStub,
  });
}

/** A fixture tarball (a real gzipped tar with a package/ root). */
function makeTarball(dir: string): string {
  const stage = join(dir, 'stage', 'package');
  mkdirSync(stage, { recursive: true });
  writeFileSync(
    join(stage, 'package.json'),
    JSON.stringify({ name: '@camerontaylor/cq-toolkit', version: '9.9.9-fixture' }),
  );
  const tarball = join(dir, 'fixture.tgz');
  const packed = spawnSync('tar', ['-czf', tarball, '-C', join(dir, 'stage'), 'package']);
  expect(packed.status).toBe(0);
  return tarball;
}

/** Every temp prefix the run created must be gone: cleanup on success AND failure. */
function expectNoLeftoverPrefixes(): void {
  const leftovers = readdirSync(TMPDIR).filter((name) => name.startsWith('cq-packed-consumer-'));
  expect(leftovers).toEqual([]);
}

describe('packed-smoke usage surface', () => {
  it('exits 2 on a missing flag, an unknown flag, a duplicate flag, a bad timeout, and a nonexistent tarball', () => {
    const tarball = makeTarball(scratch());
    for (const args of [
      [],
      [`--tarball=${tarball}`, '--bogus=1'],
      [`--tarball=${tarball}`, '--out=/tmp/a', '--out=/tmp/b'],
      [`--tarball=${tarball}`, '--timeout-ms=0'],
      [`--tarball=${tarball}`, '--timeout-ms=nope'],
      ['--tarball=/nonexistent/fixture.tgz'],
    ]) {
      const result = runSmoke(args);
      expect(result.status, `args: ${args.join(' ')}`).toBe(2);
      expect(result.stderr).toContain('packed-smoke:');
    }
  });

  it('rejects positional arguments (named flags only)', () => {
    const tarball = makeTarball(scratch());
    const result = runSmoke([tarball]);
    expect(result.status).toBe(2);
  });
});

describe('packed-smoke failure paths', () => {
  it('fails with the install leg named when npm install exits nonzero, and cleans up the prefix', () => {
    const dir = scratch();
    const tarball = makeTarball(dir);
    const fake = installFakeNpm(join(dir, 'fake-bin'), 'fail');
    const result = runSmoke([`--tarball=${tarball}`, '--timeout-ms=20000'], { fakeBinDir: fake });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("leg 'install' failed");
    expect(result.stderr).toContain('exited 3');
    expectNoLeftoverPrefixes();
  });

  it('fails when the installed tree is missing a required artifact, and names it', () => {
    const dir = scratch();
    const tarball = makeTarball(dir);
    const fake = installFakeNpm(join(dir, 'fake-bin'), 'populate-strip-patterns');
    const result = runSmoke([`--tarball=${tarball}`, '--timeout-ms=20000'], { fakeBinDir: fake });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('required artifacts');
    expect(result.stderr).toContain('policy/denylist/patterns.yml');
    expectNoLeftoverPrefixes();
  });

  it('fails with the mcp leg named when the installed MCP bin refuses startup (exit 78)', () => {
    const dir = scratch();
    const tarball = makeTarball(dir);
    const fake = installFakeNpm(join(dir, 'fake-bin'), 'populate-refusing-mcp');
    const result = runSmoke([`--tarball=${tarball}`, '--timeout-ms=20000'], { fakeBinDir: fake });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("leg 'mcp-bin' failed");
    expect(result.stderr).toContain('exited early');
    expectNoLeftoverPrefixes();
  });

  it('fails with the cli leg named when the installed cq bin violates the usage contract', () => {
    const dir = scratch();
    const tarball = makeTarball(dir);
    const fake = installFakeNpm(join(dir, 'fake-bin'), 'populate-broken-cli');
    const result = runSmoke([`--tarball=${tarball}`, '--timeout-ms=20000'], { fakeBinDir: fake });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("leg 'cli-bin' failed");
    expectNoLeftoverPrefixes();
  });
});

describe('packed-smoke happy path over stubs', () => {
  it('passes all legs against a stub-installed package and writes the summary with tarball identity', () => {
    const dir = scratch();
    const tarball = makeTarball(dir);
    const fake = installFakeNpm(join(dir, 'fake-bin'), 'populate');
    const out = join(dir, 'summary.json');
    const result = runSmoke([`--tarball=${tarball}`, `--out=${out}`, '--timeout-ms=20000'], {
      fakeBinDir: fake,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(out)).toBe(true);
    const summary = JSON.parse(readFileSync(out, 'utf8')) as {
      ok: boolean;
      tarball: { sha256: string; bytes: number; name: string };
      installed: { name: string; version: string; integrity: string | null };
      sdk: { seamVersion: string; harnessConfigTools: string[] };
      cli: { exit: number; errorKind: string };
      mcp: { serverName: string; tools: string[] };
      requiredArtifactsMissing?: string[];
    };
    expect(summary.ok).toBe(true);
    expect(summary.tarball.name).toBe('fixture.tgz');
    expect(summary.tarball.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.tarball.bytes).toBeGreaterThan(0);
    expect(summary.installed).toEqual({
      name: '@camerontaylor/cq-toolkit',
      version: '9.9.9-fixture',
      integrity: 'sha512-fixture',
    });
    // SDK leg: the fixture-only seam value proves the import resolved the
    // INSTALLED package's dist, never this checkout's real dist.
    expect(summary.sdk.seamVersion).toBe('fixture-seam');
    expect(summary.sdk.harnessConfigTools).toContain('read');
    // cq leg: the stub bin honored the usage contract.
    expect(summary.cli).toEqual({ exit: 2, errorKind: 'usage' });
    // MCP leg: a real stdio round trip happened against the stub bin.
    expect(summary.mcp.serverName).toBe('cq-harness');
    expect(summary.mcp.tools).toEqual(['read', 'edit', 'bash']);
    expect(summary.requiredArtifactsMissing ?? []).toEqual([]);
    expectNoLeftoverPrefixes();
  });

  it('prints the summary to stdout when --out is omitted', () => {
    const dir = scratch();
    const tarball = makeTarball(dir);
    const fake = installFakeNpm(join(dir, 'fake-bin'), 'populate');
    const result = runSmoke([`--tarball=${tarball}`, '--timeout-ms=20000'], { fakeBinDir: fake });
    expect(result.status, result.stderr).toBe(0);
    // The summary is a pretty-printed multi-line document; find its start.
    const start = result.stdout.indexOf('{\n  "ok"');
    const summary = JSON.parse(result.stdout.slice(start)) as { ok: boolean };
    expect(summary.ok).toBe(true);
  });
});
