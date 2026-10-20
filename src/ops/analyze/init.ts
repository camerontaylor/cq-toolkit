// Analyze lane — `analyze.init` (Lane C, S1): write a starter `cq.json` for
// a project directory by DETECTING which supported checks apply, so the
// first `analyze.run` has something real to execute.
//
// Detection is by files present, nothing else (no network, no package
// install, no tool execution):
//   - `tsconfig.json`            → a `tsc-lines` check:
//                                  `tsc --noEmit --pretty false`;
//   - an ESLint config           → an `eslint-json` check:
//     (eslint.config.{js,mjs,cjs,ts,mts,cts}, .eslintrc{,.js,.cjs,.json,.yml,.yaml},
//      or an `eslintConfig` key in package.json)
//                                  `eslint --format json .`.
// The command is the project's own `node_modules/.bin/<tool>` when that file
// exists, else the bare tool name (resolved on PATH at run time).
//
// Refusals are `failed`, never silent: an existing `cq.json` is not
// overwritten unless `force: true`; a directory where nothing is detected
// gets no file (an empty check list would make `analyze.run` vacuous).
import { existsSync, lstatSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Op } from '../../kernel/types.js';
import { messageOf } from '../../shared/messageOf.js';
import type { CheckRunnerInput } from '../gates/checkRunner.js';
import type { CqConfig } from './cqConfig.js';
import { CQ_CONFIG_FILE, CQ_CONFIG_SCHEMA_VERSION } from './cqConfig.js';

/** JSON-serializable input of the `analyze.init` op. */
export interface AnalyzeInitInput {
  /** The project directory to write `cq.json` into (must exist). */
  dir: string;
  /** Overwrite an existing `cq.json`. Default false (refuse). */
  force?: boolean;
}

/** The op's value: what was written, and why each check was chosen. */
export interface AnalyzeInitReport {
  /** The written config's path. */
  configPath: string;
  /** The written config, verbatim. */
  config: CqConfig;
  /** One line per check: which file triggered it. */
  detected: string[];
  /** True when an existing `cq.json` was replaced (`force: true`). */
  overwritten: boolean;
}

/** ESLint flat and legacy config file names, in detection order. */
const ESLINT_CONFIG_FILES = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
];

/** The project-local binary when present, else the bare name (PATH lookup at run time). */
function toolCommand(dir: string, tool: string): string {
  const local = join('node_modules', '.bin', tool);
  return existsSync(join(dir, local)) ? local : tool;
}

/** The ESLint trigger: a config file name, `package.json#eslintConfig`, or undefined. */
function eslintTrigger(dir: string): string | undefined {
  const file = ESLINT_CONFIG_FILES.find((name) => existsSync(join(dir, name)));
  if (file !== undefined) return file;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as unknown;
    if (typeof pkg === 'object' && pkg !== null && 'eslintConfig' in pkg) {
      return 'package.json#eslintConfig';
    }
  } catch {
    // No (readable, valid) package.json: no ESLint trigger from it.
  }
  return undefined;
}

/** Detect the supported checks for `dir` (pure over the file system's current state). */
export function detectChecks(dir: string): { checks: CheckRunnerInput[]; detected: string[] } {
  const checks: CheckRunnerInput[] = [];
  const detected: string[] = [];
  if (existsSync(join(dir, 'tsconfig.json'))) {
    checks.push({
      adapter: 'tsc-lines',
      command: {
        command: toolCommand(dir, 'tsc'),
        args: ['--noEmit', '--pretty', 'false'],
        cwd: '.',
      },
    });
    detected.push('tsc-lines: tsconfig.json');
  }
  const eslint = eslintTrigger(dir);
  if (eslint !== undefined) {
    checks.push({
      adapter: 'eslint-json',
      command: { command: toolCommand(dir, 'eslint'), args: ['--format', 'json', '.'], cwd: '.' },
    });
    detected.push(`eslint-json: ${eslint}`);
  }
  return { checks, detected };
}

/** Build the `analyze.init` op (file-system backed; no injected seams needed). */
export function makeAnalyzeInit(): Op<AnalyzeInitInput, AnalyzeInitReport> {
  return async (input) => {
    let isDir = false;
    try {
      isDir = statSync(input.dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      return { status: 'failed', error: `analyze.init: directory does not exist: '${input.dir}'` };
    }
    const configPath = resolve(input.dir, CQ_CONFIG_FILE);
    let existing: ReturnType<typeof lstatSync> | undefined;
    try {
      existing = lstatSync(configPath);
    } catch {
      existing = undefined;
    }
    if (existing !== undefined && input.force !== true) {
      return {
        status: 'failed',
        error: `analyze.init: '${configPath}' already exists — refusing to overwrite it; edit it by hand, or pass force: true (--force) to replace it`,
      };
    }
    if (existing?.isSymbolicLink() === true) {
      return {
        status: 'failed',
        error: `analyze.init: '${configPath}' is a symlink — refusing to write through it`,
      };
    }
    const { checks, detected } = detectChecks(input.dir);
    if (checks.length === 0) {
      return {
        status: 'failed',
        error: `analyze.init: no supported check detected in '${input.dir}' (looked for tsconfig.json and an ESLint config) — write ${CQ_CONFIG_FILE} by hand: { "schemaVersion": 1, "checks": [ { "adapter": "tsc-lines" | "eslint-json" | "vitest-json", "command": { "command": "...", "args": [...], "cwd": "." } } ] }`,
      };
    }
    const config: CqConfig = { schemaVersion: CQ_CONFIG_SCHEMA_VERSION, checks };
    try {
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
        encoding: 'utf8',
        flag: input.force === true ? 'w' : 'wx',
      });
    } catch (err) {
      return {
        status: 'failed',
        error: `analyze.init: could not write '${configPath}' — ${messageOf(err)}`,
      };
    }
    return {
      status: 'ok',
      value: { configPath, config, detected, overwritten: existing !== undefined },
    };
  };
}

/** The registry importer's `.default` resolution: the file-system-backed op. */
const analyzeInit: Op<AnalyzeInitInput, AnalyzeInitReport> = makeAnalyzeInit();
export default analyzeInit;
