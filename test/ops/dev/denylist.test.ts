// denylist.ts unit tests — the constrained patterns parser (fail-closed on
// every deviation), the diff scan (path scoping, line numbers, no content in
// the hits), and the shipped corpus: the REAL policy/denylist/patterns.yml
// must parse and every rule regex must compile (the parser and the gate
// cannot drift from the format the scan script owns).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  diffPathsOf,
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

  test('an uncompilable rule regex throws naming the rule (never a silent skip)', () => {
    const broken = [{ id: 'class:bad', description: 'd', regex: '([unclosed' }];
    expect(() => scanText('t', 'text\n', broken, [])).toThrow(/class:bad.*does not compile/);
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
