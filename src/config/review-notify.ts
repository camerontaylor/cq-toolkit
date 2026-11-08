import { readCqEnv } from './env.js';

/** Capture the caller destination once; the runner validates UUID and host allowlist. */
export function reviewNotifyDestination(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const agent = env['PASEO_AGENT_ID'];
  if (!agent) return undefined;
  const host = readCqEnv(env).values['CQ_REVIEW_NOTIFY_HOST'];
  return { paseo_agent_id: agent, paseo_host: typeof host === 'string' ? host : null };
}
