#!/usr/bin/env node
// Packed-consumer smoke — #394 (P4, plans/upcoming-20261027): prove the
// PUBLISHED ARTIFACT, not the source tree. The script builds nothing and
// assumes `pnpm run build` and `pnpm pack --pack-destination <dir>` have
// already run (in CI, .github/workflows/pack-audit.yml drives it after the
// build; never a local full build). It then:
//
//   1. INSTALL — a fresh temp prefix gets the EXACT tarball file installed
//      via `npm install --prefix <prefix> <tarball>`: no registry, and no
//      source checkout anywhere on the resolution path (npm is the release
//      runbook's own install tool for the audited bytes; every spawned
//      child runs with cwd INSIDE the prefix).
//   2. SDK smoke — a Node child with cwd INSIDE the consumer prefix imports
//      the PUBLIC ROOT EXPORT by bare package specifier
//      (`import ... from '@camerontaylor/cq-toolkit'`) so npm's export
//      mapping is on the path: a broken exports field fails the leg even
//      when the dist files themselves are present.
//   3. `cq` bin smoke — the INSTALLED node_modules/.bin/cq MAPPING is
//      invoked (not dist/cli.js directly): empty argv is a usage error BY
//      CONTRACT (src/cli/main.ts: exit 2 + exactly one JSON artifact with
//      error.kind 'usage' on stdout). Asserting via the mapping proves the
//      package's bin registration works, not merely that a file exists.
//   4. `cq-harness-mcp` bin smoke — spawns the INSTALLED
//      node_modules/.bin/cq-harness-mcp mapping with a minimal harness
//      manifest over a temp workspace, performs ONE bounded initialize →
//      tools/list round trip over stdio, then closes stdin and asserts a
//      clean EOF exit 0 (the bin's documented EOF contract). The leg
//      deadline stays armed until the process CLOSES: a server that
//      responds but never exits is killed and fails the leg.
//   5. IDENTITY — the tarball's path, size and SHA-256, plus the installed
//      package's name/version/integrity and a required-artifact scan (the
//      exports main, both bin targets and the denylist patterns), recorded
//      in a JSON summary written to `--out` (default: stdout).
//
// Failure paths: any leg failure reports the leg name and the captured
// stdout/stderr tails and exits 1 — after the guaranteed temp cleanup. The
// temp consumer prefix is removed on success AND failure (best effort; a
// cleanup failure is reported, never masked as success).
//
// Usage:
//   node scripts/packed-smoke.mjs --tarball=<path.tgz> [--out=<path.json>]
//                                  [--timeout-ms=<per-leg ms>]
//
// Exit codes: 0 every leg passed; 1 any leg failed; 2 usage error (missing
// or unknown flag, missing tarball). No positional args (repo convention).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** CLI surface — named flags only. */
class UsageError extends Error {}

function parseArgs(argv) {
  /** @type {{tarball?: string, out?: string, timeoutMs: number}} */
  const out = { timeoutMs: 120_000 };
  for (const token of argv) {
    const match = /^--(tarball|out|timeout-ms)=(.+)$/.exec(token);
    if (match === null) throw new UsageError(`unrecognized argument: ${token}`);
    const [, flag, value] = match;
    if (flag === 'timeout-ms') {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new UsageError(`--timeout-ms must be a positive integer, got ${value}`);
      }
      out.timeoutMs = parsed;
    } else if (out[flag] !== undefined) {
      throw new UsageError(`--${flag} given twice`);
    } else {
      out[flag] = value;
    }
  }
  if (out.tarball === undefined) throw new UsageError('--tarball=<path.tgz> is required');
  if (!isAbsolute(out.tarball)) out.tarball = resolve(out.tarball);
  return /** @type {{tarball: string, out?: string, timeoutMs: number}} */ (out);
}

// ---------------------------------------------------------------------------
// Bounded child plumbing (every spawn has a hard deadline and capped output)
// ---------------------------------------------------------------------------

const OUTPUT_CAP = 8_000;

function capTail(sink, chunk) {
  const next = sink + chunk;
  return next.length > OUTPUT_CAP ? next.slice(-OUTPUT_CAP) : next;
}

/**
 * Spawn a child with piped stdio, a SIGKILL deadline and captured output
 * tails. Never throws: spawn errors come back as an exit-127 result.
 * @returns {Promise<{code: number|null, signal: string|null, timedOut: boolean, stdout: string, stderr: string}>}
 */
