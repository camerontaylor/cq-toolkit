// denylist.ts unit tests — the constrained patterns parser (fail-closed on
// every deviation), the diff scan (path scoping, line numbers, no content in
// the hits), and the shipped corpus: the REAL policy/denylist/patterns.yml
// must parse and every rule regex must compile (the parser and the gate
// cannot drift from the format the scan script owns).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  composeScanners,
  decodeGitPath,
  diffHeaderPaths,
  diffPathsOf,
  makeGitleaksDefaultsScanner,
  parseDenylistPatterns,
  patchSegments,
  scanComponents,
  scanText,
} from '../../../src/ops/dev/denylist.js';

const patternsPath = fileURLToPath(
  new URL('../../../policy/denylist/patterns.yml', import.meta.url),
);

const FIXTURE = [
  '# a comment',
  'rules:',
  '  - id: class:one',
  '    description: first rule',
  "    regex: 'se|cret'",
  "    sample: 'se<!-- sample -->cret token'",
  '  - id: class:env',
  '    description: env key material',
  "    regex: '.+'",
  "    path: '(^|/)[^/]*\\.env'",
  "    sample: 'sample dirty value for the fixture'",
  "    probe_path: '.zcode/probe.txt'",
  'clean_probes:',
  "  - 'an ordinary sentence'",
  "  - 'it''s quoted with an escaped quote'",
  '',
].join('\n');

