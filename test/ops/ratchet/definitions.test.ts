// W1.7 slice 3 — tests for src/ops/ratchet/internal/definitions.ts.
//
// Pinned:
//   - the committed baselines/ratchets.json parses, and each ratchet's
//     baselineRelPath file exists with the manifest's direction and unit;
//   - the parser is strict (extra key, duplicate ratchet, unanchored or
//     non-compiling pattern, bad evidence all throw);
//   - isDefinitionPath over the committed definition set;
//   - loadTrustedManifest reads the TRUST ref, ignoring later commits and
//     uncommitted edits;
//   - tsconfigGraphPaths follows extends + references through JSONC
//     comments/trailing commas, is cycle-safe, and fails closed past its cap.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  RATCHETS_MANIFEST_PATH,
  isDefinitionPath,
  loadTrustedManifest,
  parseRatchetManifest,
  tsconfigGraphPaths,
} from '../../../src/ops/ratchet/internal/definitions.js';
import { baselineRelPath, parseBaseline } from '../../../src/ops/ratchet/format.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
}

function write(repo: string, path: string, content: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content, 'utf8');
}

function commitAll(repo: string, message: string): string {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']).trim();
}

const committedText = readFileSync(join(ROOT, RATCHETS_MANIFEST_PATH), 'utf8');

/** A valid manifest object to mutate per invalid case. */
function validManifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    ratchets: [
      { target: 't', metric: 'm', direction: 'lower-is-better', unit: 'u', evidence: 'recompute' },
    ],
    definitionSet: ['^a/'],
  };
}

describe('the committed manifest', () => {
  test('parses and matches the committed baselines', () => {
    const manifest = parseRatchetManifest(committedText);
    expect(manifest.ratchets.map((r) => [r.target, r.metric, r.evidence])).toEqual([
      ['typecheck', 'typecheck-count', 'recompute'],
      ['coverage', 'coverage', 'measurement'],
    ]);
    for (const ratchet of manifest.ratchets) {
      const baseline = parseBaseline(
        readFileSync(join(ROOT, baselineRelPath(ratchet.target, ratchet.metric)), 'utf8'),
      );
      expect(baseline.target).toBe(ratchet.target);
      expect(baseline.metric).toBe(ratchet.metric);
      expect(baseline.direction).toBe(ratchet.direction);
      expect(baseline.unit).toBe(ratchet.unit);
    }
  });

  test('is 2-space JSON with a trailing newline', () => {
    expect(`${JSON.stringify(JSON.parse(committedText), null, 2)}\n`).toBe(committedText);
  });
});

describe('parseRatchetManifest strictness', () => {
  test('a valid manifest parses', () => {
    expect(parseRatchetManifest(JSON.stringify(validManifest())).definitionSet).toEqual(['^a/']);
  });

  test.each<[string, (m: Record<string, unknown>) => void, RegExp]>([
    ['extra top-level key', (m) => (m['extra'] = 1), /schema violation/],
    [
      'extra ratchet key',
      (m) => ((m['ratchets'] as Record<string, unknown>[])[0]!['baseline'] = 1),
      /schema violation/,
    ],
    [
      'duplicate ratchet',
      (m) => {
        const r = m['ratchets'] as unknown[];
        r.push({ ...(r[0] as object), direction: 'higher-is-better' });
      },
      /duplicate ratchet \(t, m\)/,
    ],
    ['empty ratchets', (m) => (m['ratchets'] = []), /schema violation/],
    ['unanchored pattern', (m) => (m['definitionSet'] = ['package\\.json$']), /anchored/],
    ['non-compiling pattern', (m) => (m['definitionSet'] = ['^a(']), /compile/],
    [
      'bad evidence',
      (m) => ((m['ratchets'] as Record<string, unknown>[])[0]!['evidence'] = 'trust-me'),
      /schema violation/,
    ],
    [
      'bad direction',
      (m) => ((m['ratchets'] as Record<string, unknown>[])[0]!['direction'] = 'up'),
      /schema violation/,
    ],
    ['wrong schemaVersion', (m) => (m['schemaVersion'] = 2), /schema violation/],
  ])('%s throws', (_name, mutate, pattern) => {
    const manifest = validManifest();
    mutate(manifest);
    expect(() => parseRatchetManifest(JSON.stringify(manifest))).toThrow(pattern);
  });

  test('non-JSON throws', () => {
    expect(() => parseRatchetManifest('{')).toThrow(/not valid JSON/);
  });
});