function runChild(command, args, { cwd, timeoutMs }) {
  return new Promise((resolveSpawn) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout = capTail(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = capTail(stderr, chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveSpawn({ code, signal, timedOut, stdout, stderr });
    };
    child.on('error', (err) => {
      stderr = capTail(stderr, String(err));
      finish(127, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
    child.stdin.on('error', () => {}); // EPIPE when the child exits early
    child.stdin.end();
  });
}

/** One named leg. Throws a leg-labelled error carrying output tails on failure. */
async function leg(name, run) {
  const result = await run();
  if (result.ok) return result.value;
  const detail = [
    `packed-smoke: leg '${name}' failed: ${result.reason}`,
    result.stdout === '' ? undefined : `stdout tail:\n${result.stdout}`,
    result.stderr === '' ? undefined : `stderr tail:\n${result.stderr}`,
  ]
    .filter(Boolean)
    .join('\n');
  throw new Error(detail);
}

const PKG_DIR = 'node_modules/@camerontaylor/cq-toolkit';

// ---------------------------------------------------------------------------
// Leg 1 — install the exact tarball into a fresh prefix
// ---------------------------------------------------------------------------

async function installTarball(prefix, tarball, timeoutMs) {
  return leg('install', async () => {
    const result = await runChild(
      'npm',
      ['install', '--prefix', prefix, tarball, '--no-audit', '--no-fund', '--loglevel=error'],
      { cwd: prefix, timeoutMs },
    );
    return result.code === 0
      ? { ok: true, value: undefined }
      : {
          ok: false,
          reason: `npm install exited ${result.code}${result.timedOut ? ' (timed out)' : ''}`,
          stdout: result.stdout,
          stderr: result.stderr,
        };
  });
}

// ---------------------------------------------------------------------------
// Leg 2 — SDK import resolves the installed package, outside the checkout
// ---------------------------------------------------------------------------

async function sdkSmoke(prefix, timeoutMs) {
  const probe = [
    // The bare specifier is the point: only the public exports mapping can
    // resolve it. The package identity is read as a plain FILE (the real
    // package's exports map does not expose ./package.json).
    `import { SEAM_VERSION, defaultHarnessConfig } from '@camerontaylor/cq-toolkit';`,
    `import { readFileSync } from 'node:fs';`,
    `import { createRequire } from 'node:module';`,
    `const pkgRoot = createRequire(import.meta.url).resolve('@camerontaylor/cq-toolkit');`,
    `const pkg = JSON.parse(readFileSync(pkgRoot.replace(/dist\\/index\\.js$/, 'package.json'), 'utf8'));`,
    `console.log(JSON.stringify({`,
    `  seamVersion: SEAM_VERSION,`,
    `  harnessConfigTools: Object.keys(defaultHarnessConfig.tools),`,
    `  promptBudgetKeys: Object.keys(defaultHarnessConfig.promptBudget),`,
    `  pkgName: pkg.name,`,
    `  pkgVersion: pkg.version,`,
    `  mainIsDistIndex: pkg.main === './dist/index.js',`,
    `}));`,
  ].join('\n');
  return leg('sdk-import', async () => {
    // The child's cwd is the consumer PREFIX and the import is a bare
    // package specifier: the PUBLIC exports mapping resolves the entry, so
    // a broken exports field fails here even when dist/index.js exists.
    const result = await runChild(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: prefix,
      timeoutMs,
    });
    if (result.code !== 0) {
      return { ok: false, reason: `SDK import child exited ${result.code}`, ...result };
    }
    const line = result.stdout.trim().split('\n').pop() ?? '';
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { ok: false, reason: 'SDK probe printed no single JSON object', ...result };
    }
    if (parsed.seamVersion === undefined || parsed.pkgName !== '@camerontaylor/cq-toolkit') {
      return { ok: false, reason: `SDK probe identity mismatch: ${line}`, ...result };
    }
    return { ok: true, value: parsed };
  });
}

// ---------------------------------------------------------------------------
// Leg 3 — `cq` bin: the usage contract from the tarball alone
// ---------------------------------------------------------------------------

async function cliSmoke(prefix, timeoutMs) {
  return leg('cli-bin', async () => {
    // The INSTALLED .bin mapping is the public interface npm registers; a
    // broken package.json bin field must fail here even when dist/cli.js
    // exists. The mapping is a symlink to a shebang'd JS file — execute it
    // directly so the shebang resolution is exercised too.
    const bin = join(prefix, 'node_modules', '.bin', 'cq');
    if (!existsSync(bin))
      return { ok: false, reason: `cq bin mapping missing from the install: ${bin}` };
    const result = await runChild(bin, ['--json'], { cwd: prefix, timeoutMs });
    if (result.code !== 2) {
      return {
        ok: false,
        reason: `cq --json with empty argv exited ${result.code}, expected the usage exit 2`,
        ...result,
      };
    }
    const line = result.stdout.trim();
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return {
        ok: false,
        reason: 'cq did not emit exactly one JSON artifact on stdout',
        ...result,
      };
    }
    if (parsed?.error?.kind !== 'usage') {
      return {
        ok: false,
        reason: `cq usage artifact has an unexpected shape: ${line.slice(0, 200)}`,
        ...result,
      };
    }
    return { ok: true, value: { exit: 2, errorKind: 'usage' } };
  });
}

