// Analyze lane G1+G2+G3 — registry-slice test evidence: the entries
// (analyze.collectFailures, analyze.clusterErrors, the G2
// analyze.renderAnalysisReport, and the G3 playbook entries) validate the
// full input and only it — strict unknown-key rejection is load-bearing at
// every family boundary — and their importers resolve lazily to the ops
// (the aggregator with its policy-to-failed mapping, the pure clustering
// decision op, the report-pair publisher bound to the containment-checked
// path store, and the playbook lane composed over its SHARED
// registry/ledger singletons).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { fnv1a32Hex } from '../../../src/ops/gates/fingerprint.js';
import { FailureSetSchema } from '../../../src/ops/gates/registry.js';
import {
  ANALYZE_IDENTIFIER_ENCODED_MAX,
  AgenticRemediationInputSchema,
  AnalyzeReportSchema,
  ApplyRemediationInputSchema,
  AstGrepCodemodInputSchema,
  ClusterErrorsInputSchema,
  CollectFailuresInputSchema,
  LedgerViewSchema,
  PlaybookDispatchInputSchema,
  PlaybookQuarantineListInputSchema,
  PlaybookRegisterInputSchema,
  RenderAnalysisReportInputSchema,
  registry,
} from '../../../src/ops/analyze/registry.js';

/** A minimal valid FailureSet (the gates registry test's idiom). */
const EMPTY_FAILURE_SET = { tool: 'eslint', failures: [], exitCode: 0 };

describe('analyze registry: the lane entries', () => {
  test('the registry names the lane ops in order', () => {
    expect(registry.map((entry) => entry.name)).toEqual([
      'analyze.collectFailures',
      'analyze.clusterErrors',
      'analyze.renderAnalysisReport',
      'analyze.astGrepCodemod',
      'analyze.agenticRemediation',
      'analyze.applyRemediation',
      'analyze.playbookRegister',
      'analyze.playbookDispatch',
      'analyze.playbookQuarantineList',
    ]);
  });
});

describe('CollectFailuresInputSchema (full input, and only it)', () => {
  test('parses the full input: an array of FailureSets', () => {
    const valid = {
      sets: [
        {
          tool: 'eslint',
          failures: [
            {
              file: 'src/a.ts',
              line: 5,
              column: 1,
              ruleId: 'prefer-const',
              message: 'm',
              severity: 'error',
            },
          ],
          exitCode: 1,
        },
        { tool: 'eslint', failures: [], exitCode: null },
      ],
    };
    expect(CollectFailuresInputSchema.parse(valid)).toEqual(valid);
  });

  test("an EMPTY sets array is a valid SHAPE — the empty-aggregate policy is the op's `failed`, not the boundary's", () => {
    expect(CollectFailuresInputSchema.parse({ sets: [] })).toEqual({ sets: [] });
  });

  test('rejects sets that do not mirror the gates FailureSet, and smuggled keys', () => {
    expect(CollectFailuresInputSchema.safeParse({ sets: [{ tool: 5 }] }).success).toBe(false);
    expect(
      CollectFailuresInputSchema.safeParse({
        sets: [{ tool: 'eslint', failures: [], exitCode: '0' }],
      }).success,
    ).toBe(false);
    expect(
      CollectFailuresInputSchema.safeParse({
        sets: [],
        cache: true, // a smuggled memoization field must fail loudly (I7)
      }).success,
    ).toBe(false);
    expect(CollectFailuresInputSchema.safeParse({}).success).toBe(false);
  });
});