describe('parseDenylistPatterns', () => {
  test('parses the constrained shape: rules with optional path/probe_path, clean probes, quotes', () => {
    const parsed = parseDenylistPatterns(FIXTURE, 'fixture.yml');
    expect(parsed.rules).toEqual([
      { id: 'class:one', description: 'first rule', regex: 'se|cret' },
      {
        id: 'class:env',
        description: 'env key material',
        regex: '.+',
        path: '(^|/)[^/]*\\.env',
      },
    ]);
    expect(parsed.cleanProbes).toEqual([
      'an ordinary sentence',
      "it's quoted with an escaped quote",
    ]);
  });

  test('unknown top-level key fails closed', () => {
    expect(() => parseDenylistPatterns('extra:\n', 'f.yml')).toThrow(
      /unknown top-level key 'extra'/,
    );
  });

  test('unknown rule key fails closed', () => {
    expect(() =>
      parseDenylistPatterns(
        "rules:\n  - id: x\n    surprise: 'y'\n    regex: 'z'\n    sample: 's'\n",
        'f.yml',
      ),
    ).toThrow(/unknown rule key 'surprise'/);
  });

  test('a missing required rule key fails closed', () => {
    expect(() => parseDenylistPatterns("rules:\n  - id: x\n    regex: 'y'\n", 'f.yml')).toThrow(
      /missing required key/,
    );
  });

  test('double-quoted scalars fail closed (format allows single-quoted or plain)', () => {
    expect(() =>
      parseDenylistPatterns(
        'rules:\n  - id: x\n    description: "dq"\n    regex: r\n    sample: s\n',
        'f.yml',
      ),
    ).toThrow(/unsupported scalar spelling/);
  });

  test('MIXED quoted/plain headers parse per-side (rename ASCII ↔ non-ASCII)', () => {
    const header = 'diff --git a/foo.env "b/caf\\303\\251.env"';
    expect(diffHeaderPaths(header)).toEqual(['foo.env', 'café.env']);
    const mirrored = 'diff --git "a/caf\\303\\251.env" b/foo.env';
    expect(diffHeaderPaths(mirrored)).toEqual(['café.env', 'foo.env']);
    // A binary patch with a mixed header is path-scoped for the rules.
    const patch = [header, 'GIT binary patch', 'literal 10', 'cmZ~1#x==', ''].join('\n');
    const rules = [{ id: 'class:env', description: 'd', regex: '.+', path: '(^|/)[^/]*\.env' }];
    const scans = scanComponents([{ component: 'staged', text: patch, kind: 'patch' }], rules);
    expect(scans[0]?.hits.map((hit) => hit.ruleId)).toContain('class:env');
  });

  test('QUOTED text headers (---/+++) decode too', () => {
    const patch = [
      'diff --git "a/caf\\303\\251.env" "b/caf\\303\\251.env"',
      '--- "a/caf\\303\\251.env"',
      '+++ "b/caf\\303\\251.env"',
      '+KEY=x',
    ].join('\n');
    const segments = patchSegments(patch);
    expect(segments[0]?.paths).toEqual(['café.env']);
  });

  test('git QUOTED header paths decode (C-escaped octal utf-8) and scope rules', () => {
    // `caf\303\251.env` = café.env in git's core.quotePath spelling.
    const header = 'diff --git "a/caf\\303\\251.env" "b/caf\\303\\251.env"';
    expect(diffHeaderPaths(header)).toEqual(['café.env', 'café.env']);
    const patch = [header, 'GIT binary patch', 'literal 10', 'cmZ~1#x==', ''].join('\n');
    const rules = [{ id: 'class:env', description: 'd', regex: '.+', path: '(^|/)[^/]*\.env' }];
    const scans = scanComponents([{ component: 'staged', text: patch, kind: 'patch' }], rules);
    expect(scans[0]?.hits.map((hit) => hit.ruleId)).toContain('class:env');
  });

  test('UNQUOTED headers with a filename-internal " b/" parse by self-consistency', () => {
    // A binary file literally named `.claude/memory.db b/notes.txt`: git
    // spells the SAME plain path on both sides, and that self-consistency
    // pins the split by parity — the interior ` b/` cannot hijack it (a
    // last-` b/` search read both sides as `notes.txt`, the agent-scratch
    // rule never fired, and the patch uploaded).
    const path = '.claude/memory.db b/notes.txt';
    const header = `diff --git a/${path} b/${path}`;
    expect(diffHeaderPaths(header)).toEqual([path, path]);
    // A binary segment has no ---/+++ fallback — the header is the ONLY
    // path source, and the path-scoped scratch rule must fire on it.
    const patch = [header, 'GIT binary patch', 'literal 10', 'cmZ~1#x==', ''].join('\n');
    const rules = [{ id: 'class:scratch', description: 'd', regex: '.+', path: '(^|/)\\.claude/' }];
    const scans = scanComponents([{ component: 'staged', text: patch, kind: 'patch' }], rules);
    expect(scans[0]?.hits.map((hit) => hit.ruleId)).toContain('class:scratch');
  });

  test('a plain-sided rename yields no header split; rename/copy lines carry the segment paths', () => {
    // Two DIFFERENT plain paths are not self-consistent, so the header
    // yields no split — the segment's unambiguous per-side `rename from`/
    // `rename to` (or `copy`) lines are the path source, binary patches
    // included.
    expect(diffHeaderPaths('diff --git a/old dir/asset.bin b/new dir/asset.bin')).toBeNull();
    const renamePatch = [
      'diff --git a/old dir/asset.bin b/new dir/asset.bin',
      'similarity index 100%',
      'rename from old dir/asset.bin',
      'rename to new dir/asset.bin',
      'GIT binary patch',
      'literal 10',
      'cmZ~1#x==',
      '',
    ].join('\n');
    expect(patchSegments(renamePatch)[0]?.paths).toEqual([
      'old dir/asset.bin',
      'new dir/asset.bin',
    ]);
    const copyPatch = [
      'diff --git a/old.bin b/new.bin',
      'similarity index 100%',
      'copy from old.bin',
      'copy to new.bin',
      'GIT binary patch',
      'literal 10',
      'cmZ~1#x==',
      '',
    ].join('\n');
    expect(patchSegments(copyPatch)[0]?.paths).toEqual(['old.bin', 'new.bin']);
  });

  test('decodeGitPath is exact on escapes and multibyte sequences', () => {
    expect(decodeGitPath('plain.env')).toBe('plain.env');
    expect(decodeGitPath('caf\\303\\251.env')).toBe('café.env');
    expect(decodeGitPath('a\\\\b')).toBe('a\\b');
    expect(decodeGitPath('q\"uote.env')).toBe('q"uote.env');
  });

  test('a zero-rule denylist fails closed at parse time', () => {
    expect(() => parseDenylistPatterns('rules:\nclean_probes:\n', 'f.yml')).toThrow(
      /no rules defined/,
    );
    expect(() => parseDenylistPatterns('', 'f.yml')).toThrow(/no rules defined/);
  });

  test('a duplicate rule key within one rule fails closed (last-value-wins would weaken the net)', () => {
    expect(() =>
      parseDenylistPatterns(
        "rules:\n  - id: x\n    regex: 'a'\n    regex: 'b'\n    description: d\n    sample: s\n",
        'f.yml',
      ),
    ).toThrow(/duplicate rule key 'regex'/);
  });

  test('a duplicate rule id fails closed (hits must be attributable)', () => {
    expect(() =>
      parseDenylistPatterns(
        "rules:\n  - id: x\n    regex: 'a'\n    description: d\n    sample: s\n  - id: x\n    regex: 'b'\n    description: d\n    sample: s\n",
        'f.yml',
      ),
    ).toThrow(/duplicate rule id 'x'/);
  });

  test('content before any top-level key fails closed', () => {
    expect(() => parseDenylistPatterns('  - id: x\n', 'f.yml')).toThrow(
      /content before any top-level key/,
    );
  });

  test('a clean_probes entry that is not a scalar list item fails closed', () => {
    expect(() => parseDenylistPatterns('clean_probes:\n  - a: b\n', 'f.yml')).toThrow(
      /clean_probes entries must be/,
    );
  });
});

