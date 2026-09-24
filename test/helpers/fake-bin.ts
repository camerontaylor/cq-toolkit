import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Configuration for a process-backed fake used by command-contract tests. */
export interface FakeBinOptions {
  /** stdout written after argv is recorded. */
  stdout?: string;
  /** stderr written after argv is recorded. */
  stderr?: string;
  /** exit code returned after output is written. */
  exitCode?: number;
  /** environment variable supplying the exit code (defaults to exitCode). */
  exitCodeEnv?: string;
  /** JSONL call log; defaults to `<root>/<name>.calls.jsonl`. */
  logFile?: string;
}

/** Installed fake binary and its argv recorder. */
export interface FakeBin {
  /** Absolute executable path, suitable for an environment variable. */
  path: string;
  /** Absolute JSONL log path. */
  logFile: string;
  /** Parsed argv arrays, oldest call first. */
  calls(): string[][];
}

/**
 * Install a tiny Node executable that records argv and returns canned output.
 * The helper is intentionally about OUR wire contract: external-tool
 * semantics remain in the real-binary tests that use the production tool.
 */
export function installFakeBin(root: string, name: string, options: FakeBinOptions = {}): FakeBin {
  const path = join(root, 'node_modules', name, 'bin', name);
  const logFile = options.logFile ?? join(root, `${name}.calls.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `import { appendFileSync, writeFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(${JSON.stringify(options.stdout ?? '')});
process.stderr.write(${JSON.stringify(options.stderr ?? '')});
process.exitCode = ${
      options.exitCodeEnv === undefined
        ? String(options.exitCode ?? 0)
        : `Number(process.env[${JSON.stringify(options.exitCodeEnv)}] ?? ${options.exitCode ?? 0})`
    };
`,
  );
  chmodSync(path, 0o755);
  return {
    path,
    logFile,
    calls: () => {
      const raw = readFileSync(logFile, 'utf8').trim();
      return raw === '' ? [] : raw.split('\n').map((line) => JSON.parse(line) as string[]);
    },
  };
}