describe('LedgerViewSchema (the frozen ledger view, mirrored here)', () => {
  test('parses a full view with bounded entries', () => {
    const valid = {
      entries: [{ signature: 'a'.repeat(8), count: 2, component: 'src/ops/analyze' }],
      knownNoise: ['a'.repeat(8)],
      needsHuman: [],
    };
    expect(LedgerViewSchema.parse(valid)).toEqual(valid);
  });

  test('rejects entries outside the ledger record boundary (one definition of the bounds)', () => {
    expect(
      LedgerViewSchema.safeParse({
        entries: [{ signature: '', count: 1 }],
        knownNoise: [],
        needsHuman: [],
      }).success,
    ).toBe(false);
    expect(
      LedgerViewSchema.safeParse({
        entries: [{ signature: 'x', count: 0 }],
        knownNoise: [],
        needsHuman: [],
      }).success,
    ).toBe(false);
    expect(
      LedgerViewSchema.safeParse({
        entries: [{ signature: 'x'.repeat(501), count: 1 }],
        knownNoise: [],
        needsHuman: [],
      }).success,
    ).toBe(false);
    expect(
      LedgerViewSchema.safeParse({
        entries: [{ signature: 'x', count: 1, component: '' }],
        knownNoise: [],
        needsHuman: [],
      }).success,
    ).toBe(false);
  });

  test('rejects a wrong-shaped view and smuggled keys', () => {
    expect(
      LedgerViewSchema.safeParse({ entries: [], knownNoise: {}, needsHuman: [] }).success,
    ).toBe(false);
    expect(
      LedgerViewSchema.safeParse({ entries: [], knownNoise: [], needsHuman: [], extra: 1 }).success,
    ).toBe(false);
  });
});

describe('ClusterErrorsInputSchema (full input, and only it)', () => {
  const VALID = { set: EMPTY_FAILURE_SET };

  test('parses the input with and without the optional ledger view', () => {
    expect(ClusterErrorsInputSchema.parse(VALID)).toEqual(VALID);
    const withLedger = {
      ...VALID,
      ledger: { entries: [], knownNoise: ['sig'], needsHuman: ['sig'] },
    };
    expect(ClusterErrorsInputSchema.parse(withLedger)).toEqual(withLedger);
  });

  test('an explicit ledger null is NOT a view (exactOptional, like the frozen type)', () => {
    expect(ClusterErrorsInputSchema.safeParse({ ...VALID, ledger: null }).success).toBe(false);
  });

  test('rejects a set that does not mirror the FailureSet, and smuggled keys', () => {
    expect(ClusterErrorsInputSchema.safeParse({ set: { failures: [] } }).success).toBe(false);
    expect(ClusterErrorsInputSchema.safeParse({ ...VALID, verdict: 'no-clusters' }).success).toBe(
      false,
    );
  });
});

describe('the G1 importers resolve', () => {
  test('analyze.collectFailures resolves to an op and aggregates through it', async () => {
    const entry = registry.find((candidate) => candidate.name === 'analyze.collectFailures');
    if (!entry) throw new Error('analyze.collectFailures missing from the registry');
    expect(typeof entry.inputSchema).toBe('object');
    const op = await entry.importer();
    expect(typeof op).toBe('function');
    const result = await op({
      sets: [
        { tool: 'eslint', failures: [], exitCode: 0 },
        { tool: 'eslint', failures: [], exitCode: 0 },
      ],
    });
    expect(result).toEqual({
      status: 'ok',
      value: { tool: 'eslint', failures: [], exitCode: 0 },
    });
  });

  test('analyze.clusterErrors resolves to an op and clusters through it', async () => {
    const entry = registry.find((candidate) => candidate.name === 'analyze.clusterErrors');
    if (!entry) throw new Error('analyze.clusterErrors missing from the registry');
    const op = await entry.importer();
    expect(typeof op).toBe('function');
    // The importer's op is erased to Op<unknown, unknown>, so the assertion
    // is over the WHOLE result (the registry-c2 idiom) with the expected
    // cluster spelled out — signature-derived id included.
    const first = {
      file: 'src/a.ts',
      line: 1,
      column: 1,
      ruleId: 'r',
      message: 'boom 1',
      severity: 'error',
    };
    const second = {
      file: 'src/b.ts',
      line: 2,
      column: 1,
      ruleId: 'r',
      message: 'boom 2',
      severity: 'error',
    };
    const signature = JSON.stringify(['eslint', 'r', 'boom <num>']);
    const result = await op({ set: { tool: 'eslint', failures: [first, second], exitCode: 1 } });
    expect(result).toEqual({
      status: 'ok',
      value: {
        clusters: [
          {
            id: fnv1a32Hex(signature),
            signature,
            tool: 'eslint',
            ruleId: 'r',
            confidence: 'high',
            failures: [first, second],
            size: 2,
          },
        ],
        noise: [],
      },
    });
  });
});

