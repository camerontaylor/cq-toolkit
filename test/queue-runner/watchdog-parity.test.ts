import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../../dist/queue-runner/crq.js', import.meta.url));
const PYTHON = fileURLToPath(new URL('../../apps/crq-python/ops/crq-watchdog.py', import.meta.url));

interface Prepared {
  home: string;
  bin: string;
}

interface Outcome {
  status: number | null;
  stdout: string;
  stderr: string;
  state: string | null;
  args: string[];
}

function prepare(heartbeat: Record<string, unknown>, state?: string): Prepared {
  const base = mkdtempSync(join(tmpdir(), 'crq-watchdog-parity-'));
  const home = join(base, 'home');
  const bin = join(base, 'bin');
  mkdirSync(join(home, 'crq'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(home, 'crq', 'heartbeat.json'), `${JSON.stringify(heartbeat)}\n`);
  if (state !== undefined) writeFileSync(join(home, 'crq', 'watchdog-state.json'), state);
  const paseo = join(bin, 'paseo');
  writeFileSync(
    paseo,
    [
      '#!/bin/sh',
      'printf \'%s\\n\' "$@" > "$PASEO_ARGS"',
      'if [ -n "$PASEO_STDERR" ]; then printf \'%s\\n\' "$PASEO_STDERR" >&2; fi',
      'exit "${PASEO_EXIT:-0}"',
      '',
    ].join('\n'),
  );
  chmodSync(paseo, 0o755);
  return { home, bin };
}

function execute(
  command: string,
  args: string[],
  prepared: Prepared,
  exitCode: number,
  stderr: string,
): Outcome {
  const result = spawnSync(command, args, {
    cwd: prepared.home,
    encoding: 'utf8',
    env: {
      ...process.env,
      XDG_STATE_HOME: prepared.home,
      PATH: `${prepared.bin}${delimiter}${process.env.PATH ?? ''}`,
      PASEO_ARGS: join(prepared.home, 'paseo-args.txt'),
      PASEO_EXIT: String(exitCode),
      ...(stderr ? { PASEO_STDERR: stderr } : {}),
    },
  });
  const statePath = join(prepared.home, 'crq', 'watchdog-state.json');
  const argsPath = join(prepared.home, 'paseo-args.txt');
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    state: existsSync(statePath) ? readFileSync(statePath, 'utf8') : null,
    args: existsSync(argsPath)
      ? readFileSync(argsPath, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
      : [],
  };
}

function runBoth(
  heartbeat: Record<string, unknown>,
  state: string | undefined,
  exitCode: number,
  stderr: string,
): { python: Outcome; node: Outcome } {
  const python = prepare(heartbeat, state);
  const node = prepare(heartbeat, state);
  return {
    python: execute('python3', [PYTHON], python, exitCode, stderr),
    node: execute(process.execPath, [CLI, 'watchdog'], node, exitCode, stderr),
  };
}

function utcMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function normalizeMessage(text: string): string {
  return text.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z /, '<timestamp> ');
}

function normalizeState(text: string | null): string | null {
  if (text === null) return null;
  return text.replace(/"(attempted_at|recovered_seen_at)": "[^"]+"/g, '"$1": "<timestamp>"');
}

function nodeMessage(outcome: Outcome): string {
  const artifact = JSON.parse(outcome.stdout) as {
    status: string;
    value?: { message?: string };
    error?: string;
  };
  if (artifact.status !== 'ok' || typeof artifact.value?.message !== 'string') {
    throw new Error(`node watchdog did not return a message: ${outcome.stdout}`);
  }
  return artifact.value.message;
}

describe('watchdog parity with ops/crq-watchdog.py', () => {
  it('matches a sent stale alert, argv and state bytes', () => {
    const lastTick = utcMinutesAgo(120);
    const { python, node } = runBoth(
      { last_tick: lastTick, alert_agent_id: 'agent-1' },
      undefined,
      0,
      '',
    );
    expect(python.status).toBe(0);
    expect(node.status).toBe(0);
    expect(python.args).toEqual(node.args);
    expect(normalizeMessage(python.stdout.trim())).toBe(normalizeMessage(nodeMessage(node)));
    expect(normalizeState(python.state)).toBe(normalizeState(node.state));
    expect(python.state ?? '').toContain('"alerted_for"');
  });

  it('matches a failed send and keeps the retry state', () => {
    const lastTick = utcMinutesAgo(120);
    const { python, node } = runBoth(
      { last_tick: lastTick, alert_agent_id: 'agent-1' },
      undefined,
      9,
      'boom',
    );
    expect(python.status).toBe(0);
    expect(node.status).toBe(0);
    expect(python.args).toEqual(node.args);
    expect(normalizeMessage(python.stdout.trim())).toContain('ALERT FAILED');
    expect(normalizeMessage(python.stdout.trim())).toBe(normalizeMessage(nodeMessage(node)));
    expect(normalizeState(python.state)).toBe(normalizeState(node.state));
    expect(python.state ?? '').toContain('"failed_attempt_for"');
  });

  it('matches recovery after a prior alert', () => {
    const lastTick = utcMinutesAgo(1);
    const { python, node } = runBoth(
      { last_tick: lastTick },
      '{"alerted_for": "2020-01-01T00:00:00Z"}\n',
      0,
      '',
    );
    expect(python.status).toBe(0);
    expect(node.status).toBe(0);
    expect(python.args).toEqual([]);
    expect(node.args).toEqual([]);
    expect(normalizeMessage(python.stdout.trim())).toBe(normalizeMessage(nodeMessage(node)));
    expect(normalizeState(python.state)).toBe(normalizeState(node.state));
    expect(python.state ?? '').toContain('"recovered_seen_at"');
  });

  it('matches a fresh heartbeat with no state', () => {
    const lastTick = utcMinutesAgo(1);
    const { python, node } = runBoth({ last_tick: lastTick }, undefined, 0, '');
    expect(python.status).toBe(0);
    expect(node.status).toBe(0);
    expect(python.args).toEqual([]);
    expect(node.args).toEqual([]);
    expect(python.state).toBeNull();
    expect(node.state).toBeNull();
    expect(normalizeMessage(python.stdout.trim())).toBe(normalizeMessage(nodeMessage(node)));
  });
});
