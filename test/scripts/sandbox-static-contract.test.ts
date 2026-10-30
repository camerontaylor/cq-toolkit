import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('experimental sandbox static contract', () => {
  it('the documented standalone compiler bypasses a discovered root config', () => {
    const source = readFileSync(
      join(ROOT, 'experimental/sandbox-host/sandbox-certify.mjs'),
      'utf8',
    );
    const command = /pnpm exec tsc ([\s\S]*?) &&/.exec(source)?.[1];
    expect(command).toBeDefined();
    const args = (command ?? '')
      .replace(/\\\n\/\/\s*/g, ' ')
      .trim()
      .split(/\s+/);
    // Exercise the advertised flags with a tiny offline input: no production
    // build or boundary canary is needed to reproduce config discovery.
    const fixture = mkdtempSync(join(tmpdir(), 'cq-sandbox-tsc-'));
    try {
      writeFileSync(join(fixture, 'tsconfig.json'), '{"compilerOptions":{"notARealOption":true}}');
      writeFileSync(join(fixture, 'probe.ts'), 'export const probe = 1;\n');
      const input = args.indexOf('experimental/sandbox-host/probe.ts');
      expect(input).toBeGreaterThan(-1);
      args[input] = 'probe.ts';
      const types = args.indexOf('--types');
      expect(types).toBeGreaterThan(-1);
      args.splice(types, 2); // The isolated probe has no Node imports.
      const run = spawnSync(
        process.execPath,
        [join(ROOT, 'node_modules/typescript/bin/tsc'), ...args, '--noEmit'],
        {
          cwd: fixture,
          encoding: 'utf8',
          timeout: 20_000,
        },
      );
      expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
      const withoutBypass = spawnSync(
        process.execPath,
        [
          join(ROOT, 'node_modules/typescript/bin/tsc'),
          ...args.filter((arg) => arg !== '--ignoreConfig'),
          '--noEmit',
        ],
        { cwd: fixture, encoding: 'utf8', timeout: 20_000 },
      );
      expect(withoutBypass.status).not.toBe(0);
      expect(`${withoutBypass.stdout}${withoutBypass.stderr}`).toContain('TS5112');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('the static driver rejects a lint violation in an experimental backend', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'cq-sandbox-lint-'));
    const put = (path: string, content: string) => {
      mkdirSync(dirname(join(fixture, path)), { recursive: true });
      writeFileSync(join(fixture, path), content);
    };
    try {
      put('package.json', '{"type":"module"}');
      put('tsconfig.json', '{"compilerOptions":{"strict":true},"include":["**/*.ts"]}');
      put('.oxlintrc.json', '{"categories":{"correctness":"off"},"rules":{"no-debugger":"error"}}');
      for (const dir of ['src', 'test', 'lint', 'scripts']) {
        put(`${dir}/empty.ts`, 'export {};\n');
      }
      put('vitest.config.ts', 'export {};\n');
      put('experimental/sandbox-host/backend.ts', 'debugger;\nexport {};\n');
      put(
        'scripts/ratchet-typecheck.mjs',
        readFileSync(join(ROOT, 'scripts/ratchet-typecheck.mjs'), 'utf8'),
      );
      // Only the unrelated compiler/ratchet engine is stubbed. The production
      // driver's lint invocation and the installed Oxlint are exercised intact.
      put(
        'scripts/ratchet-lib.mjs',
        `
        export const ROOT = ${JSON.stringify(fixture)};
        export function fail(message) { console.error(message); process.exit(1); }
        export async function loadEngine() {
          return {
            registerAdapter() {}, adapters: { typecheckCount: {} },
            createCheckRatchet: () => async () => ({ value: {
              verdict: 'pass', currentValue: 0, baselineValue: 0, path: 'fixture'
            } })
          };
        }
        export function runTypecheckRaw() { return { status: 0 }; }
        export function typecheckEvidence() { return { evidence: { count: 0 }, rawText: '' }; }
      `,
      );
      put(
        'node_modules/oxlint/bin/oxlint',
        `import ${JSON.stringify(pathToFileURL(join(ROOT, 'node_modules/oxlint/bin/oxlint')).href)};\n`,
      );
      const run = spawnSync(process.execPath, ['scripts/ratchet-typecheck.mjs'], {
        cwd: fixture,
        encoding: 'utf8',
        timeout: 20_000,
      });
      const output = `${run.stdout}${run.stderr}`;
      expect(run.status, output).toBe(1);
      expect(output).toContain('no-debugger');
      expect(output).toContain('experimental/sandbox-host/backend.ts');
      expect(output).toContain('lint failed: exit 1');
      put('experimental/sandbox-host/backend.ts', 'export {};\n');
      const clean = spawnSync(process.execPath, ['scripts/ratchet-typecheck.mjs'], {
        cwd: fixture,
        encoding: 'utf8',
        timeout: 20_000,
      });
      expect(clean.status, `${clean.stdout}${clean.stderr}`).toBe(0);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
