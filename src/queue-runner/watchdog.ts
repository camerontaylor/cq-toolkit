import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { constants, homedir } from 'node:os';
import { join } from 'node:path';
import type { OpResult } from '../kernel/types.js';

export interface WatchdogSendResult {
  code: number;
  stderr: string;
}

export type WatchdogSend = (args: string[], timeoutMs: number) => WatchdogSendResult;

export interface WatchdogOptions {
  /** Base of the shared XDG state tree. Defaults to ~/.local/state. */
  stateHome?: string;
  /** Deterministic clock in milliseconds since the epoch. */
  clock?: () => number;
  /** Injected alert sender. Defaults to `paseo send --no-wait ...`. */
  send?: WatchdogSend;
}

export interface WatchdogValue {
  message: string;
  lastTick: string;
  gapMinutes: number;
  limitMinutes: number;
  alert: 'none' | 'already' | 'sent' | 'failed';
  state: Record<string, unknown> | null;
}

const LAST_TICK_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Python's round(): nearest integer, ties to even. */
function pythonRound(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Python json.dumps() default string escaping (ensure_ascii=True). */
function ensureAscii(value: string): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('cannot encode a string');
  return encoded.replace(/[\u007f-\uffff]/g, (character) => {
    const code = character.charCodeAt(0);
    return `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

/** Python json.dumps() default separators, key order and ASCII escaping. */
function pythonJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return ensureAscii(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error('cannot encode a non-finite number');
      return String(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'undefined':
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new Error('cannot encode a value');
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(pythonJson).join(', ')}]`;
      return `{${Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => `${ensureAscii(key)}: ${pythonJson(item)}`)
        .join(', ')}}`;
    }
    default:
      throw new Error('cannot encode a value');
  }
}

function utcTimestamp(milliseconds: number): string {
  return new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function parseLastTick(value: string): number {
  const match = LAST_TICK_RE.exec(value);
  if (match === null) throw new Error('heartbeat last_tick must be a UTC timestamp');
  const year = Number(match[1] ?? '');
  const month = Number(match[2] ?? '');
  const day = Number(match[3] ?? '');
  const hour = Number(match[4] ?? '');
  const minute = Number(match[5] ?? '');
  const second = Number(match[6] ?? '');
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    throw new Error('heartbeat last_tick is invalid');
  }
  return date.getTime();
}

function defaultStateHome(): string {
  return join(homedir(), '.local', 'state');
}

async function readState(path: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isRecord(value)) throw new Error('watchdog state must be an object');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

function spawnSend(args: string[], timeoutMs: number): WatchdogSendResult {
  try {
    const result = spawnSync('paseo', args, { encoding: 'utf8', timeout: timeoutMs });
    if (result.error) return { code: 99, stderr: String(result.error) };
    const signal = result.signal
      ? (constants.signals as Record<string, number>)[result.signal]
      : undefined;
    return {
      code: result.status ?? (signal === undefined ? 99 : -signal),
      stderr: result.stderr ?? '',
    };
  } catch (error) {
    return { code: 99, stderr: String(error) };
  }
}

function ok(value: WatchdogValue): OpResult<WatchdogValue> {
  return { status: 'ok', value };
}

/**
 * Model-free heartbeat watchdog, parity port of ops/crq-watchdog.py.
 *
 * A non-zero alert send is still a successful watchdog run: it records
 * `failed_attempt_for` and retries on the next timer run. Malformed or missing
 * input, a missing alert recipient, or an unwritable state file return a typed
 * `failed` result and exit 1; the Python script raises and exits 1 in those
 * cases. The CLI rejects arguments for this unit command as a usage error; the
 * unit never supplies any.
 */
export async function runWatchdog(options: WatchdogOptions = {}): Promise<OpResult<WatchdogValue>> {
  try {
    const directory = join(options.stateHome ?? defaultStateHome(), 'crq');
    const heartbeatPath = join(directory, 'heartbeat.json');
    const statePath = join(directory, 'watchdog-state.json');
    const heartbeat: unknown = JSON.parse(await readFile(heartbeatPath, 'utf8'));
    if (!isRecord(heartbeat)) throw new Error('heartbeat must be an object');
    const lastTickText = heartbeat.last_tick;
    if (typeof lastTickText !== 'string') {
      throw new Error('heartbeat last_tick must be a UTC timestamp');
    }
    const lastTick = parseLastTick(lastTickText);
    const limit = heartbeat.stale_alarm_min === undefined ? 36 : heartbeat.stale_alarm_min;
    if (typeof limit !== 'number' || !Number.isFinite(limit)) {
      throw new Error('heartbeat stale_alarm_min must be a number');
    }
    const clock = options.clock ?? Date.now;
    const gap = (clock() - lastTick) / 60000;
    const rounded = pythonRound(gap);
    const state = await readState(statePath);
    const clockStamp = () => utcTimestamp(clock());

    if (gap <= limit) {
      if (state.alerted_for) {
        const recovered: Record<string, unknown> = {
          recovered_seen_at: clockStamp(),
          last_outage: state.alerted_for,
        };
        await writeFile(statePath, `${pythonJson(recovered)}\n`);
        return ok({
          message: `${clockStamp()} ok: last tick ${lastTickText} (${rounded}m ago)`,
          lastTick: lastTickText,
          gapMinutes: rounded,
          limitMinutes: limit,
          alert: 'none',
          state: recovered,
        });
      }
      return ok({
        message: `${clockStamp()} ok: last tick ${lastTickText} (${rounded}m ago)`,
        lastTick: lastTickText,
        gapMinutes: rounded,
        limitMinutes: limit,
        alert: 'none',
        state: null,
      });
    }

    if (state.alerted_for === lastTickText) {
      return ok({
        message: `${clockStamp()} stale ${rounded}m; already alerted`,
        lastTick: lastTickText,
        gapMinutes: rounded,
        limitMinutes: limit,
        alert: 'already',
        state: null,
      });
    }

    const agentId = heartbeat.alert_agent_id;
    if (typeof agentId !== 'string' || agentId === '') {
      throw new Error('heartbeat alert_agent_id must be a nonempty string');
    }
    const host = heartbeat.alert_agent_host;
    if (host !== undefined && host !== null && typeof host !== 'string') {
      throw new Error('heartbeat alert_agent_host must be a string');
    }
    const text =
      `crq STALLED: no completed tick for ${rounded}m (last ${lastTickText}, ` +
      `alarm at ${limit}m). systemd crq-tick.timer. Inspect heartbeat and ` +
      `systemctl --user status crq-tick.timer; do not run tests or model probes.`;
    const argv = ['send', '--no-wait', ...(host ? ['--host', host] : []), agentId, text];
    const sent = (options.send ?? spawnSend)(argv, 90_000);
    const attemptedAt = clockStamp();
    const key = sent.code === 0 ? 'alerted_for' : 'failed_attempt_for';
    const next: Record<string, unknown> = {
      [key]: lastTickText,
      attempted_at: attemptedAt,
      gap_min: rounded,
      paseo_send: sent.code,
      paseo_err: sent.stderr.trim().slice(0, 200),
    };
    await writeFile(statePath, `${pythonJson(next)}\n`);
    return ok({
      message:
        `${clockStamp()} ${sent.code === 0 ? 'ALERTED' : 'ALERT FAILED'} stale ${rounded}m ` +
        `(paseo send exit ${sent.code})`,
      lastTick: lastTickText,
      gapMinutes: rounded,
      limitMinutes: limit,
      alert: sent.code === 0 ? 'sent' : 'failed',
      state: next,
    });
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