describe('the analyze boundary bounds tool/ruleId by ENCODED size (provable signature convergence)', () => {
  // The repo's longest enabled lint rule id — 46 raw chars, ~48 encoded —
  // must pass untouched: a raw-length cap would reject it before either op
  // ran (audit round 1, A1).
  const REAL_RULE_ID = 'typescript/no-non-null-asserted-optional-chain';
  const failureWith = (ruleId: string) => ({
    file: null,
    line: null,
    column: null,
    ruleId,
    message: 'm',
    severity: 'error',
  });

  test('a real 46-char rule id is ACCEPTED on both ops', () => {
    expect(REAL_RULE_ID.length).toBe(46);
    expect(
      CollectFailuresInputSchema.safeParse({
        sets: [{ tool: 'oxlint', failures: [failureWith(REAL_RULE_ID)], exitCode: 1 }],
      }).success,
    ).toBe(true);
    expect(
      ClusterErrorsInputSchema.safeParse({
        set: { tool: 'oxlint', failures: [failureWith(REAL_RULE_ID)], exitCode: 1 },
      }).success,
    ).toBe(true);
  });

  test('a tool whose ENCODING exceeds the bound is rejected on both ops (200 quotes → 402 units)', () => {
    const quoted = '"'.repeat(200);
    expect(
      CollectFailuresInputSchema.safeParse({
        sets: [{ tool: quoted, failures: [], exitCode: 0 }],
      }).success,
    ).toBe(false);
    expect(
      ClusterErrorsInputSchema.safeParse({ set: { tool: quoted, failures: [], exitCode: 1 } })
        .success,
    ).toBe(false);
  });

  test('the encoded bound is exact: 120 encoded units accepted, 121 rejected, message names the bound', () => {
    // 118 raw 'x' chars encode to 120 units (two surrounding quotes); 119
    // raw encode to 121. Both sit far under the loose 500 raw cap — the
    // ENCODED check is what rejects, escape-proof.
    const atBound = 'x'.repeat(ANALYZE_IDENTIFIER_ENCODED_MAX - 2);
    const overBound = 'x'.repeat(ANALYZE_IDENTIFIER_ENCODED_MAX - 1);
    expect(
      ClusterErrorsInputSchema.safeParse({
        set: { tool: atBound, failures: [failureWith(atBound)], exitCode: 1 },
      }).success,
    ).toBe(true);
    for (const [schema, input] of [
      [CollectFailuresInputSchema, { sets: [{ tool: overBound, failures: [], exitCode: 0 }] }],
      [ClusterErrorsInputSchema, { set: { tool: overBound, failures: [], exitCode: 1 } }],
      // Chain symmetry: an over-encoded ruleId is rejected by BOTH ops.
      [
        CollectFailuresInputSchema,
        {
          sets: [{ tool: 'eslint', failures: [failureWith(overBound)], exitCode: 1 }],
        },
      ],
      [
        ClusterErrorsInputSchema,
        { set: { tool: 'eslint', failures: [failureWith(overBound)], exitCode: 1 } },
      ],
    ] as const) {
      const parsed = schema.safeParse(input);
      expect(parsed.success).toBe(false);
      if (parsed.success) continue;
      const issue = parsed.error.issues[0];
      expect(issue === undefined).toBe(false);
      expect(issue?.message).toContain(String(ANALYZE_IDENTIFIER_ENCODED_MAX));
    }
  });

  test('the loose raw cap rejects a 501-char identifier outright', () => {
    expect(
      CollectFailuresInputSchema.safeParse({
        sets: [{ tool: 't'.repeat(501), failures: [], exitCode: 0 }],
      }).success,
    ).toBe(false);
  });

  test('the bound is LOCAL to analyze: the gates FailureSetSchema still accepts an over-bound tool', () => {
    expect(
      FailureSetSchema.safeParse({
        tool: 't'.repeat(ANALYZE_IDENTIFIER_ENCODED_MAX + 1),
        failures: [],
        exitCode: 0,
      }).success,
    ).toBe(true);
  });
});

