// Analyze lane G2 — the analysis REPORT pair: a human-readable markdown
// rendering plus the JSON SIDECAR that is the machine source of truth for
// remediation (the sidecar-drives-remediation contract, UC §1 rows 8–9).
// The markdown is presentation; the sidecar is evidence — `applyRemediation`
// reads the sidecar, never the markdown.
//
// Invariants honored here:
//   - Determinism (the acceptance property): the pure core
//     {@link renderAnalysisReport} is a pure function of (report, meta) —
//     stable ordering carried in from the G1 report (clusters by id,
//     members/noise by exact identity), NO timestamps anywhere in the
//     content, and the report fingerprint is FNV-1a 32-bit over the
//     canonical report JSON ({@link reportFingerprint}, the G1 hashing
//     approach: the report's own deterministic ordering makes plain
//     JSON.stringify canonical, exactly as clusterSignature relies on its
//     tuple order). The same report and evidence render byte-identical
//     markdown and sidecar every time.
//   - The sidecar path is an OP OUTPUT, never a convention: the op writes
//     into the caller's directory under a DETERMINISTIC, content-derived
//     name derived from the report fingerprint
//     (`analysis-<fingerprint>.md` / `analysis-<fingerprint>.sidecar.json`)
//     and returns both paths. No hardcoded location exists anywhere in the
//     family.
//   - Fail-closed on a missing/unreadable target: the render op digests
//     every cluster member's file (the remediation targets — noise files
//     are never remediated and are deliberately NOT digested) through the
//     injected store at ANALYSIS time, and any read fault is a `failed`
//     result naming the file — an analysis that cannot digest its own
//     targets must not publish a sidecar whose staleness checks would
//     silently pass.
//   - Digest honesty: the per-file digest is FNV-1a 32-bit over the file's
//     decoded UTF-8 text ({@link contentDigest}). It is a STALENESS CHECK,
//     not an identity proof: a 32-bit digest collides across contents with
//     probability ~2⁻³² per comparison, so applyRemediation treats a digest
//     match as "unchanged in the coarsely-hashed sense". The residual harm
//     of a collision is bounded by the codemod path's shape-match (an edit
//     only lands where the consumer's ast-grep rule still matches the
//     CURRENT bytes) and by the collision check — the digest guards gross
//     drift, never fine identity.
//   - Strict sidecar parse with the COVERAGE CONTRACT: {@link
//     parseAnalysisSidecar} accepts only a valid version-1 sidecar, re-derives
//     the report fingerprint from the embedded report, and requires FULL
//     evidence coverage — every report cluster must carry an evidence entry
//     whose target set EQUALS its derived deduplicated-sorted member-file set
//     (all-null-file members → an empty evidence entry is valid) — so a
//     hand-edited, truncated, or partial sidecar (wrong version, drifted
//     report, missing or mismatched evidence) is a format error, never a
//     silent disabling of staleness checking. The deliberate consequence:
//     the PURE CORE's meta-less output (renderAnalysisReport(report) →
//     evidence: []) is NOT appliable as-is — it needs the op (which derives
//     full coverage) or an explicit coverage validation before it can drive
//     applyRemediation. Evidence CONTENT is trusted because it is anchored by
//     this check (the target set is provably the report's, and the report is
//     pinned by the fingerprint — evidence is deliberately NOT in the
//     fingerprint); the analysis-time digests are the one trusted observation,
//     and the codemod shape-match bounds the harm of a forged pair. This
//     mirrors the ledger store's parseLedger discipline: the deterministic
//     format is load-bearing.
//   - The op performs I/O only through the injected
//     {@link AnalyzeFileStore}; the pure core stays importable without it.
//     Unlike the ledger family's separate pure format module, the sidecar
//     format lives HERE beside the op that publishes it (the family's only
//     sidecar writer and reader are this module and applyRemediation) — the
//     z.ZodType annotations pin the parse to the TypeScript types, so a
//     shape drift fails typecheck.
import { join } from 'node:path';
import { z } from 'zod';
import type { Op } from '../../kernel/types.js';
import type { CheckFailure } from '../gates/checkRunner.js';
import { fnv1a32Hex } from '../gates/fingerprint.js';
import { SIGNATURE_MAX_CHARS } from '../ledger/ledger.js';
import type { Cluster, ClusterErrorsReport } from './clusterErrors.js';
import type { AnalyzeFileStore } from './analysisStore.js';

