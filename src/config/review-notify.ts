import { isIP } from 'node:net';
import { hostname } from 'node:os';
import { readCqEnv } from './env.js';

/** Capture the caller destination once; the runner validates UUID and host allowlist. */
export function reviewNotifyDestination(
  env: Readonly<Record<string, string | undefined>> = process.env,
  getHostname: () => string = hostname,
) {
  const agent = env['PASEO_AGENT_ID'];
  if (!agent) return undefined;
  const host = readCqEnv(env).values['CQ_REVIEW_NOTIFY_HOST'];
  if (typeof host === 'string') return { paseo_agent_id: agent, paseo_host: host };
  let derived: string | null = null;
  try {
    const name = getHostname().toLowerCase();
    const short = isIP(name) === 0 ? (name.split('.')[0] ?? '') : '';
    if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(short)) derived = `${short}:6767`;
  } catch {
    // An unavailable hostname leaves notification admission to the runner.
  }
  return { paseo_agent_id: agent, paseo_host: derived };
}