describe('AnalyzeReportSchema / RenderAnalysisReportInputSchema (full input, and only it)', () => {
  const CLUSTER = {
    id: '0deadbe0',
    signature: '["eslint","r","boom <num>"]',
    tool: 'eslint',
    ruleId: 'r',
    confidence: 'high' as const,
    failures: [
      {
        file: 'src/a.ts',
        line: 1,
        column: 1,
        ruleId: 'r',
        message: 'boom 1',
        severity: 'error' as const,
      },
    ],
    size: 1,
  };

  test('parses the full report input and rejects shape drift and smuggled keys', () => {
    const valid = { report: { clusters: [CLUSTER], noise: [] }, dir: 'ws' };
    expect(RenderAnalysisReportInputSchema.parse(valid)).toEqual(valid);
    expect(
      RenderAnalysisReportInputSchema.safeParse({ ...valid, path: 'convention' }).success,
    ).toBe(false);
    expect(RenderAnalysisReportInputSchema.safeParse({ report: valid.report }).success).toBe(false);
    expect(
      AnalyzeReportSchema.safeParse({
        clusters: [{ ...CLUSTER, id: 'not-hex' }],
        noise: [],
      }).success,
    ).toBe(false);
    expect(
      AnalyzeReportSchema.safeParse({
        clusters: [{ ...CLUSTER, confidence: 'certain' }],
        noise: [],
      }).success,
    ).toBe(false);
    expect(
      AnalyzeReportSchema.safeParse({ clusters: [{ ...CLUSTER, size: 2 }], noise: [] }).success,
    ).toBe(false);
    expect(RenderAnalysisReportInputSchema.safeParse({ ...valid, dir: '' }).success).toBe(false);
  });

  test('analyze.renderAnalysisReport resolves through its importer (the default path-store binding)', async () => {
    const entry = registry.find((candidate) => candidate.name === 'analyze.renderAnalysisReport');
    if (!entry) throw new Error('analyze.renderAnalysisReport missing from the registry');
    const op = await entry.importer();
    expect(typeof op).toBe('function');
    // A missing dir must be a `failed` result, not a throw across the seam.
    const result = await op({ report: { clusters: [], noise: [] }, dir: 'definitely/missing' });
    expect(result.status).toBe('failed');
  });
});

