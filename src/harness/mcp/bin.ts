#!/usr/bin/env node
// bin — `cq-harness-mcp '<manifest JSON>'` (W1.4, ADR-0002 Annex A.3).
//
// Toolkit dispatch NEVER resolves this bin through PATH, npx or plan data:
// the subprocess lane launches `process.execPath` with the module-relative
// absolute path of this file (./launch.ts). The published bin name exists
// for operators and third-party MCP hosts only, e.g.
//   echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | cq-harness-mcp '<manifest>'
//
// STARTUP CHECKS, before any JSON-RPC message is read — the server refuses
// rather than serve a wrong surface:
//   1. exactly one argument, parsed strictly as a harness manifest;
//   2. realpath(workspace) === workspace, and it is a directory (the driver
//      passed a realpath, so any difference is a swapped symlink);
//   3. the core surface builds and equals `manifest.tools`;
//   4. chdir(workspace);
//   5. ENV SCRUB: process.env is replaced by the shipped default child-env
//      allowlist plus `manifest.envNames` — route auth vars the CLI carried
//      are dropped, so `run` children never inherit provider credentials in
//      their environment. (A same-uid process can still read an ancestor's
//      environment; closing that is OS confinement — T1.8 — not claimed.)
// Any failure writes ONE line to stderr and exits 78 (EX_CONFIG) before
// `initialize`; the driver's init-surface assertion turns that into a
// harness error. A run never continues without its harness.
//
// EXIT: 0 on stdin EOF; 65 (EX_DATAERR) on a protocol break (oversized
// line); 143/130 on SIGTERM/SIGINT. Every path aborts in-flight calls first,
// which kills their `run` process groups.
import { serveStdio } from './server.js';
import { checkStartup, EXIT_CONFIG, EXIT_PROTOCOL, oneLine, scrubEnvironment } from './startup.js';

/** Exit after stdout drains (async pipes must flush their last response). */
function exitAfterFlush(code: number): void {
  process.stdout.write('', () => process.exit(code));
}

function main(argv: readonly string[]): void {
  const startup = checkStartup(argv);
  if (!startup.ok) {
    process.stderr.write(`cq-harness-mcp: refusing to start — ${startup.reason}\n`);
    process.exit(EXIT_CONFIG);
  }
  try {
    process.chdir(startup.manifest.workspace);
    scrubEnvironment(startup.manifest.envNames);
  } catch (err) {
    process.stderr.write(`cq-harness-mcp: refusing to start — ${oneLine(err)}\n`);
    process.exit(EXIT_CONFIG);
  }
  const server = serveStdio(startup.surface, process.stdin, process.stdout, {
    log: (line) => process.stderr.write(`${line}\n`),
  });
  const onSignal = (code: number) => (): void => {
    server.shutdown(); // aborts in-flight calls → their process groups are killed
    exitAfterFlush(code);
  };
  process.once('SIGTERM', onSignal(143));
  process.once('SIGINT', onSignal(130));
  server.done.then(
    (end) => {
      if (end === 'oversized-line') exitAfterFlush(EXIT_PROTOCOL);
      else if (end === 'eof') exitAfterFlush(0);
    },
    () => exitAfterFlush(EXIT_PROTOCOL), // `done` never rejects; fail loudly if it ever does
  );
}

main(process.argv.slice(2));
