// Lane C S1 — `analyze.init`: detection by files present, the written
// `cq.json` round-trips through the config parser, and every refusal
// (existing file without force, nothing detected, missing dir) is `failed`
// with nothing written.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { parseCqConfig } from '../../../src/ops/analyze/cqConfig.js';
import { makeAnalyzeInit } from '../../../src/ops/analyze/init.js';
import { AnalyzeInitInputSchema } from '../../../src/ops/analyze/registry.js';

const dirs: string[] = [];
function project(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'cq-init-'));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const init = makeAnalyzeInit();

describe('analyze.init detection', () => {
  test('tsconfig.json → one tsc-lines check with the bare tool name; the file parses back', async () => {
    const dir = project({ 'tsconfig.json': '{}' });
    const result = await init({ dir });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.config).toEqual({
      schemaVersion: 1,
      checks: [
        {
          adapter: 'tsc-lines',
          command: { command: 'tsc', args: ['--noEmit', '--pretty', 'false'], cwd: '.' },
        },
      ],
    });
    expect(result.value.detected).toEqual(['tsc-lines: tsconfig.json']);
    expect(result.value.overwritten).toBe(false);
    expect(result.value.configPath).toBe(join(dir, 'cq.json'));
    const parsed = parseCqConfig(readFileSync(join(dir, 'cq.json'), 'utf8'));
    expect(parsed.ok).toBe(true);
  });

  test('a project-local node_modules/.bin binary is preferred over PATH', async () => {
    const dir = project({ 'tsconfig.json': '{}', 'node_modules/.bin/tsc': '#!/bin/sh\n' });
    const result = await init({ dir });
    expect(result.status === 'ok' && result.value.config.checks[0]?.command.command).toBe(
      join('node_modules', '.bin', 'tsc'),
    );
  });

  test.each([
    ['eslint.config.js', 'eslint-json: eslint.config.js'],
    ['.eslintrc.json', 'eslint-json: .eslintrc.json'],
  ])('ESLint config %s → an eslint-json check', async (file, line) => {
    const dir = project({ 'tsconfig.json': '{}', [file]: 'export default [];' });
    const result = await init({ dir });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.config.checks.map((check) => check.adapter)).toEqual([
      'tsc-lines',
      'eslint-json',
    ]);
    expect(result.value.config.checks[1]?.command.args).toEqual(['--format', 'json', '.']);
    expect(result.value.detected).toContain(line);
  });

  test('package.json#eslintConfig counts as an ESLint config', async () => {
    const dir = project({ 'package.json': JSON.stringify({ eslintConfig: {} }) });
    const result = await init({ dir });
    expect(result.status === 'ok' && result.value.detected).toEqual([
      'eslint-json: package.json#eslintConfig',
    ]);
  });
});

describe('analyze.init refusals', () => {
  test('an existing cq.json is not overwritten without force; force replaces it', async () => {
    const dir = project({ 'tsconfig.json': '{}', 'cq.json': '{"mine":true}\n' });
    const refused = await init({ dir });
    expect(refused.status).toBe('failed');
    if (refused.status === 'failed') expect(refused.error).toContain('--force');
    expect(readFileSync(join(dir, 'cq.json'), 'utf8')).toBe('{"mine":true}\n');
    const forced = await init({ dir, force: true });
    expect(forced.status === 'ok' && forced.value.overwritten).toBe(true);
    expect(parseCqConfig(readFileSync(join(dir, 'cq.json'), 'utf8')).ok).toBe(true);
  });

  test('nothing detected → failed naming the hand-written shape; no file', async () => {
    const dir = project({ 'README.md': 'hi' });
    const result = await init({ dir });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('"schemaVersion": 1');
    expect(() => readFileSync(join(dir, 'cq.json'))).toThrow();
  });

  test('a missing directory → failed', async () => {
    const result = await init({ dir: join(tmpdir(), 'cq-init-does-not-exist-xyz') });
    expect(result.status).toBe('failed');
  });

  test('the registry mirror is strict', () => {
    expect(AnalyzeInitInputSchema.safeParse({ dir: '.', force: true }).success).toBe(true);
    expect(AnalyzeInitInputSchema.safeParse({ dir: '.', extra: 1 }).success).toBe(false);
    expect(AnalyzeInitInputSchema.safeParse({ dir: '' }).success).toBe(false);
  });
});

describe('parseCqConfig', () => {
  test('invalid JSON and schema violations are reasons, never throws', () => {
    expect(parseCqConfig('{').ok).toBe(false);
    const wrong = parseCqConfig(JSON.stringify({ schemaVersion: 2, checks: [] }));
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toContain('schemaVersion');
    expect(parseCqConfig(JSON.stringify({ schemaVersion: 1, checks: [] })).ok).toBe(false);
  });

  test('a parsed check gains the op-boundary timeout default', () => {
    const parsed = parseCqConfig(
      JSON.stringify({
        schemaVersion: 1,
        checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
      }),
    );
    expect(parsed.ok && parsed.config.checks[0]?.command.timeoutMs).toBe(600_000);
  });
});
