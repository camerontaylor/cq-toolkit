// PARITY: the TS port in src/ops/dev/denylist.ts must accept exactly the
// patterns files scripts/denylist-scan accepts, and read the same rules from
// them. The oracle is the protected script's OWN parser, loaded from its
// source text (its functions are pure; the script's main never runs), so a
// change to either side that makes them diverge fails here. A divergence is
// a fail-open path: a malformed rule the TS side reads as a weaker regex
// would let content past the pre-upload scan.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parseDenylistPatterns } from '../../../src/ops/dev/denylist.js';

const scriptText = readFileSync(
  fileURLToPath(new URL('../../../scripts/denylist-scan', import.meta.url)),
  'utf8',
);
const corpusText = readFileSync(
  fileURLToPath(new URL('../../../policy/denylist/patterns.yml', import.meta.url)),
  'utf8',
);

/** The slice of the script from the line starting `start` up to (excluding) the line starting `end`. */
function slice(start: string, end: string): string {
  const from = scriptText.indexOf(`\n${start}`);
  const to = scriptText.indexOf(`\n${end}`, from + 1);
  if (from === -1 || to === -1)
    throw new Error(`parity oracle: markers '${start}'..'${end}' not found`);
  return scriptText.slice(from, to);
}

/** The authoritative parser, built from the script's own source text. */
const buildOracle = new Function(
  'path',
  [
    slice('const TOP_KEYS =', '// Real invariant'),
    slice('class ConfigError', '// Known gitleaks invocation failure'),
    slice('function parseScalar', 'function loadPatterns'),
    'return parsePatterns;',
  ].join('\n'),
) as (pathModule: typeof path) => (text: string) => { rules: Record<string, string>[] };
const authoritative = buildOracle(path);

type Verdict = { ok: false } | { ok: true; rules: { id: string; regex: string; path?: string }[] };

function oracle(text: string): Verdict {
  try {
    const { rules } = authoritative(text);
    return {
      ok: true,
      rules: rules.map((r) => ({
        id: r['id'] as string,
        regex: r['regex'] as string,
        ...(r['path'] !== undefined ? { path: r['path'] } : {}),
      })),
    };
  } catch {
    return { ok: false };
  }
}

function port(text: string): Verdict {
  try {
    const { rules } = parseDenylistPatterns(text, 'patterns.yml');
    return {
      ok: true,
      rules: rules.map((r) => ({
        id: r.id,
        regex: r.regex,
        ...(r.path !== undefined ? { path: r.path } : {}),
      })),
    };
  } catch {
    return { ok: false };
  }
}

const RULE = (regex: string, extra = ''): string =>
  [
    'rules:',
    '  - id: class:probe',
    '    description: probe rule',
    `    regex: ${regex}`,
    "    sample: 'review334_forbidden_probe'",
    ...(extra === '' ? [] : [extra]),
    'clean_probes:',
    "  - 'an ordinary sentence'",
    '',
  ].join('\n');

const CASES: [string, string][] = [
  ['the shipped corpus', corpusText],
  ['a valid single-quoted rule', RULE("'review334_forbidden_probe'")],
  ["the reviewer's malformed quoted rule", RULE("'review334_forbidden_probe' # typo'")],
  ['an embedded unescaped quote', RULE("'a'b'")],
  ['an escaped quote', RULE("'it''s'")],
  ['an empty quoted value', RULE("''")],
  ['an empty plain value', RULE('')],
  ['a double-quoted value', RULE('"x"')],
  ['a plain value with ": "', RULE('a: b')],
  ['a plain value with " #"', RULE('abc #comment')],
  ['a plain value', RULE('abc')],
  ['a tab', RULE("'x'").replace('    regex', '\tregex')],
  ['three-space indentation', RULE("'x'").replace('    regex', '   regex')],
  ['a rule not starting with id', RULE("'x'").replace('  - id: class:probe', '  - description: d')],
  ['an unknown rule key', RULE("'x'", '    severity: high')],
  ['a duplicate rule key', RULE("'x'", "    regex: 'y'")],
  ['a path rule', RULE("'x'", "    path: '(^|/)[^/]*\\.env$'")],
  ['an absolute probe_path', RULE("'x'", "    probe_path: '/etc/x'")],
  ['a .. probe_path', RULE("'x'", "    probe_path: 'a/../b'")],
  ['a device-name probe_path', RULE("'x'", "    probe_path: 'nul.txt'")],
  ['a plain probe_path', RULE("'x'", "    probe_path: '.zcode/probe.txt'")],
  ['a duplicate section', `${RULE("'x'")}rules:\n`],
  ['empty clean_probes', RULE("'x'").replace("  - 'an ordinary sentence'\n", '')],
  ['content before a section', `  - id: x\n${RULE("'x'")}`],
  ['zero rules', "rules:\nclean_probes:\n  - 'x'\n"],
];

describe('parseDenylistPatterns parity with scripts/denylist-scan', () => {
  test.each(CASES)('%s: same verdict and same rules', (_name, text) => {
    expect(port(text)).toEqual(oracle(text));
  });

  test('the oracle itself accepts the corpus and rejects the malformed probe', () => {
    expect(oracle(corpusText).ok).toBe(true);
    expect(oracle(RULE("'review334_forbidden_probe' # typo'")).ok).toBe(false);
  });

  test('quote mutations of every corpus line keep parity (no accepted-but-different rule)', () => {
    const lines = corpusText.split('\n');
    let compared = 0;
    for (const [index, line] of lines.entries()) {
      if (!line.includes("'")) continue;
      for (const mutated of [
        `${line} # typo'`,
        `${line}'`,
        line.replace("'", ''),
        line.replace(/'$/, ''),
        line.replace("'", "''"),
        line.replace(/'([^']*)'/, "'$1' x'"),
      ]) {
        const text = [...lines.slice(0, index), mutated, ...lines.slice(index + 1)].join('\n');
        expect(port(text), `line ${String(index + 1)}: ${mutated}`).toEqual(oracle(text));
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(50);
  });
});