describe('AstGrepCodemodInputSchema / ApplyRemediationInputSchema (full input, and only it)', () => {
  test('the codemod schema: at least one file, non-empty rule, timeout defaulted at this boundary', () => {
    const valid = { dir: 'ws', rule: 'id: r', files: ['src/a.ts'], dryRun: true };
    const parsed = AstGrepCodemodInputSchema.parse(valid);
    expect(parsed).toEqual({ ...valid, timeoutMs: 600_000 });
    expect(AstGrepCodemodInputSchema.safeParse({ ...valid, files: [] }).success).toBe(false);
    expect(AstGrepCodemodInputSchema.safeParse({ ...valid, rule: '' }).success).toBe(false);
    expect(AstGrepCodemodInputSchema.parse({ ...valid, dryRun: false }).timeoutMs).toBe(600_000);
    // A smuggled rule FILE indirection must fail loudly — the rule rides the input.
    expect(AstGrepCodemodInputSchema.safeParse({ ...valid, rulePath: 'r.yml' }).success).toBe(
      false,
    );
  });

  test('the agenticRemediation schema: the frozen driver-seam policy objects ride the kernel mirrors', () => {
    const cluster = {
      id: '0deadbe0',
      signature: '["oxlint","r","boom"]',
      tool: 'oxlint',
      ruleId: 'r',
      confidence: 'low' as const,
      failures: [
        {
          file: 'src/a.ts',
          line: 1,
          column: 1,
          ruleId: 'r',
          message: 'boom',
          severity: 'error' as const,
        },
      ],
      size: 1,
    };
    const valid = {
      clusterId: '0deadbe0',
      cluster,
      modelSpec: { model: 'glm-4.6', provider: 'zai' },
    };
    expect(AgenticRemediationInputSchema.parse(valid)).toEqual(valid);
    // An SDK-model object instead of the plain-data spec is a shape error.
    expect(
      AgenticRemediationInputSchema.safeParse({ ...valid, modelSpec: { model: 5 } }).success,
    ).toBe(false);
    expect(AgenticRemediationInputSchema.safeParse({ ...valid, driver: {} }).success).toBe(false);
  });

  test('the applyRemediation schema: clusterId and approved are OPTIONAL — their ABSENCE is the needs-human refusal', () => {
    const valid = { sidecarPath: 'ws/analysis-x.sidecar.json', rule: 'id: r', dryRun: true };
    const parsed = ApplyRemediationInputSchema.parse(valid);
    expect(parsed).toEqual({ ...valid, timeoutMs: 600_000 });
    // A present-but-empty clusterId is shape noise the boundary rejects; a
    // MISSING one is a decision the op refuses.
    expect(ApplyRemediationInputSchema.safeParse({ ...valid, clusterId: '' }).success).toBe(false);
    expect(
      ApplyRemediationInputSchema.safeParse({ ...valid, clusterId: 'abc12345', approved: 'yes' })
        .success,
    ).toBe(false);
    expect(ApplyRemediationInputSchema.safeParse({ ...valid, store: '/convention' }).success).toBe(
      false,
    );
  });

  test('both importers resolve; the apply op fails CLOSED on a missing sidecar (no scan, no write)', async () => {
    for (const name of ['analyze.astGrepCodemod', 'analyze.applyRemediation']) {
      const entry = registry.find((candidate) => candidate.name === name);
      if (!entry) throw new Error(`${name} missing from the registry`);
      expect(typeof entry.inputSchema).toBe('object');
      const op = await entry.importer();
      expect(typeof op).toBe('function');
    }
    const apply = registry.find((candidate) => candidate.name === 'analyze.applyRemediation');
    if (!apply) throw new Error('analyze.applyRemediation missing from the registry');
    const op = await apply.importer();
    const result = await op({
      sidecarPath: '/nonexistent/analysis-00000000.sidecar.json',
      clusterId: '0deadbe0',
      approved: true,
      rule: 'id: r',
      dryRun: false,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('failed closed');
    }
  });
});

describe('the agentic importer resolves (the subprocess floor lane, composed at the importer)', () => {
  test('analyze.agenticRemediation resolves to an op over a constructed driver (construction spawns nothing)', async () => {
    const entry = registry.find((candidate) => candidate.name === 'analyze.agenticRemediation');
    if (!entry) throw new Error('analyze.agenticRemediation missing from the registry');
    const op = await entry.importer();
    expect(typeof op).toBe('function');
    // The importer's op is erased — assert over the WHOLE result: a MISSING
    // driver would be `failed`, but the registry binds the subprocess floor
    // driver, so a complete scripted... the honest check here is that the
    // wired driver produces the taxonomy mapping, not a fabricated run.
    const cluster = {
      id: '0deadbe0',
      signature: '["oxlint","r","boom"]',
      tool: 'oxlint',
      ruleId: 'r',
      confidence: 'low' as const,
      failures: [
        {
          file: 'src/a.ts',
          line: 1,
          column: 1,
          ruleId: 'r',
          message: 'boom',
          severity: 'error' as const,
        },
      ],
      size: 1,
    };
    const result = await op({
      clusterId: '0deadbe0',
      cluster,
      modelSpec: { model: 'definitely-not-a-model', provider: 'definitely-not-a-provider' },
      // Invocation data only: SubprocessDriver IGNORES Budget.wallClockMs
      // (the governor owns wall clock — I8). The no-hang protection here is
      // the unroutable model (routing throws PRE-dispatch, before any spawn)
      // plus this test's own explicit vitest timeout below.
      budget: { wallClockMs: 5_000 },
    });
    // The real driver runs (no binary/spawn succeeds in the sandbox) — the
    // op must surface that honestly, never as an ok with a fabricated
    // WorkerResult and never as a throw across the seam.
    expect(['failed', 'indeterminate']).toContain(result.status);
  }, 20_000);
});

describe('the applyRemediation signature disambiguator through the registry (Z1)', () => {
  test('the schema accepts the colliding-id input WITH signature and rejects a non-string one', () => {
    const valid = {
      sidecarPath: 'ws/analysis-e6854fd8.sidecar.json',
      clusterId: 'e6854fd8',
      signature: '["eslint","r","tjivlzyj"]',
      approved: true,
      rule: 'id: r',
      dryRun: true,
    };
    expect(ApplyRemediationInputSchema.parse(valid).signature).toBe('["eslint","r","tjivlzyj"]');
    expect(ApplyRemediationInputSchema.safeParse({ ...valid, signature: 7 }).success).toBe(false);
    expect(ApplyRemediationInputSchema.safeParse({ ...valid, signature: '' }).success).toBe(false);
  });

  test('a colliding-pair sidecar dispatched WITHOUT signature fails naming the ambiguity (selection precedes the scan)', async () => {
    const { clusterErrors } = await import('../../../src/ops/analyze/clusterErrors.js');
    const { contentDigest, renderAnalysisReport, serializeAnalysisSidecar } =
      await import('../../../src/ops/analyze/renderAnalysisReport.js');
    const failure = (file: string, message: string) => ({
      file,
      line: 1,
      column: 1,
      ruleId: 'r',
      message,
      severity: 'error' as const,
    });
    // The G1-pinned FNV collision: two distinct signatures, one 32-bit id.
    const report = clusterErrors({
      tool: 'eslint',
      exitCode: 1,
      failures: [failure('src/a.ts', 'tjivlzyj'), failure('src/b.ts', 'qcmqx')],
    });
    const contents: Record<string, string> = {
      'src/a.ts': 'tjivlzyj;\n',
      'src/b.ts': 'qcmqx;\n',
    };
    const evidence = report.clusters.map((cluster) => ({
      clusterId: cluster.id,
      signature: cluster.signature,
      targets: [
        ...new Set(cluster.failures.map((f) => f.file).filter((f): f is string => f !== null)),
      ]
        .sort()
        .map((file) => ({ file, digest: contentDigest(contents[file] as string) })),
    }));
    const sidecarText = serializeAnalysisSidecar(
      renderAnalysisReport(report, { evidence }).sidecar,
    );
    const dir = await mkdtemp(join(tmpdir(), 'analyze-z1-'));
    try {
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src', 'a.ts'), contents['src/a.ts'] as string, 'utf8');
      await writeFile(join(dir, 'src', 'b.ts'), contents['src/b.ts'] as string, 'utf8');
      await writeFile(join(dir, 'analysis-e6854fd8.sidecar.json'), sidecarText, 'utf8');
      const entry = registry.find((candidate) => candidate.name === 'analyze.applyRemediation');
      if (!entry) throw new Error('analyze.applyRemediation missing from the registry');
      const op = await entry.importer();
      const result = await op({
        sidecarPath: join(dir, 'analysis-e6854fd8.sidecar.json'),
        clusterId: 'e6854fd8',
        approved: true,
        rule: 'id: r',
        dryRun: false,
      });
      // The ambiguity fault fires at cluster SELECTION — before the scan —
      // so this dispatch is deterministic without an ast-grep binary.
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toContain("ambiguous cluster id 'e6854fd8'");
        expect(result.error).toContain('pass the cluster');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('the G3 playbook entries (boundary mirrors + the shared-singleton MUST)', () => {
  test('all three importers resolve to ops (the lazy dynamic-import composition path)', async () => {
    for (const name of [
      'analyze.playbookRegister',
      'analyze.playbookDispatch',
      'analyze.playbookQuarantineList',
    ]) {
      const entry = registry.find((candidate) => candidate.name === name);
      if (!entry) throw new Error(`${name} missing from the registry`);
      expect(typeof entry.inputSchema).toBe('object');
      const op = await entry.importer();
      expect(typeof op).toBe('function');
    }
  });

  test('PlaybookDispatchInputSchema: timeoutMs defaults to 600_000 at this boundary; strict on the rest', () => {
    const valid = { playbookId: 'pb', dir: 'ws', targets: ['src/a.ts'] };
    expect(PlaybookDispatchInputSchema.parse(valid)).toEqual({ ...valid, timeoutMs: 600_000 });
    expect(PlaybookDispatchInputSchema.parse({ ...valid, timeoutMs: 5_000 }).timeoutMs).toBe(5_000);
    expect(PlaybookDispatchInputSchema.safeParse({ ...valid, targets: [] }).success).toBe(false);
    expect(PlaybookDispatchInputSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(
      PlaybookDispatchInputSchema.safeParse({ playbookId: '', dir: 'ws', targets: ['src/a.ts'] })
        .success,
    ).toBe(false);
    expect(PlaybookQuarantineListInputSchema.safeParse({}).success).toBe(true);
    expect(PlaybookQuarantineListInputSchema.safeParse({ filter: 'x' }).success).toBe(false);
    // The register boundary carries the strict format schema: a playbook
    // asset with an unknown key is rejected BEFORE the op sees it.
    expect(
      PlaybookRegisterInputSchema.safeParse({
        playbook: {
          schemaVersion: 1,
          id: 'pb',
          description: 'd',
          rule: { language: 'ts' },
          verifier: { command: { command: 'x', args: [] } },
          smuggled: true,
        },
      }).success,
    ).toBe(false);
  });

  test('MUST (shared singletons): a playbook registered through the register entry is visible to a freshly-resolved dispatch entry — re-binding the importers to fresh instances would report an empty population', async () => {
    const registerEntry = registry.find(
      (candidate) => candidate.name === 'analyze.playbookRegister',
    );
    const dispatchEntry = registry.find(
      (candidate) => candidate.name === 'analyze.playbookDispatch',
    );
    if (registerEntry === undefined || dispatchEntry === undefined) {
      throw new Error('playbook entries missing from the registry');
    }
    const register = await registerEntry.importer();
    const registered = await register({
      playbook: {
        schemaVersion: 1,
        id: 'pb-shared-must',
        description: 'pins the shared-singleton MUST across entries',
        rule: { id: 'r', language: 'ts', rule: { pattern: 'zzz_never' } },
        verifier: { command: { command: 'verify-tool', args: [] } },
      },
    });
    expect(registered.status).toBe('ok');
    // A SECOND importer resolution must compose its op over the SAME
    // singletons; an unknown-id dispatch through the fresh op names the
    // population its OWN registry instance sees — 'pb-shared-must' must be
    // in it (registered through the OTHER entry), never '(none)'.
    const dispatch = await dispatchEntry.importer();
    const ghost = (await dispatch({
      playbookId: 'definitely-not-registered',
      dir: '/ws',
      targets: ['src/a.ts'],
    })) as { status: string; error?: string };
    expect(ghost.status).toBe('failed');
    expect(ghost.error ?? '').toContain('registered: pb-shared-must');
    expect(ghost.error ?? '').not.toContain('(none)');
  });

  // The codemod engine scans through the REAL subprocess runner, so this
  // registry-path flow needs an executable 'ast-grep' on PATH; a POSIX
  // shim (shebang script) provides a deterministic empty plan without the
  // real binary. Shebang execution is POSIX-only — the test is conditional
  // on that (the repo's supported test platforms).
  test.runIf(process.platform !== 'win32')(
    'MUST (fail-close across entries): a verifier failure dispatched through the registry path quarantines, a freshly-resolved dispatch entry refuses the re-dispatch, and the list entry sees the record',
    async () => {
      const fixture = await mkdtemp(join(tmpdir(), 'pb-must-'));
      const shimDir = await mkdtemp(join(tmpdir(), 'pb-shim-'));
      const oldPath = process.env.PATH;
      try {
        await mkdir(join(fixture, 'src'), { recursive: true });
        await writeFile(join(fixture, 'src', 'a.ts'), 'export const x = 1;\n', 'utf8');
        await writeFile(
          shimDir + '/ast-grep',
          '#!/usr/bin/env node\nprocess.stdout.write("[]");\n',
          {
            mode: 0o755,
          },
        );
        process.env.PATH = `${shimDir}:${oldPath ?? ''}`;
        const playbook = {
          schemaVersion: 1,
          id: 'pb-must-quarantine',
          description: 'pins the fail-close MUST through the registry path',
          rule: { id: 'r', language: 'ts', rule: { pattern: 'zzz_never' } },
          // The verifier fails FOR REAL (a real node subprocess).
          verifier: { command: { command: process.execPath, args: ['-e', 'process.exit(1)'] } },
        };
        const opOf = async (name: string) => {
          const entry = registry.find((candidate) => candidate.name === name);
          if (entry === undefined) throw new Error(`${name} missing`);
          return entry.importer();
        };
        const register = await opOf('analyze.playbookRegister');
        const registered = (await register({ playbook })) as {
          status: string;
          value?: { id?: string; total?: number };
        };
        expect(registered.status).toBe('ok');
        expect(registered.value?.id).toBe(playbook.id);
        expect(typeof registered.value?.total).toBe('number');
        // Dispatch #1 through a freshly-resolved dispatch entry: the empty
        // plan applies nothing, the verifier FAILS, the playbook quarantines.
        const dispatch = await opOf('analyze.playbookDispatch');
        const first = (await dispatch({
          playbookId: playbook.id,
          dir: fixture,
          targets: ['src/a.ts'],
        })) as { status: string; value?: { outcome?: string; quarantined?: boolean } };
        expect(first.status).toBe('ok');
        expect(first.value?.outcome).toBe('verifier-failed');
        expect(first.value?.quarantined).toBe(true);
        // The list entry — ANOTHER fresh resolution — sees the record (one
        // shared ledger).
        const list = await opOf('analyze.playbookQuarantineList');
        const listed = (await list({})) as {
          status: string;
          value?: { records?: Array<{ playbookId: string }> };
        };
        expect(listed.status).toBe('ok');
        expect(listed.value?.records?.map((record) => record.playbookId)).toContain(playbook.id);
        // Dispatch #2 through ANOTHER fresh resolution: refused before
        // anything runs — the quarantine fails-closes across entries.
        const dispatchAgain = await opOf('analyze.playbookDispatch');
        const second = (await dispatchAgain({
          playbookId: playbook.id,
          dir: fixture,
          targets: ['src/a.ts'],
        })) as { status: string; reason?: string };
        expect(second.status).toBe('needs-human');
        expect(second.reason ?? '').toContain('never re-dispatched automatically');
      } finally {
        process.env.PATH = oldPath;
        await rm(fixture, { recursive: true, force: true });
        await rm(shimDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