describe('isDefinitionPath', () => {
  const manifest = parseRatchetManifest(committedText);
  test.each<[string, boolean]>([
    ['.github/workflows/x.yml', true],
    ['.github/workflows/ratchet-propose.yml', true],
    ['.gitattributes', true],
    ['sub/.gitattributes', true],
    ['vitest.config.ts', true],
    ['vitest.config.mts', true],
    ['packages/a/vite.config.js', true],
    ['vitest.workspace.ts', true],
    ['tsconfig.json', true],
    ['packages/a/tsconfig.build.json', true],
    ['package.json', true],
    ['packages/a/package.json', true],
    ['package-lock.json', true],
    ['npm-shrinkwrap.json', true],
    ['.npmrc', true],
    ['.nvmrc', true],
    ['.node-version', true],
    ['.cq/tool/bin', true],
    ['baselines/ratchets.json', true],
    ['src/x.ts', false],
    ['test/x.test.ts', false],
    ['baselines/coverage--coverage--a8ceec8f7024.json', false],
    ['docs/package.json.md', false],
    ['src/mytsconfig.json', false],
    ['.github/CODEOWNERS', false],
  ])('%s → %s', (path, expected) => {
    expect(isDefinitionPath(manifest, path)).toBe(expected);
  });
});

describe('git-backed', { timeout: 30_000 }, () => {
  let tmp: string;
  let repo: string;
  let trust: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cq-ratchet-defs-'));
    repo = join(tmp, 'repo');
    mkdirSync(repo);
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@example.test']);
    git(repo, ['config', 'user.name', 'test']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    write(repo, RATCHETS_MANIFEST_PATH, committedText);
    write(
      repo,
      'tsconfig.json',
      [
        '// root config',
        '{',
        '  /* block, with a "quote" and a trailing comma, */',
        '  "extends": ["./configs/base", "@tsconfig/node20/tsconfig.json",],',
        '  "compilerOptions": { "outDir": "dist//x", "rootDir": "/*not a comment*/", },',
        '  "references": [',
        '    { "path": "./packages/a" }, // a directory',
        '    { "path": "packages/b/tsconfig.build.json" },',
        '    { "path": "../outside" },',
        '  ],',
        '}',
      ].join('\n'),
    );
    write(repo, 'configs/base.json', '{ "extends": "./strict.json" }');
    // A cycle back to base.
    write(repo, 'configs/strict.json', '{ "extends": "./base.json", }');
    write(repo, 'packages/a/tsconfig.json', '{ "extends": "../../tsconfig.json" }');
    write(repo, 'packages/b/tsconfig.build.json', '{ "extends": "./missing.json" }');
    write(repo, 'broken/tsconfig.json', '{ "extends": "./never.json" ');
    trust = commitAll(repo, 'trust');

    // A later commit (the "head") and an uncommitted edit both loosen the
    // manifest; neither may be read through the trust ref.
    const loosened = JSON.parse(committedText) as { definitionSet: string[] };
    loosened.definitionSet = ['^nothing$'];
    write(repo, RATCHETS_MANIFEST_PATH, `${JSON.stringify(loosened, null, 2)}\n`);
    commitAll(repo, 'head loosens');
    write(repo, RATCHETS_MANIFEST_PATH, '{ "uncommitted": true }\n');
  }, 60_000);

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('loadTrustedManifest reads the trust ref, not HEAD or the working tree', async () => {
    const manifest = await loadTrustedManifest(repo, trust);
    expect(manifest).toEqual(parseRatchetManifest(committedText));
    const head = await loadTrustedManifest(repo, 'main');
    expect(head.definitionSet).toEqual(['^nothing$']);
  });

  test('loadTrustedManifest throws when the manifest is absent at the trust ref', async () => {
    const empty = join(tmp, 'empty');
    mkdirSync(empty);
    git(empty, ['init', '-q', '-b', 'main']);
    write(empty, 'README.md', 'x\n');
    git(empty, ['add', '-A']);
    git(empty, ['-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '-q', '-m', 'x']);
    await expect(loadTrustedManifest(empty, 'main')).rejects.toThrow(/absent at main/);
  });

  test('tsconfigGraphPaths follows extends + references, JSONC, cycle-safe', async () => {
    expect(await tsconfigGraphPaths(repo, trust)).toEqual([
      'configs/base.json',
      'configs/strict.json',
      'packages/a/tsconfig.json',
      'packages/b/missing.json',
      'packages/b/tsconfig.build.json',
      'tsconfig.json',
    ]);
  });

  test('an unparsable tsconfig is included but not followed', async () => {
    expect(await tsconfigGraphPaths(repo, trust, ['broken/tsconfig.json'])).toEqual([
      'broken/tsconfig.json',
    ]);
  });

  test('an absent root is still reported', async () => {
    expect(await tsconfigGraphPaths(repo, trust, ['nope/tsconfig.json'])).toEqual([
      'nope/tsconfig.json',
    ]);
  });

  test('a graph past the cap fails closed', async () => {
    const chain = join(tmp, 'chain');
    mkdirSync(chain);
    git(chain, ['init', '-q', '-b', 'main']);
    // Fan-out (not a chain) so the cap trips after ONE read: 70 references
    // from a single root exceed 64 before any of them is fetched.
    const references = Array.from({ length: 70 }, (_, i) => ({ path: `./p${i}` }));
    write(chain, 'c/t0.json', JSON.stringify({ references }));
    git(chain, ['add', '-A']);
    git(chain, ['-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '-q', '-m', 'x']);
    await expect(tsconfigGraphPaths(chain, 'main', ['c/t0.json'])).rejects.toThrow(
      /exceeds 64 files/,
    );
  });
});
