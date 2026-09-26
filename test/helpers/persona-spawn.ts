// The in-process persona hosts (plan 003 F2): the fixtures' REAL personas
// (test/fixtures/fake-acp-persona.mjs and fake-agent-persona.mjs — the
// same code the real fixture processes run) driven over the transport
// fakes, with no child process. Driver-specific tests about OUR folding/
// verdict/permission/replay/usage logic run here; OS-level contracts (real
// stdio, signals, pipes, process groups, sidecars) keep the real fixtures.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AcpSpawnFn } from '../../src/driver/acp/process.js';
import type { SpawnFn } from '../../src/driver/subprocess/index.js';
import { createAcpPersona } from '../fixtures/fake-acp-persona.mjs';
import { createAgentPersona } from '../fixtures/fake-agent-persona.mjs';
import { fakeAcpSpawn, fakeManagedSpawn } from './transport-fakes.js';
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

/**
 * The fake agent CLI persona seam: each spawn runs a fresh persona over the
 * driver's argv and child env (plus `extraEnv`) in the invocation's
 * workspace. The script starts on the prompt (the transport's stdin frame);
 * when it ends the fake child exits with the persona's exit code, unless
 * the persona asked to stay alive (then only a kill ends it).
 */
export function agentPersonaSpawn(extraEnv: Record<string, string> = {}): SpawnFn {
  return fakeManagedSpawn((opts) => {
    let peer: JsonLinePeer | undefined;
    let exitCode = 0;
    let stayAlive = false;
    const persona = createAgentPersona({
      argv: opts.args,
      env: { ...opts.env, ...extraEnv },
      pid: nextPersonaPid++,
      cwd: opts.cwd,
      io: {
        write: (text) => peer?.write(text),
        writeErr: (text) => peer?.stderr(text.replace(/\n$/, '')),
        setExitCode: (code) => {
          exitCode = code;
        },
        runCommand: runEchoRedirect,
        killSelf: (signal) => peer?.finish(null, signal),
        spawnGrandchild: () => processOnly('grandchild'),
        keepAlive: () => {
          stayAlive = true;
        },
      },
    });
    let started = false;
    const script: JsonLineScript = (frame, bound) => {
      peer = bound;
      if (started || frame['method'] !== 'stdin') return;
      started = true;
      persona.run().then(
        () => {
          if (!stayAlive) bound.finish(exitCode);
        },
        (error: unknown) => {
          bound.stderr(`fake agent persona error: ${String(error)}`);
          bound.finish(1);
        },
      );
    };
    if (persona.ignoresSigterm) script.ignoresSignal = (signal) => signal === 'SIGTERM';
    return script;
  });
}
