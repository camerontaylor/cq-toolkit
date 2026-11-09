import { spawn } from 'node:child_process';
import { decideCompletion, parseReviewerStream } from '../../ops/dev/coderabbit.js';

async function invoke(
  args: string[],
  options: { cwd: string; binary?: string; timeoutMs?: number },
) {
  const child = spawn(options.binary ?? 'coderabbit', args, {
    cwd: options.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { stdout, stderr, exitCode };
}

export function usage(options: { cwd: string; binary?: string; timeoutMs?: number }) {
  return invoke(['usage', '--agent'], options);
}

/** Run the caller's review flags without shell interpretation and classify the full stream. */
export async function review(
  flags: readonly string[],
  options: { cwd: string; binary?: string; timeoutMs?: number },
) {
  const raw = await invoke(['review', ...flags], {
    ...options,
    timeoutMs: options.timeoutMs ?? 120 * 60_000,
  });
  const stream = parseReviewerStream(raw.stdout);
  const verdict = decideCompletion(raw.exitCode ?? -1, stream);
  const reason =
    verdict.kind === 'blocked' &&
    (verdict.reason.includes('no review ran') ||
      verdict.reason.includes('fresh detailed review never ran'))
      ? 'skipped:no-fresh'
      : undefined;
  return { ...raw, stream, verdict, reason };
}
