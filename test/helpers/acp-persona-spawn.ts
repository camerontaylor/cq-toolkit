// The in-process ACP persona host (plan 003 F2): the REAL fake-ACP-server
// persona (test/fixtures/fake-acp-persona.mjs — the same protocol code the
// real fixture process runs) driven over the fakeAcpSpawn transport, with
// no child process. Driver-specific tests about OUR folding/verdict/
// permission/replay/usage logic run here; OS-level contracts (real stdio,
// signals, pipes, sidecars) keep the real fixture process.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AcpSpawnFn } from '../../src/driver/acp/process.js';
import { createAcpPersona } from '../fixtures/fake-acp-persona.mjs';
import { fakeAcpSpawn } from './transport-fakes.js';
import type { JsonLinePeer, JsonLineScript } from './transport-fakes.js';

/** Per-spawn persona pids: session and tool-call ids stay unique per spawn, as with real pids. */
let nextPersonaPid = 70_000;

/**
 * The `run` tool, in-process: exactly the `echo <text> > <file>` shape the
 * driver-specific tests direct, with the shell's observable result (the
 * file, exit 0, empty stdout). Anything else is refused loudly — a test
 * that needs a real shell belongs with the real-process contracts.
 */
function runEchoRedirect(
  command: string,
  cwd: string,
  done: (err: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => void,
): void {
  const match = /^echo\s+(\S+)\s+>\s+(\S+)$/.exec(command);
  if (match === null) {
    done(new Error(`in-process persona cannot run '${command}' (no shell)`), '', '');
    return;
  }
  writeFile(resolve(cwd, match[2] as string), `${match[1] as string}\n`, 'utf8').then(
    () => done(null, '', ''),
    (error: unknown) => done(error as Error, '', ''),
  );
}

/** An OS-only persona half: loud, because the in-process host cannot model it. */
function processOnly(what: string): never {
  throw new Error(`the ${what} persona needs the real fixture process`);
}

/**
 * The persona spawn seam: each spawn is a fresh persona over the driver's
 * child env (plus `extraEnv`, the FAKE_ACP_* knobs) in the invocation's
 * workspace.
 */
export function acpPersonaSpawn(extraEnv: Record<string, string> = {}): AcpSpawnFn {
  return fakeAcpSpawn((opts) => {
    // The persona writes only in response to inbound frames, so the peer is
    // bound before the first write.
    let peer: JsonLinePeer | undefined;
    const persona = createAcpPersona({
      env: { ...opts.env, ...extraEnv },
      pid: nextPersonaPid++,
      cwd: opts.cwd,
      io: {
        write: (text) => peer?.write(text),
        writeErr: (text) => peer?.stderr(text.replace(/\n$/, '')),
        exit: (code) => peer?.finish(code),
        runCommand: runEchoRedirect,
        closeInput: () => processOnly('closed-stdin'),
        pauseInput: () => processOnly('paused-stdin'),
      },
    });
    const script: JsonLineScript = (frame, bound) => {
      peer = bound;
      persona.onFrame(frame);
    };
    if (persona.ignoresSigterm) script.ignoresSignal = (signal) => signal === 'SIGTERM';
    return script;
  });
}
