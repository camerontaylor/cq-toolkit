// Fake ACP server — the wire fixture for the acp driver's tests (T1.8), as a
// REAL process. Dependency-free, node: builtins only, run as
// `node test/fixtures/fake-acp-server.mjs` (the driver spawns it with
// cwd = the invocation's workspace; there IS no argv — the protocol is
// newline-delimited JSON-RPC 2.0 over stdio).
//
// Every wire behaviour and FAKE_ACP_* persona lives in
// ./fake-acp-persona.mjs (documented there), shared with the in-process
// host so the two cannot drift. This file is only the process host: stdio
// framing, exit on stdin EOF, real `run` commands, and the OS-level
// persona halves (SIGTERM ignored, fd 0 closed, stdin reads paused).
import { exec } from 'node:child_process';
import { closeSync } from 'node:fs';
import process from 'node:process';
import { createAcpPersona } from './fake-acp-persona.mjs';

const persona = createAcpPersona({
  env: process.env,
  pid: process.pid,
  cwd: process.cwd(),
  io: {
    write: (text) => process.stdout.write(text),
    writeErr: (text) => process.stderr.write(text),
    exit: (code) => process.exit(code),
    runCommand: (command, cwd, done) => exec(command, { cwd }, done),
    // destroy() alone does NOT close fd 0 (Node never closes stdin's fd —
    // the parent's writes would still succeed), so the REAL close happens
    // after the stream's 'close' event releases libuv's handle:
    // closeSync(0). `then` runs only AFTER that, so the driver's next write
    // deterministically EPIPEs while this process stays alive (the 'end'
    // exit handler never fires — destroy is not EOF).
    closeInput: (then) => {
      process.stdin.once('close', () => {
        try {
          closeSync(0);
        } catch {
          // already gone — nothing left to simulate
        }
        then();
      });
      process.stdin.destroy();
    },
    pauseInput: () => process.stdin.pause(),
  },
});

if (persona.ignoresSigterm) process.on('SIGTERM', () => undefined);
// A ref'd (default) interval: the paused-reads persona would otherwise let
// the loop run empty and exit before the SIGTERM that answers it.
if (persona.needsKeepAlive) setInterval(() => undefined, 1_000);

// ---------------------------------------------------------------------------
// stdin line loop
// ---------------------------------------------------------------------------

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl = buffer.indexOf('\n');
  while (nl !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    nl = buffer.indexOf('\n'); // advance BEFORE any `continue` — a skipped line must not spin the loop
    if (line === '') continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      process.stderr.write(`fake-acp-server: unparseable inbound line: ${line.slice(0, 200)}\n`);
      continue;
    }
    persona.onFrame(frame);
  }
});
process.stdin.on('end', () => {
  process.exit(0); // the driver closed our stdin (or died) — exit cleanly
});