/** The sidecar schema version — the only one {@link parseAnalysisSidecar} accepts. */
export const ANALYSIS_SIDECAR_SCHEMA_VERSION = 1;

/**
 * The per-target-file evidence captured at ANALYSIS time: the file path
 * (verbatim from the cluster member failures, the same string applyRemediation
 * re-resolves through the store) and its {@link contentDigest} at analysis
 * time. This is what makes a stale sidecar detectable instead of assumed.
 */
export interface AnalysisTargetDigest {
  file: string;
  digest: string;
}

/**
 * Per-cluster evidence: the deduplicated, sorted target files of ONE
 * cluster, keyed by the (clusterId, signature) PAIR — two DISTINCT
 * signatures can share an FNV-1a 32-bit id (a pinned collision exists in
 * the G1 tests), so the id alone cannot address a cluster's evidence.
 */
export interface ClusterEvidence {
  clusterId: string;
  /** The cluster's canonical signature — the disambiguating half of the evidence key. */
  signature: string;
  targets: AnalysisTargetDigest[];
}

/** The published sidecar: schema version, content fingerprint, the report, and the analysis-time evidence. */
export interface AnalysisSidecar {
  schemaVersion: typeof ANALYSIS_SIDECAR_SCHEMA_VERSION;
  /** FNV-1a 32-bit over the canonical report JSON ({@link reportFingerprint}). */
  reportFingerprint: string;
  /** The G1 clustering report — the semantic payload the sidecar exists to carry. */
  report: ClusterErrorsReport;
  /** Per-cluster analysis-time target digests — the staleness anchor for apply. */
  evidence: ClusterEvidence[];
}

/** Optional pure-core input: the analysis-time evidence, when it exists. */
export interface RenderAnalysisMeta {
  /** Per-cluster target digests; omitted (or empty) renders an evidence-free sidecar. */
  evidence?: readonly ClusterEvidence[];
}

/** What the pure core returns: the presentation and the machine truth. */
export interface RenderedAnalysis {
  /** Deterministic human-readable markdown. Presentation only — never parsed by the family. */
  markdown: string;
  /** The machine source of truth for remediation, serialized verbatim by the op. */
  sidecar: AnalysisSidecar;
}

/**
 * FNV-1a 32-bit over the canonical report JSON — the content-derived handle
 * shared by the sidecar, the deterministic file names, and the op result.
 * Canonicality rides the G1 report's own determinism (fixed key construction
 * order, clusters sorted by id, members/noise by exact identity), so the
 * same clustering hashes the same in any presentation order — the same
 * approach as clusterSignature's tuple hashing.
 */
export function reportFingerprint(report: ClusterErrorsReport): string {
  return fnv1a32Hex(JSON.stringify(report));
}

/**
 * The staleness digest of one target file: FNV-1a 32-bit over the decoded
 * UTF-8 text. Deliberately coarse — a staleness CHECK, not an identity
 * proof (see the module header's digest-honesty invariant).
 */
export function contentDigest(text: string): string {
  return fnv1a32Hex(text);
}

/** The deterministic file name of the markdown rendering for one report fingerprint. */
export function markdownFileName(reportFingerprint: string): string {
  return `analysis-${reportFingerprint}.md`;
}

/** The deterministic file name of the sidecar for one report fingerprint. */
export function sidecarFileName(reportFingerprint: string): string {
  return `analysis-${reportFingerprint}.sidecar.json`;
}

/**
 * Render one G1 report into the markdown + sidecar pair. Pure: no I/O, no
 * clocks. Ordering is inherited from the report (already deterministic);
 * evidence clusters are rendered in the given order, and the op passes them
 * in report-cluster (id) order.
 */
export function renderAnalysisReport(
  report: ClusterErrorsReport,
  meta?: RenderAnalysisMeta,
): RenderedAnalysis {
  const fingerprint = reportFingerprint(report);
  const evidence = meta?.evidence ?? [];
  const sidecar: AnalysisSidecar = {
    schemaVersion: ANALYSIS_SIDECAR_SCHEMA_VERSION,
    reportFingerprint: fingerprint,
    report,
    evidence: evidence.map((cluster) => ({ ...cluster })),
  };
  return { markdown: renderMarkdown(report), sidecar };
}

