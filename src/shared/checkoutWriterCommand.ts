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
    const out: Buffer[] = [],
      err: Buffer[] = [];
    let outBytes = 0,
      errBytes = 0,
      fault: unknown,
      killed = false,
      settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      opts.signal?.removeEventListener('abort', abort);
      child.stdout?.removeListener('data', stdoutData);
      child.stderr?.removeListener('data', stderrData);
      const stdout = Buffer.concat(out).toString('utf8'),
        stderr = Buffer.concat(err).toString('utf8');
      out.length = err.length = 0;
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
    };
    child.on('error', (error) => {
      fault ??= error;
    });
    trackCheckoutWriter(child);
    child.stdin?.end();
    const kill = () => {
      if (settled) return;
      killed = true;
      child.kill('SIGKILL');
      settle(null, 'SIGKILL');
      // Caller cancellation stops capture, not ownership. Destroying these raw
      // pipes would let Node emit close while a descendant still holds stdout/
      // stderr. Flow to discard until EOF (which closes the streams normally);
      // only the existing actual-close tracker supplies the drain proof.
      child.stdout?.resume();
      child.stderr?.resume();
    };
    const abort = () => {
      fault = Object.assign(new Error('The operation was aborted'), { code: 'ABORT_ERR' });
      kill();
    };
    const collect = (chunks: Buffer[], bytes: Buffer, total: number) => {
      const room = (opts.maxBuffer ?? 1024 * 1024) - total;
      if (room > 0) chunks.push(bytes.subarray(0, room));
      if (room < bytes.length) {
        fault ??= Object.assign(new Error('stdout/stderr maxBuffer length exceeded'), {
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        });
        kill();
      }
    };
    const stdoutData = (bytes: Buffer) => {
      collect(out, bytes, outBytes);
      outBytes += bytes.length;
    };
    const stderrData = (bytes: Buffer) => {
      collect(err, bytes, errBytes);
      errBytes += bytes.length;
    };
    child.stdout?.on('data', stdoutData);
    child.stderr?.on('data', stderrData);
    child.once('close', settle);
    timer = opts.timeout ? setTimeout(kill, opts.timeout) : undefined;
    opts.signal?.addEventListener('abort', abort, { once: true });
    if (opts.signal?.aborted) abort();
  });
}
