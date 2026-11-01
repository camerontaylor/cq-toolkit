// denylist.ts unit tests — the constrained patterns parser (fail-closed on
// every deviation), the diff scan (path scoping, line numbers, no content in
// the hits), and the shipped corpus: the REAL policy/denylist/patterns.yml
// must parse and every rule regex must compile (the parser and the gate
// cannot drift from the format the scan script owns).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  composeScanners,
  decodePolicyUtf8,
  makeRepoDiffScanner,
  makeGitleaksDefaultsScanner,
  makePortableReviewScanner,
  parseDenylistPatterns,
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
      /unexpected top-level key "extra"/,
    );
  });

  test('unknown rule key fails closed', () => {
    expect(() =>
      parseDenylistPatterns(
        "rules:\n  - id: x\n    surprise: 'y'\n    regex: 'z'\n    sample: 's'\n",
        'f.yml',
      ),
    ).toThrow(/unexpected rule key "surprise"/);
  });

  test('a missing required rule key fails closed', () => {
    expect(() =>
      parseDenylistPatterns("rules:\n  - id: x\n    regex: 'y'\nclean_probes:\n  - p\n", 'f.yml'),
    ).toThrow(/missing required key "description"/);
  });

  test('double-quoted scalars fail closed (format allows single-quoted or plain)', () => {
    expect(() =>
      parseDenylistPatterns(
        'rules:\n  - id: x\n    description: "dq"\n    regex: r\n    sample: s\n',
        'f.yml',
      ),
    ).toThrow(/double-quoted values are not part of the constrained format/);
  });

  test('a zero-rule denylist fails closed at parse time', () => {
    expect(() => parseDenylistPatterns('rules:\nclean_probes:\n', 'f.yml')).toThrow(
      /zero rules parsed/,
    );
    expect(() => parseDenylistPatterns('', 'f.yml')).toThrow(/zero rules parsed/);
  });

  test('a duplicate rule key within one rule fails closed (last-value-wins would weaken the net)', () => {
    expect(() =>
      parseDenylistPatterns(
        "rules:\n  - id: x\n    regex: 'a'\n    regex: 'b'\n    description: d\n    sample: s\n",
        'f.yml',
      ),
    ).toThrow(/duplicate rule key "regex"/);
  });

  test('a duplicate rule id fails closed (hits must be attributable)', () => {
    expect(() =>
      parseDenylistPatterns(
        "rules:\n  - id: x\n    regex: 'a'\n    description: d\n    sample: s\n  - id: x\n    regex: 'b'\n    description: d\n    sample: s\nclean_probes:\n  - p\n",
        'f.yml',
      ),
    ).toThrow(/duplicate rule ids/);
  });

  test('content before any top-level key fails closed', () => {
    expect(() => parseDenylistPatterns('  - id: x\n', 'f.yml')).toThrow(
      /content before the first section/,
    );
  });

  test('a clean_probes entry that is not a scalar list item fails closed', () => {
    expect(() => parseDenylistPatterns('clean_probes:\n  - a: b\n', 'f.yml')).toThrow(
      /plain value contains reserved characters/,
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

describe('the component scan', () => {
  const rules = [
    { id: 'class:one', description: 'd', regex: 'se\\|cret|secret-token' },
    { id: 'class:env', description: 'd', regex: '.+', path: '(^|/)[^/]*\\.env' },
  ];

  test('matches report rule id + 1-based lines, never the matched content', () => {
    const hits = scanText('harmless\nhas a secret-token here\nmore\n', rules, 'notes.txt');
    expect(hits).toEqual([{ ruleId: 'class:one', lines: [2] }]);
    expect(JSON.stringify(hits)).not.toContain('secret-token');
  });

  test('a path rule fires only when the component path matches', () => {
    expect(scanText('API_KEY=whatever\n', rules, 'prod.env').map((hit) => hit.ruleId)).toContain(
      'class:env',
    );
    expect(scanText('API_KEY=whatever\n', rules, 'notes.txt')).toEqual([]);
    expect(scanText('API_KEY=whatever\n', rules, undefined)).toEqual([]);
  });

  test('an uncompilable rule regex or path throws naming the rule (never a silent skip)', () => {
    expect(() =>
      scanText('text\n', [{ id: 'class:bad', description: 'd', regex: '([unclosed' }], 'x'),
    ).toThrow(/class:bad.*does not compile/);
    expect(() =>
      scanText('text\n', [{ id: 'class:badpath', description: 'd', regex: 'x', path: '(' }], 'x'),
    ).toThrow(/class:badpath.*does not compile/);
  });

  test('synthetic check output path does not trigger protected-file content rules', () => {
    expect(
      scanComponents(
        [
          {
            component: 'check',
            path: 'check-output.txt',
            text: 'private value',
          },
        ],
        [{ id: 'env', description: 'env content', regex: '.+', path: '\\.env' }],
      ),
    ).toEqual([{ component: 'check', hits: [] }]);
  });
  test('scanComponents gives one verdict per component, in order, each scoped by its own path', () => {
    const scans = scanComponents(
      [
        { component: 'committed:x.env', text: '+key material here\n', path: 'x.env' },
        { component: 'untracked:notes.txt', text: 'plain line\n', path: 'notes.txt' },
      ],
      rules,
    );
    expect(scans.map((scan) => scan.component)).toEqual(['committed:x.env', 'untracked:notes.txt']);
    expect(scans[0]?.hits.map((hit) => hit.ruleId)).toEqual(['class:env']);
    expect(scans[1]?.hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The gitleaks-defaults scanner and the two-layer composition
// ---------------------------------------------------------------------------

describe('makeGitleaksDefaultsScanner', () => {
  const components = [
    { component: 'committed', text: 'line one\nline two\n', path: 'a.txt' },
    { component: 'staged', text: 'single line\n', path: 'b.txt' },
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

  test('composed scanners forward the diagnostic timeout to the gitleaks child', async () => {
    const effects = gitleaksEffects(0, []);
    let timeout: number | undefined;
    const scanner = composeScanners(
      makeGitleaksDefaultsScanner({
        ...effects,
        runCommand: (command, args, options) => {
          timeout = options.timeoutMs;
          return effects.runCommand(command, args);
        },
      }),
    );
    await scanner(components, { timeoutMs: 100 });
    expect(timeout).toBe(100);
  });
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

  test('fresh adopter needs no legacy patterns file; configured optional path remains enforced', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fresh-adopter-'));
    try {
      const effects = gitleaksEffects(0, []);
      const plain = makePortableReviewScanner(root, effects, null);
      expect(await plain(components)).toHaveLength(2);
      const configured = makePortableReviewScanner(
        root,
        effects,
        JSON.stringify({
          schemaVersion: 2,
          checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
          review: { denylistPatternsFile: 'custom/patterns.yml' },
        }),
      );
      await expect(configured(components)).rejects.toThrow(/cannot read the patterns file/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
      { component: 'a', text: 'has AKIA and secret-token', path: 'a' },
      { component: 'b', text: 'clean', path: 'b' },
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

describe('makeRepoDiffScanner reads the policy as STRICT UTF-8 (fail closed)', () => {
  const POLICY = [
    'rules:',
    '  - id: class:probe',
    '    description: d',
    "    regex: 'review356_probe'",
    "    sample: 'review356_probe'",
    'clean_probes:',
    "  - 'ordinary'",
    '',
  ].join('\n');
  const component = { component: 'committed:a.ts', text: '+review356_probe\n', path: 'a.ts' };

  function scannerOver(bytes: Buffer) {
    const root = mkdtempSync(join(tmpdir(), 'cq-dev-policy-'));
    mkdirSync(join(root, 'policy', 'denylist'), { recursive: true });
    writeFileSync(join(root, 'policy', 'denylist', 'patterns.yml'), bytes);
    return {
      scan: makeRepoDiffScanner(root),
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  }

  test('valid bytes parse and the rule fires', async () => {
    const { scan, cleanup } = scannerOver(Buffer.from(POLICY));
    try {
      expect((await scan([component]))[0]?.hits.map((hit) => hit.ruleId)).toEqual(['class:probe']);
    } finally {
      cleanup();
    }
  });

  test.each([
    ['a raw FF byte after the sentinel', 0xff],
    ['a truncated two-byte sequence', 0xc3],
    ['a lone continuation byte', 0x80],
  ])('%s throws instead of weakening the rule', (_label, byte) => {
    const at = POLICY.indexOf('review356_probe') + 'review356_probe'.length;
    const bytes = Buffer.concat([
      Buffer.from(POLICY.slice(0, at)),
      Buffer.from([byte]),
      Buffer.from(POLICY.slice(at)),
    ]);
    const { scan, cleanup } = scannerOver(bytes);
    try {
      expect(() => scan([component])).toThrow(/not valid UTF-8/);
    } finally {
      cleanup();
    }
  });

  test('a leading BOM is kept and rejected, as the authoritative parser rejects it', () => {
    expect(decodePolicyUtf8(Buffer.from(`\uFEFF${POLICY}`), 'p.yml').startsWith('\uFEFF')).toBe(
      true,
    );
    const { scan, cleanup } = scannerOver(Buffer.from(`\uFEFF${POLICY}`));
    try {
      expect(() => scan([component])).toThrow(/content before the first section/);
    } finally {
      cleanup();
    }
  });
});
