import { describe, expect, it } from 'vitest';
import {
  exemptReason,
  globMatcher,
  loadScanExemptions,
  parseScanExemptions,
} from '../../src/queue-runner/scanExemptions.js';
import { scanReviewDiff, type ReviewScannerEffects } from '../../src/queue-runner/reviewScan.js';

// The fixture of apps/crq-python/test_scan_exemptions.py.
const EXEMPT_TOML = `
[[exempt]]
path = "crates/**/*tests.rs"
rule = "class:inline-secret-assignments"
reason = "upstream redaction fixtures"

[[exempt]]
path = "crates/jcode-app-core/src/server/swarm_tests.rs"
rule = "generic-api-key"
reason = 'upstream redaction fixtures'
`;
const SWARM = 'crates/jcode-app-core/src/server/swarm_tests.rs';

describe('scan exemption parsing', () => {
  it('reads basic and literal strings from [[exempt]] tables', () => {
    const entries = parseScanExemptions(EXEMPT_TOML);
    expect(entries.map((e) => [e.path, e.rule, e.reason])).toEqual([
      ['crates/**/*tests.rs', 'class:inline-secret-assignments', 'upstream redaction fixtures'],
      [SWARM, 'generic-api-key', 'upstream redaction fixtures'],
    ]);
    expect(loadScanExemptions(null)).toEqual({ entries: [], error: null });
  });
  it('fails the whole file closed on every malformed shape', () => {
    const bad = [
      '[[exempt]]\npath = "a"\nrule = "class:private-key"\nreason = "x"\n',
      '[[exempt]]\npath = "a"\nrule = "generic-api-key"\nreason = "  "\n',
      '[[exempt]]\npath = "a"\nrule = "generic-api-key"\n',
      '[[exempt]]\npath = 3\nrule = "generic-api-key"\nreason = "x"\n',
      '[[exempt]]\npath = "a"\npath = "b"\nrule = "generic-api-key"\nreason = "x"\n',
      '[[exempt]]\npath = "a"\nrule = "generic-api-key"\nreason = """x"""\n',
      '[[exempt]]\npath = "a\nrule = "generic-api-key"\nreason = "x"\n',
      '[[exempt]\npath = "a"\n',
      'stray = "x"\n',
      '[[exempt]]\npath = "**/**/**/**/a"\nrule = "generic-api-key"\nreason = "x"\n',
    ];
    for (const text of bad) {
      const loaded = loadScanExemptions(text);
      expect(loaded.entries).toEqual([]);
      expect(loaded.error).toMatch(/^\.crq\/scan-exemptions\.toml: /);
    }
  });
  it('decodes escapes and ignores unrelated tables and comments', () => {
    const entries = parseScanExemptions(
      '# c\n[meta]\nname = "x"\n[[exempt]] # t\npath = "a\\u00e9"  # c\nrule = "generic-api-key"\nreason = "r"\n',
    );
    expect(entries[0]?.path).toBe('aé');
  });
});

describe('malformed unrelated tables still void the file', () => {
  const good = '[[exempt]]\npath = "a"\nrule = "generic-api-key"\nreason = "r"\n';
  it.each([
    ['a duplicate key', '[meta]\nk = "1"\nk = "2"\n'],
    ['a repeated table header', '[meta]\nk = "1"\n[meta]\nj = "2"\n'],
    ['a table redefined as an array', '[meta]\nk = "1"\n[[meta]]\nj = "2"\n'],
  ])('%s', (_name, tail) => {
    expect(loadScanExemptions(`${good}${tail}`).entries).toEqual([]);
    expect(loadScanExemptions(`${good}${tail}`).error).toMatch(/^\.crq\/scan-exemptions\.toml: /);
  });

  it('repeated array-of-tables headers and distinct keys stay valid', () => {
    const text = `${good}[[meta]]\nk = "1"\n[[meta]]\nk = "2"\n`;
    expect(loadScanExemptions(text).error).toBeNull();
    expect(loadScanExemptions(text).entries).toHaveLength(1);
  });
});

