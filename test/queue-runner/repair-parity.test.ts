/**
 * Differential vectors: `node dist/queue-runner/crq.js repair <argv>` against
 * Python `crq_repair.main(<argv>)` with `ROOT` pointed at the same temporary
 * runner root. Each vector stops before the unported drain, so both runtimes
 * must agree on stdout bytes, exit code, narration and the written tree, and
 * neither may launch a provider (stub `cq`/`codex`/`paseo` record any call).
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../../dist/queue-runner/crq.js', import.meta.url));
const APP = fileURLToPath(new URL('../../apps/crq-python', import.meta.url));
// Load crq_repair.py as the Python tests do, then point ROOT at the vector root.
const SHIM = [
  'import importlib.util, sys',
  'from pathlib import Path',
  `sys.path.insert(0, ${JSON.stringify(APP)})`,
  `spec = importlib.util.spec_from_file_location('crq_repair_cli', ${JSON.stringify(join(APP, 'crq_repair.py'))})`,
  'service = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(service)',
  'service.ROOT = Path(sys.argv[1])',
  'sys.exit(service.main(sys.argv[2:]))',
].join('\n');

interface Vector {
  readonly name: string;
  readonly argv: readonly string[];
  readonly disabled?: boolean;
  /** config.json text; omitted means no file. */
  readonly config?: string;
}

interface Outcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly tree: readonly string[];
  readonly launched: boolean;
}

const enabled = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ repair: { enabled: true, spend_authorization: 'owner 2026-11-20', ...extra } });
const off = JSON.stringify({ repair: { enabled: false, spend_authorization: 'x' } });

function prepare(vector: Vector): { root: string; bin: string; marker: string } {
  const base = mkdtempSync(join(tmpdir(), 'crq-repair-parity-'));
  const root = join(base, 'root');
  const bin = join(base, 'bin');
  const marker = join(base, 'launched');
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(bin);
  if (vector.disabled) writeFileSync(join(root, 'state', 'runner-disabled'), 'handover\n');
  if (vector.config !== undefined) writeFileSync(join(root, 'config.json'), vector.config);
  for (const provider of ['cq', 'codex', 'paseo', 'git']) {
    const path = join(bin, provider);
    writeFileSync(path, `#!/bin/sh\necho "$0 $*" >> ${JSON.stringify(marker)}\nexit 1\n`);
    chmodSync(path, 0o755);
  }
  return { root, bin, marker };
}

function tree(root: string): string[] {
  return (readdirSync(root, { recursive: true }) as string[])
    .map((entry) => relative(root, join(root, entry)))
    .sort();
}

function execute(runtime: 'node' | 'python', vector: Vector): Outcome {
  const { root, bin, marker } = prepare(vector);
  const [command, args] =
    runtime === 'node'
      ? [process.execPath, [CLI, 'repair', ...vector.argv]]
      : ['python3', ['-I', '-c', SHIM, root, ...vector.argv]];
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      ZAI_API_KEY: '',
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    tree: tree(root),
    launched: existsSync(marker),
  };
}

const IDENTICAL: readonly Vector[] = [
  // #1716: refused before config.json, state/repair, the lock or any alternate path.
  { name: 'disabled marker, bare drain, no config', argv: [], disabled: true },
  { name: 'disabled marker, recovery', argv: ['--recover-job', 'crq-a-F1'], disabled: true },
  {
    name: 'disabled marker, explicit job',
    argv: ['--job', 'crq-a-F1', '--source-sha', 'a'.repeat(40), '--finding-sha256', 'b'.repeat(64)],
    disabled: true,
    config: enabled(),
  },
  { name: 'disabled marker, triage dry run', argv: ['--triage-dry-run'], disabled: true },
  { name: 'disabled marker, unreadable config', argv: [], disabled: true, config: '{not json' },
  // Usage precedes the marker (argparse runs first).
  { name: 'unknown option', argv: ['--bogus', 'y'], disabled: true },
  { name: 'positional', argv: ['crq-a-F1'] },
  { name: 'missing value', argv: ['--job'] },
  { name: 'option-shaped value', argv: ['--job', '-x'] },
  { name: 'flag with explicit value', argv: ['--triage-dry-run=1'] },
  { name: 'abbreviated flag with explicit value', argv: ['--tri=1'] },
  // Disabled configuration.
  { name: 'repair disabled', argv: [], config: off },
  { name: 'no repair section', argv: [], config: '{}' },
  {
    name: 'blank spend authorization (Python whitespace)',
    argv: [],
    config: JSON.stringify({ repair: { enabled: true, spend_authorization: ' \u3000\u001c' } }),
  },
  {
    name: 'enabled not literally true',
    argv: [],
    config: JSON.stringify({ repair: { enabled: 1, spend_authorization: 'x' } }),
  },
  {
    name: 'values argparse reads as values, then disabled',
    argv: ['--job', '-1', '--source-sha', '-a b', '--finding-sha256=-x'],
    config: off,
  },
  // Selector mode refusals (exit 2), after the enabled check.
  {
    name: 'recovery with a selector',
    argv: ['--recover-job', 'j', '--job', 'a'],
    config: enabled(),
  },
  {
    name: 'abbreviated recovery with a selector',
    argv: ['--rec', 'j', '--j', 'a'],
    config: enabled(),
  },
  {
    name: 'recovery with triage',
    argv: ['--recover-job', 'j', '--triage-dry-run'],
    config: enabled(),
  },
  { name: 'empty recovery', argv: ['--recover-job', ' '], config: enabled() },
  {
    name: 'triage with a selector',
    argv: ['--triage-dry-run', '--source-sha', 'a'],
    config: enabled(),
  },
  { name: 'partial selectors', argv: ['--job', 'a', '--source-sha', 'b'], config: enabled() },
  {
    name: 'empty selector value',
    argv: ['--job=', '--source-sha', 'b', '--finding-sha256', 'c'],
    config: enabled(),
  },
];

describe('crq repair: Node vs Python crq_repair admission', () => {
  for (const vector of IDENTICAL) {
    it(vector.name, () => {
      const python = execute('python', vector);
      const node = execute('node', vector);
      expect(node).toEqual(python);
      expect(node.launched).toBe(false);
      expect(node.stdout.split('\n')).toHaveLength(2);
    });
  }

  it('the disabled marker writes nothing beyond the fixture', () => {
    const node = execute('node', { name: '', argv: [], disabled: true, config: enabled() });
    expect(node.tree).toEqual(['config.json', 'state', 'state/runner-disabled']);
    expect(node.stdout).toBe('{"status": "refused", "reason": "runner-disabled"}\n');
    expect(node.status).toBe(0);
  });

  it('agrees on the failure shape when config.json is missing', () => {
    const vector: Vector = { name: '', argv: [] };
    const python = execute('python', vector);
    const node = execute('node', vector);
    expect(node.status).toBe(1);
    expect(python.status).toBe(1);
    const shape = (text: string): unknown => {
      const { error } = JSON.parse(text) as { error: Record<string, unknown> };
      return { kind: error.kind, subcommand: error.subcommand, exitCode: error.exitCode };
    };
    expect(shape(node.stdout)).toEqual(shape(python.stdout));
    expect(node.tree).toEqual(python.tree);
  });
});