describe('the shipped patterns.yml corpus', () => {
  const text = readFileSync(patternsPath, 'utf8');

  test('parses fail-closed without deviation', () => {
    const parsed = parseDenylistPatterns(text, 'policy/denylist/patterns.yml');
    expect(parsed.rules.length).toBeGreaterThanOrEqual(8);
    expect(parsed.cleanProbes.length).toBeGreaterThanOrEqual(5);
    for (const rule of parsed.rules) {
      expect(rule.id).toMatch(/^class:/);
      expect(rule.regex.length).toBeGreaterThan(0);
    }
  });

  test('every rule regex and path compiles', () => {
    const parsed = parseDenylistPatterns(text, 'policy/denylist/patterns.yml');
    for (const rule of parsed.rules) {
      expect(() => new RegExp(rule.regex)).not.toThrow();
      const path = rule.path;
      if (path !== undefined) expect(() => new RegExp(path)).not.toThrow();
    }
  });
});

describe('the diff scan', () => {
  const rules = [
    { id: 'class:one', description: 'd', regex: 'se\\|cret|secret-token' },
    { id: 'class:env', description: 'd', regex: '.+', path: '(^|/)[^/]*\\.env' },
  ];
  // (the double backslash above keeps the alternation literal in a string)

  test('diffPathsOf extracts +++ b/ paths, skipping /dev/null, deduped', () => {
    const patch = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      'diff --git a/a.txt b/a.txt',
      '+++ b/a.txt',
      '+++ /dev/null',
    ].join('\n');
    expect(diffPathsOf(patch)).toEqual(['a.txt']);
  });

  test('matches report rule id + 1-based lines, never the matched content', () => {
    const scan = scanText('t', 'harmless\nhas a secret-token here\nmore\n', rules, []);
    expect(scan.hits).toEqual([{ ruleId: 'class:one', lines: [2] }]);
    expect(JSON.stringify(scan.hits)).not.toContain('secret-token');
  });

  test('a path rule fires only on matching paths and never on a flat text', () => {
    const patch = 'diff --git a/notes b/prod.env\n--- a/notes\n+++ b/prod.env\n+API_KEY=whatever\n';
    const scoped = scanText('patch', patch, rules, diffPathsOf(patch));
    expect(scoped.hits.map((hit) => hit.ruleId)).toContain('class:env');
    const flat = scanText('flat', 'API_KEY=whatever\n', rules, []);
    expect(flat.hits.map((hit) => hit.ruleId)).not.toContain('class:env');
  });

  test('untracked file components carry their own path as path-rule context', () => {
    const rules = [{ id: 'class:env', description: 'd', regex: '.+', path: '(^|/)[^/]*\.env' }];
    const scans = scanComponents(
      [{ component: 'untracked:new.env', text: 'KEY=value\n', kind: 'file', path: 'new.env' }],
      rules,
    );
    expect(scans[0]?.hits.map((hit) => hit.ruleId)).toContain('class:env');
  });

  test('an uncompilable rule regex throws naming the rule (never a silent skip)', () => {
    const broken = [{ id: 'class:bad', description: 'd', regex: '([unclosed' }];
    expect(() => scanText('t', 'text\n', broken, [])).toThrow(/class:bad.*does not compile/);
  });

  test('a BINARY segment carries its paths from the diff --git header', () => {
    const patch = [
      'diff --git a/secrets.env b/secrets.env',
      'GIT binary patch',
      'literal 10',
      'cmZ~1#randombase64==',
      '',
    ].join('\n');
    const segments = patchSegments(patch);
    expect(segments[0]?.paths).toEqual(['secrets.env']);
    const rules = [{ id: 'class:env', description: 'd', regex: '.+', path: '(^|/)[^/]*\.env' }];
    const scans = scanComponents([{ component: 'staged', text: patch, kind: 'patch' }], rules);
    expect(scans[0]?.hits.map((hit) => hit.ruleId)).toContain('class:env');
  });

  test('patchSegments splits at diff --git with both paths and whole-patch offsets', () => {
    const patch = [
      'diff --git a/a.env b/a.env',
      '--- a/a.env',
      '+++ b/a.env',
      '+alpha',
      'diff --git a/renamed.txt b/renamed-elsewhere.txt',
      '--- a/renamed.txt',
      '+++ b/renamed-elsewhere.txt',
      '+beta',
    ].join('\n');
    const segments = patchSegments(patch);
    expect(segments).toHaveLength(2);
    expect(segments[0]?.paths).toEqual(['a.env']);
    expect(segments[1]?.paths).toEqual(['renamed.txt', 'renamed-elsewhere.txt']);
    expect(segments[1]?.startLine).toBe(5);
    expect(segments[1]?.text).toContain('+beta');
  });

  test('a path rule fires ONLY on its own file segment; line numbers stay absolute', () => {
    const patch = [
      'diff --git a/plain.txt b/plain.txt',
      '--- a/plain.txt',
      '+++ b/plain.txt',
      '+plain KEY=value',
      '+plain KEY=value again',
      'diff --git a/real.env b/real.env',
      '--- a/real.env',
      '+++ b/real.env',
      '+safe line',
      '+KEY=value',
    ].join('\n');
    const envRule = { id: 'class:env', description: 'd', regex: 'KEY=', path: '(^|/)[^/]*\.env' };
    const scans = scanComponents([{ component: 'staged', text: patch, kind: 'patch' }], [envRule]);
    // The plain.txt KEY= lines (4, 5) never match: the env rule scopes to
    // the real.env segment only, and the line numbers stay absolute.
    expect(scans[0]?.hits).toEqual([{ ruleId: 'class:env', lines: [10] }]);
  });

  test('scanComponents scans every component in order, files flat and patches path-scoped', () => {
    const scans = scanComponents(
      [
        {
          component: 'committed',
          text: '--- a/x\n+++ b/x.env\n+key material here\n',
          kind: 'patch',
        },
        { component: 'untracked:new.env', text: 'plain line\n', kind: 'file' },
      ],
      rules,
    );
    expect(scans).toHaveLength(2);
    expect(scans[0]?.component).toBe('committed');
    expect(scans[0]?.hits.map((hit) => hit.ruleId)).toContain('class:env');
    // A flat (file) component gives path rules no context: the env rule
    // cannot fire on 'new.env' content alone.
    expect(scans[1]?.hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The gitleaks-defaults scanner and the two-layer composition
// ---------------------------------------------------------------------------

describe('makeGitleaksDefaultsScanner', () => {
  const components = [
    { component: 'committed', text: 'line one\nline two\n', kind: 'patch' as const },
    { component: 'staged', text: 'single line\n', kind: 'patch' as const },
  ];

  function gitleaksEffects(exitCode: number, report: unknown, reportUnreadable = false) {
    const dirs: string[] = [];
    const removed: string[] = [];
    return {
      dirs,
      removed,
      runCommand: async (_command: string, args: readonly string[]) => {
        const reportPath = args[args.indexOf('--report-path') + 1];
        const { writeFile } = await import('node:fs/promises');
        await writeFile(
          String(reportPath),
          reportUnreadable ? 'not json' : JSON.stringify(report),
          'utf8',
        );
        return { exitCode, stdout: '', stderr: '', timedOut: false };
      },
      makeScratchDir: async (prefix: string) => {
        const { mkdtemp } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const dir = await mkdtemp(join(tmpdir(), `fake-${prefix}-`));
        dirs.push(dir);
        return dir;
      },
      removeScratchDir: async (path: string) => {
        const { rm } = await import('node:fs/promises');
        await rm(path, { recursive: true, force: true });
        removed.push(path);
      },
    };
  }

  test('a clean run maps no hits; components keep their order', async () => {
    const effects = gitleaksEffects(0, []);
    const scan = await makeGitleaksDefaultsScanner(effects)(components);
    expect(scan.map((entry) => entry.component)).toEqual(['committed', 'staged']);
    expect(scan.every((entry) => entry.hits.length === 0)).toBe(true);
    expect(effects.removed).toEqual([effects.dirs[0]]);
  });

  test('findings map back to components with rule id and line numbers', async () => {
    const effects = gitleaksEffects(1, [
      { RuleID: 'generic-api-key', File: '/tmp/x/component-0.txt', StartLine: 2 },
      { RuleID: 'generic-api-key', File: '/tmp/x/component-0.txt', StartLine: 2 },
      { RuleID: 'aws-access-token', File: '/tmp/x/component-1.txt', StartLine: 1 },
    ]);
    const scan = await makeGitleaksDefaultsScanner(effects)(components);
    expect(scan[0]?.hits).toEqual([{ ruleId: 'generic-api-key', lines: [2] }]);
    expect(scan[1]?.hits).toEqual([{ ruleId: 'aws-access-token', lines: [1] }]);
  });

  test('exit 1 with an EMPTY report is a fault — findings exist without mapped evidence', async () => {
    const effects = gitleaksEffects(1, []);
    await expect(makeGitleaksDefaultsScanner(effects)(components)).rejects.toThrow(
      /no mappable rows/,
    );
  });

  test('exit 1 with rows that all fail to map is a fault too', async () => {
    const effects = gitleaksEffects(1, [
      { RuleID: 'x', File: '/somewhere/unknown.txt', StartLine: 3 },
    ]);
    await expect(makeGitleaksDefaultsScanner(effects)(components)).rejects.toThrow(
      /no mappable rows/,
    );
  });

  test('exit 1 with an unreadable report is a fault (a claim without evidence cannot gate)', async () => {
    const effects = gitleaksEffects(1, [], true);
    await expect(makeGitleaksDefaultsScanner(effects)(components)).rejects.toThrow(
      /unreadable report/,
    );
  });

  test('any other exit code is a run fault (never uploaded unscanned)', async () => {
    const effects = gitleaksEffects(2, []);
    await expect(makeGitleaksDefaultsScanner(effects)(components)).rejects.toThrow(/failed to run/);
  });
});

describe('composeScanners', () => {
  test('hits from ANY layer refuse; clean layers merge silently', async () => {
    const projectScanner = (components: readonly { component: string; text: string }[]) =>
      components.map((component) => ({
        component: component.component,
        hits: component.text.includes('secret-token') ? [{ ruleId: 'class:one', lines: [1] }] : [],
      }));
    const gitleaksEffectsStub = {
      runCommand: async (_c: string, _a: readonly string[]) => ({
        exitCode: 1,
        stdout: '',
        stderr: '',
        timedOut: false,
      }),
      makeScratchDir: async () => '/tmp/fake-s',
      removeScratchDir: async () => undefined,
    };
    void gitleaksEffectsStub;
    const defaultsScanner = (components: readonly { component: string; text: string }[]) =>
      components.map((component) => ({
        component: component.component,
        hits: component.text.includes('AKIA') ? [{ ruleId: 'aws-access-token', lines: [1] }] : [],
      }));
    const composed = composeScanners(defaultsScanner, projectScanner);
    const merged = await composed([
      { component: 'a', text: 'has AKIA and secret-token', kind: 'patch' },
      { component: 'b', text: 'clean', kind: 'patch' },
    ]);
    expect(
      merged
        .find((scan) => scan.component === 'a')
        ?.hits.map((hit) => hit.ruleId)
        .sort(),
    ).toEqual(['aws-access-token', 'class:one']);
    expect(merged.find((scan) => scan.component === 'b')?.hits).toEqual([]);
  });
});

describe('canonical corpus patch allowlist', () => {
  test('skips only the exact corpus segment, preserving other paths and rename sides', () => {
    const rules = parseDenylistPatterns(FIXTURE, 'fixture').rules;
    const patch = (oldPath: string, newPath: string) =>
      `diff --git a/${oldPath} b/${newPath}\n--- a/${oldPath}\n+++ b/${newPath}\n@@ -0,0 +1 @@\n+secret\n`;
    const corpus = 'policy/denylist/patterns.yml';
    const scanned = scanComponents(
      [
        {
          component: 'mixed',
          kind: 'patch',
          text: patch(corpus, corpus) + patch('src/leak.ts', 'src/leak.ts'),
        },
      ],
      rules,
    );
    expect(scanned[0]?.hits).toHaveLength(1);
    expect(scanned[0]?.hits[0]?.lines[0]).toBeGreaterThan(5);
    for (const text of [
      patch(corpus, 'copy.yml'),
      patch('copy.yml', corpus),
      patch(`${corpus}.bak`, `${corpus}.bak`),
    ]) {
      expect(
        scanComponents([{ component: 'renamed', kind: 'patch', text }], rules)[0]?.hits,
      ).toHaveLength(1);
    }
  });
});
