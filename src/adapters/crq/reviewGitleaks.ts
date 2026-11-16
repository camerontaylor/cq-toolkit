/** Inactive stdin gitleaks binding for general review scans. No matcher or route. */
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { killProcessTree } from './gitExec.js';
import type { ReviewScannerEffects } from '../../queue-runner/reviewScan.js';

const maxBytes = 16 * 1024 * 1024;

/** Explicit environment and scratch parent belong to the caller, never the ambient process. */
export function fileReviewGitleaks(options: {
  path: string;
  scratchRoot: string;
  timeoutMs?: number;
}): ReviewScannerEffects['gitleaks'] {
  return async (diff) => {
    const directories = options.path.split(delimiter).map((entry) => resolve(entry || '.'));
    let executable: string | null = null;
    for (const directory of directories) {
      const candidate = join(directory, 'gitleaks');
      try {
        if (!(await stat(candidate)).isFile()) continue;
        await access(candidate, constants.X_OK);
        executable = candidate;
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') continue;
        throw new Error('gitleaks discovery failed');
      }
    }
    if (executable === null) return { kind: 'not-run' };
    if (Buffer.byteLength(diff) > maxBytes) throw new Error('gitleaks input too large');
    const scratch = await mkdtemp(join(resolve(options.scratchRoot), 'crq-gitleaks-'));
    try {
      const report = join(scratch, 'report.json');
      const code = await runGitleaks(
        executable,
        directories.join(delimiter),
        scratch,
        report,
        diff,
        options.timeoutMs ?? 60_000,
      );
      if (code !== 0) return { kind: 'exit', code, hits: null };
      const handle = await open(
        report,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        if (!(await handle.stat()).isFile()) throw new Error('invalid gitleaks report');
        const buffer = Buffer.alloc(maxBytes + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
          const part = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
          if (part.bytesRead === 0) break;
          bytesRead += part.bytesRead;
        }
        if (bytesRead > maxBytes) throw new Error('gitleaks report too large');
        const parsed: unknown = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)) || '[]',
        );
        if (!Array.isArray(parsed)) throw new Error('invalid gitleaks report');
        const hits = (parsed as unknown[]).map((entry) => {
          if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
            throw new Error('invalid gitleaks report');
          const value = entry as Record<string, unknown>;
          const rule = value.RuleID ?? null;
          const diffLine = value.StartLine ?? null;
          if (
            (rule !== null && typeof rule !== 'string') ||
            (diffLine !== null &&
              (typeof diffLine !== 'number' || !Number.isSafeInteger(diffLine) || diffLine < 1))
          )
            throw new Error('invalid gitleaks report');
          return { rule, diffLine };
        });
        return { kind: 'exit', code, hits };
      } finally {
        await handle.close();
      }
    } catch {
      // Never surface subprocess output, matched content, or report parse text.
      throw new Error('gitleaks execution or report failed');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };
}

function runGitleaks(
  executable: string,
  path: string,
  cwd: string,
  report: string,
  diff: string,
  timeoutMs: number,
): Promise<number> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error('invalid gitleaks timeout');
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      executable,
      [
        'stdin',
        '--no-banner',
        '--redact',
        '--log-level',
        'error',
        '--report-format',
        'json',
        '--report-path',
        report,
        '--exit-code',
        '0',
      ],
      {
        cwd,
        env: { PATH: path },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      },
    );
    let output = 0;
    let failed = false;
    let inputFailed = false;
    const stop = () => {
      failed = true;
      killProcessTree(child);
    };
    const timer = setTimeout(stop, timeoutMs);
    const consume = (chunk: Buffer) => {
      output += chunk.length;
      if (output > maxBytes) stop();
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.stdin.on('error', () => {
      inputFailed = true;
    });
    child.on('error', () => {
      failed = true;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failed || code === null || (code === 0 && inputFailed))
        reject(new Error('gitleaks failed'));
      else resolveResult(code);
    });
    child.stdin.end(diff);
  });
}