/**
 * The deterministic markdown rendering. Line-oriented, no timestamps: a
 * summary block (counts), one section per cluster in report order (id,
 * tool, rule, confidence, member count, canonical signature, members), and
 * the separately-reported ledger noise. Every failure line is
 * `file:line:col [severity] rule: message` with `-` for absent fields —
 * the exact identity a human needs to find the failure, nothing more.
 */
function renderMarkdown(report: ClusterErrorsReport): string {
  const lines: string[] = [];
  const members = report.clusters.reduce((sum, cluster) => sum + cluster.size, 0);
  lines.push('# Analysis report', '');
  lines.push(`clusters: ${report.clusters.length}`);
  lines.push(`members: ${members}`);
  lines.push(`noise: ${report.noise.length}`, '');
  for (const cluster of report.clusters) {
    lines.push(`## cluster ${cluster.id} (confidence: ${cluster.confidence})`, '');
    lines.push(`- tool: ${cluster.tool}`);
    lines.push(`- ruleId: ${cluster.ruleId ?? '-'}`);
    lines.push(`- members: ${cluster.size}`);
    lines.push(`- signature: ${cluster.signature}`, '');
    lines.push('### members', '');
    for (const failure of cluster.failures) {
      lines.push(`- ${failureLine(failure)}`);
    }
    lines.push('');
  }
  if (report.noise.length > 0) {
    lines.push('## noise', '');
    for (const failure of report.noise) {
      lines.push(`- ${failureLine(failure)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** One deterministic failure line; null fields render as `-`. */
function failureLine(failure: CheckFailure): string {
  return `${failure.file ?? '-'}:${failure.line ?? '-'}:${failure.column ?? '-'} [${failure.severity}] ${failure.ruleId ?? '-'}: ${failure.message}`;
}

/** Thrown by {@link parseAnalysisSidecar} on any violation of the sidecar format. */
export class SidecarFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SidecarFormatError';
  }
}

/** 8 lowercase hex digits — the FNV-1a 32-bit form used by ids and digests. */
const Hex8 = z.string().regex(/^[0-9a-f]{8}$/, 'expected 8 lowercase hex digits');

const SidecarFailureSchema: z.ZodType<CheckFailure> = z
  .object({
    file: z.string().nullable(),
    line: z.number().nullable(),
    column: z.number().nullable(),
    // No identifier caps here, deliberately: the apply path never trusts
    // these strings as names for anything but matching and containment-
    // checked file resolution (see the module header's parse-strictness
    // invariant), so a length bound would only reject sidecars that
    // library-level reports may legitimately contain.
    ruleId: z.string().nullable(),
    message: z.string(),
    severity: z.enum(['error', 'warning']),
  })
  .strict();

const SidecarClusterSchema: z.ZodType<Cluster> = z
  .object({
    id: Hex8,
    signature: z.string().min(1).max(SIGNATURE_MAX_CHARS),
    tool: z.string(),
    ruleId: z.string().nullable(),
    confidence: z.enum(['high', 'medium', 'low']),
    failures: z.array(SidecarFailureSchema),
    size: z.number().int().min(1),
  })
  .strict()
  // A corrupt sidecar whose size disagrees with its member list would make
  // planned-edit counts unverifiable — rejected here, not diagnosed later.
  .refine((cluster) => cluster.size === cluster.failures.length, {
    message: 'size must equal failures.length',
  });

const SidecarReportSchema: z.ZodType<ClusterErrorsReport> = z
  .object({
    clusters: z.array(SidecarClusterSchema),
    noise: z.array(SidecarFailureSchema),
  })
  .strict();

const AnalysisSidecarSchema: z.ZodType<AnalysisSidecar> = z
  .object({
    schemaVersion: z.literal(ANALYSIS_SIDECAR_SCHEMA_VERSION),
    reportFingerprint: Hex8,
    report: SidecarReportSchema,
    evidence: z.array(
      z
        .object({
          clusterId: Hex8,
          // The disambiguating half of the evidence key: two distinct
          // signatures can share an FNV id (G1's pinned collision).
          signature: z.string().min(1).max(SIGNATURE_MAX_CHARS),
          targets: z.array(
            z
              .object({
                file: z.string().min(1),
                digest: Hex8,
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict()
  // The fingerprint is re-derived, never trusted: a sidecar whose report was
  // edited without updating the fingerprint is a format error (the same
  // fail-closed discipline as the ledger's strict parse).
  .refine((sidecar) => sidecar.reportFingerprint === reportFingerprint(sidecar.report), {
    message: 'reportFingerprint does not match the embedded report',
  })
  .refine(
    (sidecar) => {
      const pairs = new Set(
        sidecar.report.clusters.map((cluster) => `${cluster.id}\u0000${cluster.signature}`),
      );
      return sidecar.evidence.every((cluster) =>
        pairs.has(`${cluster.clusterId}\u0000${cluster.signature}`),
      );
    },
    { message: 'evidence names a (cluster id, signature) pair absent from the report' },
  )
  // COVERAGE CONTRACT: absence of evidence is a FORMAT ERROR, never a silent
  // disabling of staleness checking. Every report cluster must carry an
  // evidence entry whose target set EQUALS the cluster's derived
  // deduplicated, sorted member-file set (a cluster whose members all lack
  // files is legitimately covered by an empty entry). The digests themselves
  // are analysis-time observations and cannot be re-derived, so they are
  // trusted ANCHORED by this check: the target SET is provably the report's,
  // and the report is pinned by the fingerprint — a forged digest pair can
  // only change what counts as "unchanged", and the codemod shape-match
  // bounds that harm.
  .superRefine((sidecar, ctx) => {
    // Keyed by the (id, signature) PAIR: two distinct signatures can share
    // an FNV id (G1 pins a concrete pair), so an id-keyed map collapses them
    // last-wins and under-covers one cluster.
    const byPair = new Map(
      sidecar.evidence.map((entry) => [
        `${entry.clusterId}\u0000${entry.signature}`,
        entry.targets,
      ]),
    );
    for (const cluster of sidecar.report.clusters) {
      const expected = [
        ...new Set(
          cluster.failures
            .map((failure) => failure.file)
            .filter((file): file is string => file !== null),
        ),
      ].sort();
      const actual = byPair.get(`${cluster.id}\u0000${cluster.signature}`);
      if (actual === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidence'],
          message: `evidence does not cover cluster ${cluster.id} (absence never silently disables staleness checking)`,
        });
        continue;
      }
      const actualFiles = actual.map((target) => target.file);
      const matches =
        expected.length === actualFiles.length &&
        expected.every((file, index) => file === actualFiles[index]);
      if (!matches) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidence'],
          message: `evidence targets for cluster ${cluster.id} do not equal its member files (expected: ${expected.join(', ') || '(none)'}; got: ${actualFiles.join(', ') || '(none)'})`,
        });
      }
    }
  });

/**
 * Parse and validate sidecar text; throws {@link SidecarFormatError} on any
 * schema violation (wrong/missing schemaVersion, drifted report vs
 * fingerprint, evidence naming an unknown cluster) — the strict entry for
 * anything read back, and the ONLY way applyRemediation accepts a sidecar.
 */
export function parseAnalysisSidecar(text: string): AnalysisSidecar {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new SidecarFormatError(`analysis sidecar: not valid JSON — ${(err as Error).message}`);
  }
  const parsed = AnalysisSidecarSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new SidecarFormatError(
      `analysis sidecar: schema violation (expected schemaVersion ${ANALYSIS_SIDECAR_SCHEMA_VERSION}) — ${issues}`,
    );
  }
  return parsed.data;
}

/** Deterministic sidecar serialization: 2-space indent, exactly one trailing newline. */
export function serializeAnalysisSidecar(sidecar: AnalysisSidecar): string {
  return `${JSON.stringify(sidecar, null, 2)}\n`;
}

/** JSON-serializable input of the `analyze.renderAnalysisReport` op. */
export interface RenderAnalysisReportInput {
  /** The G1 clustering report to publish. */
  report: ClusterErrorsReport;
  /** The EXISTING directory to wrap the pair into (never created, never escaped). */
  dir: string;
}

/** The op's report: where the pair landed, keyed by the content fingerprint. */
export interface RenderedAnalysisPaths {
  markdownPath: string;
  sidecarPath: string;
  reportFingerprint: string;
}

/**
 * Build the `analyze.renderAnalysisReport` op over an input-driven store
 * selector (the ledger lane's registry-bound store pattern). Per call:
 * verify `dir` exists (a missing directory is `failed` — the op wraps an
 * existing directory, it never mkdir -p), digest every cluster member's
 * target file through the store (a read fault is `failed` naming the file —
 * see the module header), render the pure pair, and write the sidecar first
 * (the source of truth) then the markdown under deterministic
 * fingerprint-derived names. Everything is derived from (report, dir): the
 * same inputs land the same bytes at the same paths.
 */
export function makeRenderAnalysisReport(
  storeFor: (input: RenderAnalysisReportInput) => AnalyzeFileStore,
): Op<RenderAnalysisReportInput, RenderedAnalysisPaths> {
  return async (input) => {
    let store: AnalyzeFileStore;
    try {
      store = storeFor(input);
    } catch (err) {
      return { status: 'failed', error: messageOf(err) };
    }
    // STORE-RELATIVE PATH DISCIPLINE: the store is ROOTED AT input.dir (the
    // registry binds pathAnalysisFileStore(input.dir)), so every path handed
    // to the store must be relative to that root — the root check is '.'
    // (not input.dir, which would double-root to dir/dir) and the writes
    // carry the bare file names. The RETURNED paths stay joined with
    // input.dir: they are caller-facing, not store-relative.
    if (!(await store.isDirectory('.'))) {
      return {
        status: 'failed',
        error: `analysis report: directory does not exist: '${input.dir}' — the op wraps an existing directory, it never creates one`,
      };
    }
    // Analysis-time evidence: deduplicate each cluster's member file paths
    // (many members share one target file), keep them sorted, and digest
    // the CURRENT bytes. A file that cannot be read fails the op — a
    // sidecar with unverifiable targets must not exist (module header).
    const evidence: ClusterEvidence[] = [];
    try {
      for (const cluster of input.report.clusters) {
        const files = [...new Set(cluster.failures.map((failure) => failure.file))].filter(
          (file): file is string => file !== null,
        );
        files.sort();
        const targets: AnalysisTargetDigest[] = [];
        for (const file of files) {
          const bytes = await store.readBytes(file);
          targets.push({ file, digest: contentDigest(Buffer.from(bytes).toString('utf8')) });
        }
        evidence.push({ clusterId: cluster.id, signature: cluster.signature, targets });
      }
    } catch (err) {
      return {
        status: 'failed',
        error: `analysis report: could not digest a cluster target — ${messageOf(err)}`,
      };
    }
    const rendered = renderAnalysisReport(input.report, { evidence });
    // Caller-facing output paths (an op OUTPUT, never a convention): joined
    // with the caller's dir. The bytes land through the store under the BARE
    // names (store-relative — see the discipline note above).
    const sidecarPath = join(input.dir, sidecarFileName(rendered.sidecar.reportFingerprint));
    const markdownPath = join(input.dir, markdownFileName(rendered.sidecar.reportFingerprint));
    // Partial pair writes are never silent: a markdown fault after the
    // sidecar landed names the already-landed path(s) (the same discipline
    // as the codemod path's partial-apply reporting).
    const landed: string[] = [];
    try {
      await store.writeBytes(
        sidecarFileName(rendered.sidecar.reportFingerprint),
        Buffer.from(serializeAnalysisSidecar(rendered.sidecar), 'utf8'),
      );
      landed.push(sidecarPath);
      await store.writeBytes(
        markdownFileName(rendered.sidecar.reportFingerprint),
        Buffer.from(rendered.markdown, 'utf8'),
      );
      landed.push(markdownPath);
    } catch (err) {
      const alreadyWritten = landed.length === 0 ? '' : `; already written: ${landed.join(', ')}`;
      return {
        status: 'failed',
        error: `analysis report: could not write the report pair — ${messageOf(err)}${alreadyWritten}`,
      };
    }
    return {
      status: 'ok',
      value: {
        markdownPath,
        sidecarPath,
        reportFingerprint: rendered.sidecar.reportFingerprint,
      },
    };
  };
}

// No default export here, deliberately: like the ledger family's make*
// ops, the registry importer COMPOSES this op from the named factory plus
// the dynamically-imported path store (the registry-bound store seam), and
// tests/library consumers inject their own store through the factory.

/** Error message of an unknown throwable, for `failed` results. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
