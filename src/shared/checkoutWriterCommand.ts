import { spawn } from 'node:child_process';
import { checkoutWriterStdio, trackCheckoutWriter } from './checkoutWriterContext.js';

/** execFile-compatible bounded collection with explicit review descriptor inheritance. */
export function checkoutWriterCommand(
  command: string,
  args: readonly string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    maxBuffer?: number;
    timeout?: number;
    signal?: AbortSignal;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(
        Object.assign(new Error('The operation was aborted'), {
          code: 'ABORT_ERR',
          killed: false,
          stdout: '',
          stderr: '',
        }),
      );
      return;
    }
    const child = spawn(command, [...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: checkoutWriterStdio(['pipe', 'pipe', 'pipe']),
    });
    trackCheckoutWriter(child);
    child.stdin!.end();
    const out: Buffer[] = [],
      err: Buffer[] = [];
    let outBytes = 0,
      errBytes = 0,
      fault: unknown,
      killed = false;
    const kill = () => {
      killed = true;
      child.kill('SIGKILL');
    };
    const abort = () => {
      fault = Object.assign(new Error('The operation was aborted'), { code: 'ABORT_ERR' });
      kill();
    };
    const collect = (chunks: Buffer[], bytes: Buffer, total: number) => {
      const room = (opts.maxBuffer ?? 1024 * 1024) - total;
      if (room < bytes.length) {
        fault ??= Object.assign(new Error('stdout/stderr maxBuffer length exceeded'), {
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        });
        kill();
      }
      if (room > 0) chunks.push(bytes.subarray(0, room));
    };
    child.stdout!.on('data', (bytes: Buffer) => {
      collect(out, bytes, outBytes);
      outBytes += bytes.length;
    });
    child.stderr!.on('data', (bytes: Buffer) => {
      collect(err, bytes, errBytes);
      errBytes += bytes.length;
    });
    child.on('error', (error) => {
      fault ??= error;
    });
    const timer = opts.timeout ? setTimeout(kill, opts.timeout) : undefined;
    opts.signal?.addEventListener('abort', abort, { once: true });
    if (opts.signal?.aborted) abort();
    child.once('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
      const stdout = Buffer.concat(out).toString('utf8'),
        stderr = Buffer.concat(err).toString('utf8');
      if (fault || code !== 0)
        reject(
          Object.assign(fault instanceof Error ? fault : new Error(`Command failed: ${command}`), {
            ...(fault ? {} : { code: code ?? undefined }),
            killed,
            signal,
            stdout,
            stderr,
          }),
        );
      else resolve({ stdout, stderr });
    });
  });
}
