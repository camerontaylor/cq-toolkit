import { spawn } from 'node:child_process';
import { decideCompletion, parseReviewerStream } from '../../ops/dev/coderabbit.js';

async function invoke(
  args: string[],
  options: { cwd: string; binary?: string; timeoutMs?: number },
) {
  const child = spawn(options.binary ?? 'coderabbit', args, {
    cwd: options.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
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
    let timedOut = false;
    let spawnError: Error | undefined;
    let signalError: unknown;
    let closed = false;
    let escalated = false;
    let drainTimer: NodeJS.Timeout | undefined;
    let exitCode: number | null = null;
    const finish = () => {
      if (!closed || (timedOut && !escalated)) return;
      if (drainTimer) clearTimeout(drainTimer);
      if (timedOut) reject(new Error('CodeRabbit CLI timed out', { cause: signalError }));
      else if (spawnError) reject(spawnError);
      else resolve(exitCode);
    };
    const signal = (value: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid !== undefined)
          process.kill(-child.pid, value);
        else child.kill(value);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') signalError ??= error;
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signal('SIGTERM');
      setTimeout(() => {
        signal('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
        escalated = true;
        drainTimer = setTimeout(() => {
          child.unref();
          reject(new Error('CodeRabbit CLI timed out', { cause: signalError }));
        }, 250);
        finish();
      }, 1000);
    }, options.timeoutMs ?? 20_000);
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      closed = true;
      exitCode = code;
      finish();
    });
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