// ---------------------------------------------------------------------------
// Leg 4 — `cq-harness-mcp` bin: one bounded initialize → tools/list → EOF 0
// ---------------------------------------------------------------------------

/**
 * The minimal manifest the MCP startup check accepts. Mirrors
 * src/harness/surface.ts HarnessManifestSchema with the SHIPPED default
 * harness config inlined (a consumer has no src/ to import defaults from;
 * these values are the package's own documented defaults).
 */
function smokeManifest(workspace) {
  return {
    v: 1,
    workspace,
    sandbox: 'none',
    tools: ['read', 'edit', 'bash'],
    harness: {
      tools: {
        read: { enabled: true, pathPatterns: ['**/*'], maxOutputChars: 200_000 },
        edit: { enabled: true, pathPatterns: ['**/*'], maxOutputChars: 4_000 },
        bash: { enabled: true, commandPatterns: [], timeoutMs: 30_000, maxOutputChars: 100_000 },
        write: { enabled: true, pathPatterns: ['**/*'], maxOutputChars: 4_000 },
      },
      promptBudget: {
        maxSystemPromptChars: 20_000,
        maxTools: 6,
        maxToolDescriptionChars: 1_024,
      },
    },
    envNames: [],
  };
}

async function mcpSmoke(prefix, timeoutMs) {
  // The INSTALLED .bin mapping again: a broken package.json bin field for
  // cq-harness-mcp must fail this leg even when the dist file exists.
  const bin = join(prefix, 'node_modules', '.bin', 'cq-harness-mcp');
  const workspace = mkdtempSync(join(realpathSync(tmpdir()), 'cq-packed-smoke-ws-'));
  try {
    return await leg('mcp-bin', async () => {
      if (!existsSync(bin))
        return { ok: false, reason: `cq-harness-mcp bin mapping missing from the install: ${bin}` };
      return mcpRoundTrip(bin, smokeManifest(workspace), timeoutMs);
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

/**
 * Drive the stdio JSON-RPC round trip with a whole-leg deadline that stays
 * armed until the process CLOSES — including the post-response EOF wait, so
 * a server that replies but never exits is SIGKILLed and fails the leg
 * instead of hanging forever. Resolves `{ok, ...}` exactly once.
 */
function mcpRoundTrip(bin, manifest, timeoutMs) {
  return new Promise((resolveLeg) => {
    const child = spawn(bin, [JSON.stringify(manifest)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let buffer = '';
    /** @type {string[]} */
    const lines = [];
    // State machine: collecting → validating (still armed) → done. The
    // deadline is cleared ONLY in done; every other terminal path — early
    // exit, bad surface, or the deadline itself firing — kills the child.
    let phase = 'collecting';
    let deadlineFired = false;
    const childErr = () => stderr.slice(-2_000);
    const timedOut = () => {
      deadlineFired = true;
      child.kill('SIGKILL');
    };
    const deadline = setTimeout(timedOut, timeoutMs);
    const finish = (result) => {
      if (phase === 'done') return;
      phase = 'done';
      clearTimeout(deadline);
      child.kill('SIGKILL');
      resolveLeg(result);
    };
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) =>
      finish({ ok: false, reason: `MCP bin spawn failed: ${err}`, stdout: '', stderr: childErr() }),
    );
    child.on('close', (code, signal) => {
      if (phase === 'validating') {
        // The EOF-exit check: a clean exit 0 on stdin EOF is the bin's
        // documented contract; anything else — including the deadline's
        // SIGKILL of a server that never exited — fails the leg.
        phase = 'done';
        clearTimeout(deadline);
        if (deadlineFired) {
          resolveLeg({
            ok: false,
            reason: `MCP bin did not exit within the ${timeoutMs}ms leg deadline after responding (hung past EOF)`,
            stdout: '',
            stderr: childErr(),
          });
        } else if (code === 0) {
          resolveLeg({ ok: true, value: validated });
        } else {
          resolveLeg({
            ok: false,
            reason: `MCP bin exited ${code} on stdin EOF, expected 0`,
            stdout: '',
            stderr: childErr(),
          });
        }
        return;
      }
      if (phase === 'collecting') {
        if (deadlineFired) {
          // The deadline fired before the responses arrived: report the
          // timeout as such, not as an unrelated early process exit.
          resolveLeg({
            ok: false,
            reason: `MCP bin did not serve initialize/tools/list within the ${timeoutMs}ms leg deadline (collecting-phase timeout)`,
            stdout: '',
            stderr: childErr(),
          });
          return;
        }
        finish({
          ok: false,
          reason: `MCP bin exited early (code ${code}, signal ${signal}) before the round trip completed`,
          stdout: '',
          stderr: childErr(),
        });
      }
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (phase !== 'collecting') return;
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        lines.push(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
      if (lines.length >= 2) validate();
    });
    child.stdin.on('error', () => {}); // EPIPE after an early exit

    let validated;

    function validate() {
      // Deadline stays ARMED through validation and the EOF wait.
      phase = 'validating';
      let init;
      let list;
      try {
        init = JSON.parse(lines[0]);
        list = JSON.parse(lines[1]);
      } catch {
        finish({
          ok: false,
          reason: 'MCP bin emitted a non-JSON line',
          stdout: lines.join('\n'),
          stderr: childErr(),
        });
        return;
      }
      const serverName = init?.result?.serverInfo?.name;
      const toolNames = (list?.result?.tools ?? []).map((tool) => tool.name);
      if (serverName !== 'cq-harness') {
        finish({
          ok: false,
          reason: `serverInfo.name is '${serverName}', expected 'cq-harness'`,
          stdout: lines.join('\n'),
          stderr: childErr(),
        });
        return;
      }
      if (toolNames.length === 0) {
        finish({
          ok: false,
          reason: 'tools/list returned an empty tool set',
          stdout: lines.join('\n'),
          stderr: childErr(),
        });
        return;
      }
      validated = { serverName, tools: toolNames };
      // Responses are valid: close stdin and wait for the process to exit
      // under the still-armed deadline.
      child.stdin.end();
    }

    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } })}\n`,
    );
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Leg 5 — tarball identity + required-artifact scan over the installed tree
// ---------------------------------------------------------------------------

function scanArtifacts(tarball, prefix) {
  const bytes = readFileSync(tarball);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const pkgRoot = join(prefix, PKG_DIR);
  const installedPkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  const required = [
    'dist/index.js',
    'dist/cli.js',
    'dist/harness/mcp/bin.js',
    'policy/denylist/patterns.yml',
  ].filter((rel) => !existsSync(join(pkgRoot, rel)));
  return {
    tarball: { path: tarball, name: basename(tarball), bytes: bytes.length, sha256 },
    installed: {
      name: installedPkg.name,
      version: installedPkg.version,
      integrity: installedPkg._integrity ?? null,
    },
    requiredArtifactsMissing: required,
  };
}

// ---------------------------------------------------------------------------

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`packed-smoke: ${err.message}\n`);
    return 2;
  }
  if (!existsSync(args.tarball)) {
    process.stderr.write(`packed-smoke: tarball not found: ${args.tarball}\n`);
    return 2;
  }
  const prefix = mkdtempSync(join(realpathSync(tmpdir()), 'cq-packed-consumer-'));
  try {
    await installTarball(prefix, args.tarball, args.timeoutMs);
    const sdk = await sdkSmoke(prefix, args.timeoutMs);
    const cli = await cliSmoke(prefix, args.timeoutMs);
    const mcp = await mcpSmoke(prefix, args.timeoutMs);
    const artifacts = scanArtifacts(args.tarball, prefix);
    if (artifacts.requiredArtifactsMissing.length > 0) {
      throw new Error(
        `packed-smoke: tarball is missing required artifacts: ${artifacts.requiredArtifactsMissing.join(', ')}`,
      );
    }
    const summary = {
      ok: true,
      tarball: artifacts.tarball,
      installed: { ...artifacts.installed, name: sdk.pkgName, version: sdk.pkgVersion },
      sdk,
      cli,
      mcp,
    };
    const rendered = `${JSON.stringify(summary, null, 2)}\n`;
    if (args.out === undefined) {
      process.stdout.write(rendered);
    } else {
      writeFileSync(args.out, rendered);
      process.stdout.write(`packed-smoke: ok — summary written to ${args.out}\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.stderr.write('packed-smoke: FAILED — the packed artifact is not consumer-viable\n');
    return 1;
  } finally {
    try {
      rmSync(prefix, { recursive: true, force: true });
    } catch (err) {
      process.stderr.write(`packed-smoke: warning — temp prefix cleanup failed: ${err}\n`);
    }
  }
}

// Entry guard: running as a script executes the smoke; importing the module
// (the mocked test suite) binds main without running it. In ESM the entry
// script's argv[1] is its own path.
const MODULE_PATH = fileURLToPath(import.meta.url);
const entry = process.argv[1] === undefined ? undefined : realpathSync(process.argv[1]);
if (entry === MODULE_PATH) {
  process.exitCode = await main(process.argv.slice(2));
}
