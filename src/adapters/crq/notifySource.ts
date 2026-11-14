/**
 * Production bindings for the publisher's notification drain.
 *
 * Python's `crq.notify` delivers by argv only — `paseo send --no-wait
 * [--host <host>] <agent> <text>` — with a 30 s deadline when a host is named
 * and 90 s otherwise, and records `paseo_send` as `0` on success or a
 * `<code>: <stderr[:150]>` string on any other exit. A spawn failure or timeout
 * is recorded as an `error: ...` string. Nothing is retried here: the outbox
 * row's attempt count and backoff own retries, and a non-zero send is never a
 * thrown drain.
 *
 * The destination and message come from the pure policy module; this adapter
 * owns argv construction, the process call and the runner's `config.json`
 * document (`notify.hosts`, `error_backoff_min`).
 */
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonObject, parseJsonValue, type JsonValue } from '../../policy/crq/jsonValue.js';

/** Python's `crq.notify` result: `paseo_send` is 0 or a diagnostic string. */
export interface NotifySendResult {
  readonly paseo_send?: number | string;
}

/** The drain's argv-only delivery transport. */
export type NotifyTransport = (destination: JsonObject, text: string) => Promise<NotifySendResult>;

/** Python's fixed deadlines: 30 s with a named host, 90 s otherwise. */
const HOST_TIMEOUT_MS = 30_000;
const LOCAL_TIMEOUT_MS = 90_000;

/** Python's `stderr.strip()[:150]`. */
function diagnostic(text: string): string {
  return [...text.trim()].slice(0, 150).join('');
}

/**
 * `crq.notify` over argv: the agent id and text are positional arguments, so
 * a destination can never inject shell syntax.
 */
export function spawnNotifySend(destination: JsonObject, text: string): Promise<NotifySendResult> {
  const agent = destination.get('paseo_agent_id');
  if (typeof agent !== 'string' || agent === '') return Promise.resolve({});
  const host = destination.get('paseo_host');
  const hasHost = typeof host === 'string' && host !== '';
  const argv = ['send', '--no-wait', ...(hasHost ? ['--host', host as string] : []), agent, text];
  const result = spawnSync('paseo', argv, {
    encoding: 'utf8',
    timeout: hasHost ? HOST_TIMEOUT_MS : LOCAL_TIMEOUT_MS,
  });
  if (result.error) {
    return Promise.resolve({ paseo_send: `error: ${diagnostic(String(result.error))}` });
  }
  const code = result.status ?? 1;
  const stderr = result.stderr ?? '';
  return Promise.resolve({
    paseo_send: code === 0 ? 0 : `${code}: ${diagnostic(stderr)}`,
  });
}

/**
 * The runner's `config.json` as Python's `crq.CONFIG` (plain `json.loads`;
 * duplicate keys keep the last value). A missing or malformed file is an empty
 * object, so the drain refuses every destination instead of crashing the unit.
 */
export async function readNotifyConfig(runnerRoot: string): Promise<JsonValue> {
  try {
    return parseJsonValue(await readFile(join(runnerRoot, 'config.json'), 'utf8'), {
      duplicates: 'last',
    });
  } catch {
    return new JsonObject([]);
  }
}