describe('glob semantics (_glob_regex)', () => {
  const match = (pattern: string, path: string): boolean => globMatcher(pattern).test(path);
  it('keeps * inside a segment and ** across segments', () => {
    expect(match('crates/**/*tests.rs', 'crates/a/b/x_tests.rs')).toBe(true);
    expect(match('crates/**/*tests.rs', 'crates/x_tests.rs')).toBe(true);
    expect(match('crates/*/x.rs', 'crates/a/b/x.rs')).toBe(false);
    expect(match('a/**', 'a/b/c')).toBe(true);
    expect(match('a?c', 'abc')).toBe(true);
    expect(match('a?c', 'a/c')).toBe(false);
    expect(match('a.b', 'aXb')).toBe(false);
    expect(match('a-b+c', 'a-b+c')).toBe(true);
  });
  it('allows one trailing newline like Python $', () => {
    expect(match('a', 'a\n')).toBe(true);
    expect(match('a', 'a\n\n')).toBe(false);
  });
});

describe('matching cost is bounded', () => {
  it('a many-star pattern against a long non-matching path finishes quickly', () => {
    const matcher = globMatcher(`${'*a'.repeat(20)}b`);
    const started = performance.now();
    expect(matcher.test('a'.repeat(5000))).toBe(false);
    expect(matcher.test(`${'a'.repeat(5000)}b`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(2000);
  });
  it('matches what the regex form did across dirs, stars and the trailing newline', () => {
    const match = (pattern: string, path: string): boolean => globMatcher(pattern).test(path);
    expect(match('**/x.rs', 'x.rs')).toBe(true);
    expect(match('**/x.rs', 'a/b/x.rs')).toBe(true);
    expect(match('**/x.rs', 'a/bx.rs')).toBe(false);
    expect(match('a**', 'a/b\nc')).toBe(false);
    expect(match('a**', 'a/bc')).toBe(true);
    expect(match('a*', 'a\n')).toBe(true);
    expect(match('', '')).toBe(true);
    expect(match('é?', 'éx')).toBe(true);
  });
});

describe('TOML whitespace is space and tab only', () => {
  const entry = (sep: string): string =>
    `[[exempt]]\npath${sep}=${sep}"a"\nrule = "generic-api-key"\nreason = "r"\n`;
  it('accepts spaces and tabs around the equals sign', () => {
    expect(loadScanExemptions(entry(' \t')).entries).toHaveLength(1);
  });
  it.each([
    ['a no-break space', '\u00a0'],
    ['a BOM', '\ufeff'],
    ['an ideographic space', '\u3000'],
  ])('rejects %s around the equals sign', (_name, ch) => {
    const loaded = loadScanExemptions(entry(ch));
    expect(loaded.entries).toEqual([]);
    expect(loaded.error).not.toBeNull();
  });
  it('rejects a non-TOML space around a line, a header and a value tail', () => {
    for (const text of [
      '\u00a0[[exempt]]\npath = "a"\nrule = "generic-api-key"\nreason = "r"\n',
      '[[\u00a0exempt]]\npath = "a"\nrule = "generic-api-key"\nreason = "r"\n',
      '[[exempt]]\npath = "a"\u00a0\nrule = "generic-api-key"\nreason = "r"\n',
    ])
      expect(loadScanExemptions(text).error).not.toBeNull();
  });
});

describe('raw control characters fail closed', () => {
  const doc = (reason: string, quote: string): string =>
    `[[exempt]]\npath = "a"\nrule = "generic-api-key"\nreason = ${quote}${reason}${quote}\n`;
  it.each([
    ['a basic string', '"', '\u0001'],
    ['a literal string', "'", '\u0001'],
    ['a NUL', '"', '\u0000'],
    ['a DEL', "'", '\u007f'],
  ])('rejects %s', (_name, quote, ch) => {
    const loaded = loadScanExemptions(doc(`x${ch}y`, quote));
    expect(loaded.entries).toEqual([]);
    expect(loaded.error).toMatch(/control character/);
  });
  it('still loads an escaped control character and a raw tab', () => {
    expect(loadScanExemptions(doc('x\\u0001y', '"')).error).toBeNull();
    expect(loadScanExemptions(doc('x\ty', '"')).entries).toHaveLength(1);
  });
});

describe('exemptReason', () => {
  const entries = parseScanExemptions(EXEMPT_TOML);
  it('exempts only the two generic rules and only on matching paths', () => {
    expect(exemptReason(entries, 'generic-api-key', SWARM)).toBe('upstream redaction fixtures');
    expect(exemptReason(entries, 'generic-api-key', 'other.rs')).toBeNull();
    expect(exemptReason(entries, 'class:private-key', SWARM)).toBeNull();
    expect(exemptReason(entries, null, SWARM)).toBeNull();
    expect(exemptReason(undefined, 'generic-api-key', SWARM)).toBeNull();
    expect(exemptReason(entries, 'generic-api-key', undefined)).toBeNull();
  });
});

const ids = [
  'class:token-ssh-plumbing',
  'class:route-key-material',
  'class:key-material-env',
  'class:inline-secret-assignments',
];
const patterns = `rules:\n${ids.map((id, i) => `  - id: '${id}'\n    description: 'fixture'\n    regex: 'MARK${i}'\n    sample: 'fixture'\n`).join('')}clean_probes:\n  - 'clean'\n`;
const diff = [
  `diff --git a/${SWARM} b/${SWARM}`,
  '--- /dev/null',
  `+++ b/${SWARM}`,
  '@@ -0,0 +1,2 @@',
  '+MARK3 fixture',
  '+MARK1 real',
  '',
].join('\n');
function run(
  exemptions: ReturnType<typeof parseScanExemptions> | undefined,
  gl: { rule: string; diffLine: number }[],
  exemptionError?: string,
) {
  let report = '';
  const effects: ReviewScannerEffects = {
    match: async ({ rules, lines }) => {
      const hits: [number, number][] = [];
      for (const [lineIndex, line] of lines.entries())
        for (const [ruleIndex, rule] of rules.entries())
          if (line.text.includes(rule.regex)) hits.push([lineIndex, ruleIndex]);
      return hits;
    },
    gitleaks: async () => ({ kind: 'exit', code: 0, hits: gl }),
    writeReport: async (text) => {
      report = text;
    },
  };
  return scanReviewDiff(
    {
      patternsText: patterns,
      diff,
      base: 'b',
      head: 'h',
      foreign: false,
      extraClasses: [],
      artifactPath: '/run/scan.json',
      ...(exemptions ? { exemptions } : {}),
      ...(exemptionError ? { exemptionError } : {}),
    },
    effects,
  ).then((decision) => ({ decision, report: JSON.parse(report) as Record<string, unknown> }));
}

describe('scanReviewDiff exemptions', () => {
  const entries = parseScanExemptions(EXEMPT_TOML);
  it('moves an exempted generic hit to the exempted section and keeps real hits blocking', async () => {
    const { decision, report } = await run(entries, [{ rule: 'generic-api-key', diffLine: 6 }]);
    // MARK1 (route-key-material) is not exemptible, so the scan still fails.
    expect(decision).toMatchObject({ clean: false, denylistHits: 1, gitleaksHits: 0 });
    expect(report.exempted).toEqual({
      denylist: [
        {
          rule: 'class:inline-secret-assignments',
          file: SWARM,
          diff_line: 5,
          reason: 'upstream redaction fixtures',
        },
      ],
      gitleaks: [
        {
          rule: 'generic-api-key',
          diff_line: 6,
          file: SWARM,
          reason: 'upstream redaction fixtures',
        },
      ],
    });
  });
  it('lets a provider-specific rule on the same line veto the exemption', async () => {
    const { decision } = await run(entries, [
      { rule: 'generic-api-key', diffLine: 6 },
      { rule: 'aws-access-token', diffLine: 6 },
    ]);
    expect(decision.gitleaksHits).toBe(2);
  });
  it('records a fail-closed exemption error and attributes file to unexempted gitleaks hits', async () => {
    const { decision, report } = await run(
      undefined,
      [{ rule: 'generic-api-key', diffLine: 6 }],
      'x: bad',
    );
    expect(decision).toMatchObject({ denylistHits: 2, gitleaksHits: 1 });
    expect(report.exemption_error).toBe('x: bad');
    expect(report.gitleaks_hits).toEqual([{ rule: 'generic-api-key', diff_line: 6, file: SWARM }]);
  });
});
