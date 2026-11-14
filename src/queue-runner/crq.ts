#!/usr/bin/env node
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { runRepairPrepare } from '../adapters/crq/repairPreparation.js';
import { runStatusWriter } from '../adapters/crq/statusWriter.js';
import { MAX_REQUEST_BYTES, runQueueCapabilityMain } from '../adapters/crq/queueCapabilityMain.js';
import { run } from './runner.js';
import { planTick } from './tick.js';
import { runWatchdog } from './watchdog.js';

/** Read at most one wire frame plus the byte that proves it is over-long. */
async function readFrame(): Promise<Uint8Array> {
  const limit = MAX_REQUEST_BYTES + 1;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = chunk as Buffer;
    const take = Math.min(buffer.length, limit - size);
    chunks.push(buffer.subarray(0, take));
    size += take;
    if (size >= limit) break;
  }
  return Buffer.concat(chunks, size);
}

const root = process.cwd();
const [command, ...rest] = process.argv.slice(2);
if (command === 'queue-capability') {
  // The forced-command route: policy and identity come from the environment,
  // the request frame from stdin, and nothing else is accepted.
  process.exitCode = await runQueueCapabilityMain({
    argv: rest,
    env: (name) => process.env[name],
    readStdin: readFrame,
    stdout: (bytes) => {
      process.stdout.write(bytes);
    },
    stderr: (message) => {
      process.stderr.write(`${message}\n`);
    },
    // The deadline must end the process, not just the race: a pending stdin
    // read or a held queue lock would otherwise outlive the refusal.
    terminate: () => process.exit(2),
    root,
  });
} else {
  const stateHome = process.env.XDG_STATE_HOME;
  const gitleaksPath = process.env.PATH;

  /** The XDG state roots the status command writes/reads under. */
  function statusRoots(stateRoot: string): {
    runnerRoot: string;
    stateRoot: string;
    xdgStateHome: string;
    home: string;
  } {
    const home = homedir();
    return {
      runnerRoot: root,
      stateRoot,
      xdgStateHome: stateHome ?? '',
      home,
    };
  }

  const result = await run(process.argv.slice(2), {
    shadowRoot: root,
    tick: randomUUID(),
    planner: (planCommand, args) => planTick(root, planCommand, args),
    // Operator-only: explicit roots, no cwd/env default, never a unit command.
    operatorLive: async (liveCommand, args) => {
      if (liveCommand === 'repair-prepare') return runRepairPrepare(args, { gitleaksPath });
      if (liveCommand === 'status') {
        const parsed = parseStatusArgv(args);
        if (!parsed.ok) return usageArtifact('status', parsed.message);
        // The queue-runner binary's stdout is exactly one JSON document for
        // every command; the operator-readable markdown travels in the
        // artifact's `value` field, not the stdout channel.
        let statusMarkdown = '';
        const exitCode = await runStatusWriter(statusRoots(parsed.stateRoot), {
          write: (text) => {
            statusMarkdown = text;
          },
          error: (text) => process.stderr.write(text),
        });
        return {
          artifact:
            exitCode === 0
              ? { status: 'ok' as const, value: { markdown: statusMarkdown } }
              : { status: 'failed' as const, error: 'status write failed' },
          exitCode,
        };
      }
      return Promise.resolve({
        artifact: { status: 'failed' as const, error: `${liveCommand} is not implemented` },
        exitCode: 1,
      });
    },
    live: (liveCommand) => {
      if (liveCommand === 'watchdog') {
        return runWatchdog(stateHome === undefined ? {} : { stateHome });
      }
      return Promise.resolve({ status: 'failed', error: `${liveCommand} is not implemented` });
    },
  });
  process.stdout.write(`${JSON.stringify(result.artifact)}\n`);
  process.exitCode = result.exitCode;
}

/** `crq status [--state-root <dir>]` argv; the runner root is the cwd. */
function parseStatusArgv(
  args: readonly string[],
):
  | { readonly ok: true; readonly stateRoot: string }
  | { readonly ok: false; readonly message: string } {
  let stateRoot = join(root, 'state');
  let index = 0;
  while (index < args.length) {
    const flag = args[index];
    if (flag !== '--state-root') return { ok: false, message: `unknown flag: ${flag ?? ''}` };
    const value = args[index + 1];
    if (value === undefined) return { ok: false, message: 'missing value for --state-root' };
    stateRoot = value;
    index += 2;
  }
  return { ok: true, stateRoot };
}

function usageArtifact(subcommand: string, message: string) {
  return {
    artifact: { error: { kind: 'usage', subcommand, message, exitCode: 2 } },
    exitCode: 2,
  };
}
