// Fake agent CLI — the stream-json fixture for the subprocess driver's tests
// (T1.5 slice 2) and the T1.7 smoke lane, as a REAL process. Dependency-
// free, node: builtins only, run as `node test/fixtures/fake-agent-cli.mjs`.
//
// Every scripted behaviour lives in ./fake-agent-persona.mjs (documented
// there), shared with the in-process host so the two cannot drift. This
// file is only the process host: argv/env, the prompt drain, the exit code
// (never exit() — stdio flushes before the reaper), real `run` commands,
// and the OS-level halves (SIGTERM ignored, self-SIGKILL, a sleeping
// grandchild in this process group, keep-alive).
import { exec, spawn } from 'node:child_process';
import process from 'node:process';
import { createAgentPersona } from './fake-agent-persona.mjs';

const persona = createAgentPersona({
  argv: process.argv.slice(2),
  env: process.env,
  pid: process.pid,
  cwd: process.cwd(),
  io: {
    write: (text) => process.stdout.write(text),
    writeErr: (text) => process.stderr.write(text),
    setExitCode: (code) => {
      process.exitCode = code;
    },
    runCommand: (command, cwd, done) => exec(command, { cwd }, done),
    killSelf: (signal) => process.kill(process.pid, signal),
    spawnGrandchild: () => {
      const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
        stdio: 'ignore', // SAME process group (not detached) — that is the point
      });
      grandchild.unref();
      return grandchild.pid;
    },
    keepAlive: () => setInterval(() => {}, 60_000),
  },
});

// Consume the prompt (stdin to EOF) without gating the event stream on it.
process.stdin.resume();
if (persona.ignoresSigterm) {
  process.on('SIGTERM', () => {
    // deliberately ignored — the driver must escalate to SIGKILL
  });
}
void persona.run();
