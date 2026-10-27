// R4C closure evidence verifier: a conservative, pure helper over a
// self-described fix packet. A later single-writer integration assembles the
// packet from a pinned revision and maps the verdict onto finding status; this
// module never invokes providers, reads the tree, mutates reports or throws on
// untrusted input. Every failure mode degrades to `uncertain`, which keeps the
// finding open without demanding a code edit.
//
// Verdict vocabulary: `resolved` | `unresolved` | `uncertain`. Only
// `resolved` may close a finding. `unresolved` records concrete
// counter-evidence observed inside the packet (the finding's trigger survives
// the fix). `uncertain` records missing, malformed or unattested evidence,
// including cancellation and budget exhaustion reported through the gate.

export type ClosureVerdict = 'resolved' | 'unresolved' | 'uncertain';

/** Plain finding description; mirrors the producer's finding fields as text. */
export interface VerificationFinding {
  id: string;
  text: string;
  file?: string | undefined;
  line?: number | undefined;
}

/**
 * One cited consumer or dependency with its full content at the packet
 * revision. Paths are literal repository-relative identities; the helper never
 * normalizes, resolves aliases or follows renames.
 */
export interface CitedDependency {
  path: string;
  role: 'consumer' | 'dependency';
  text: string;
}

/** Immutable revision identity the packet's contents were read at. */
export interface RevisionIdentity {
  head: string;
  parent: string;
}

/**
 * The closure evidence packet: plain task text, finding, patch, before/after
 * content and cited dependencies, with the revision identity stored in
 * metadata. `relevantDependenciesComplete` is the assembler's attestation that
 * every relevant consumer and dependency of the changed surface at the pinned
 * revision is supplied. The helper never infers completeness itself: without
 * the attestation the verdict is `uncertain` (omitted consumer/dependency).
 */
export interface ClosurePacket {
  finding: VerificationFinding;
  task: string;
  patch: string;
  before: string;
  after: string;
  dependencies: readonly CitedDependency[];
  relevantDependenciesComplete: boolean;
  metadata: { revision: RevisionIdentity };
}

/**
 * Budget and cancellation gate. The helper calls `admit()` once before each
 * check; a throw (cancellation, budget exhaustion, ownership loss) downgrades
 * the verdict to `uncertain` with the thrown message as the reason. The gate
 * owns that vocabulary; the helper never invents it.
 */
export interface VerificationGate {
  admit: () => void;
}

export type VerificationCheckName =
  | 'packet-complete'
  | 'revision-pinned'
  | 'patch-coherent'
  | 'trigger-removed'
  | 'dependencies-covered';

export interface VerificationCheck {
  check: VerificationCheckName;
  outcome: 'pass' | 'fail' | 'unavailable';
  detail: string;
  /** Present on non-pass outcomes: the stable verdict reason this check contributes. */
  reason?: string | undefined;
}

export interface ClosureVerification {
  verdict: ClosureVerdict;
  reason: string;
  checks: VerificationCheck[];
  /** The packet's revision identity as supplied, retained for evidence. */
  revision: RevisionIdentity | undefined;
}

const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DECLARATION_LINE = new RegExp(
  '^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?' +
    '(?:function\\*?|class|interface|type|enum|const|let|var)\\s+([A-Za-z_$][\\w$]*)',
);
const QUOTED_SPAN = /"([^"\n]{3,200})"|'([^'\n]{3,200})'|`([^`\n]{3,200})`/g;
const DECLARATION_SURVIVAL = (symbol: string): RegExp =>
  new RegExp(
    `(?:function\\*?|class|interface|type|enum|const|let|var)\\s+${escapeRegExp(symbol)}(?![A-Za-z0-9_$])`,
  );
const MAX_SPANS = 8;
const MAX_DECLARATIONS = 16;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Diagnostic reads/coercion are untrusted too; capture once inside the guard. */
function diagnosticOf(error: unknown): { detail: string; reason: string } {
  try {
    if (error instanceof Error) {
      const message: unknown = error.message;
      if (typeof message === 'string') return { detail: message, reason: message };
    } else return { detail: String(error), reason: 'verification gate refused' };
  } catch {
    // A diagnostic failure must not escape the evidence/gate catch path.
  }
  return { detail: 'verification diagnostic unavailable', reason: 'verification gate refused' };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Quoted spans from the finding text: the defect's citable trigger fragments. */
function quotedSpans(text: string): string[] | undefined {
  const spans: string[] = [];
  for (const match of text.matchAll(QUOTED_SPAN)) {
    const span = match[1] ?? match[2] ?? match[3];
    if (span !== undefined) spans.push(span);
    if (spans.length > MAX_SPANS) return undefined;
  }
  return spans;
}

/** Symbols declared on removed patch lines: candidates for surviving triggers. */
function removedDeclarations(removedLines: readonly string[]): string[] | undefined {
  const symbols: string[] = [];
  for (const line of removedLines) {
    const match = DECLARATION_LINE.exec(line);
    const symbol = match?.[1];
    if (symbol !== undefined && !symbols.includes(symbol)) symbols.push(symbol);
    if (symbols.length > MAX_DECLARATIONS) return undefined;
  }
  return symbols;
}

interface PatchShape {
  oldPath: string | undefined;
  newPath: string | undefined;
  addedLines: string[];
  removedLines: string[];
  deletionOnly: boolean;
}

/** Only ordinary single-file unified hunks are supported; no fuzzy application. */
function parsePatchShape(patch: string, before: string, after: string): PatchShape | string {
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let index = 0;
  const diff = lines[index]?.startsWith('diff --git ') ? lines[index++] : undefined;
  if (lines[index]?.startsWith('index ')) {
    if (!/^index [0-9a-f]+\.\.[0-9a-f]+(?: [0-7]{6})?$/.test(lines[index] ?? ''))
      return 'unsupported patch index header';
    index++;
  }
  const oldPath = /^--- a\/(\S+)$/.exec(lines[index++] ?? '')?.[1];
  const newPath = /^\+\+\+ b\/(\S+)$/.exec(lines[index++] ?? '')?.[1];
  if (oldPath === undefined || newPath === undefined) return 'unsupported single-file headers';
  if (oldPath !== newPath) return 'rename patches are not verified yet';
  if (diff !== undefined && diff !== `diff --git a/${oldPath} b/${newPath}`)
    return 'patch file headers disagree';
  // Newline transitions/markers, binary patches, modes and file creation or
  // deletion are unsupported. Preserve the snapshot's existing final newline.
  const trailingNewline = before.endsWith('\n');
  if (trailingNewline !== after.endsWith('\n')) return 'unsupported final newline change';
  const beforeLines = before.split('\n');
  if (trailingNewline) beforeLines.pop();
  const output: string[] = [];
  const addedLines: string[] = [];
  const removedLines: string[] = [];
  let cursor = 0;
  let hunks = 0;
  while (index < lines.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(
      lines[index++] ?? '',
    );
    if (header === null) return 'unsupported or malformed hunk header';
    const oldStart = Number(header[1]);
    const oldCount = Number(header[2] ?? 1);
    const newStart = Number(header[3]);
    const newCount = Number(header[4] ?? 1);
    if (![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger))
      return 'invalid hunk range';
    const oldIndex = oldCount === 0 ? oldStart : oldStart - 1;
    const newIndex = newCount === 0 ? newStart : newStart - 1;
    if (oldIndex < cursor || oldIndex > beforeLines.length) return 'invalid old hunk position';
    output.push(...beforeLines.slice(cursor, oldIndex));
    cursor = oldIndex;
    if (newIndex !== output.length) return 'invalid new hunk position';
    let consumed = 0;
    let produced = 0;
    while (index < lines.length && !lines[index]?.startsWith('@@')) {
      const line = lines[index++] ?? '';
      const marker = line[0];
      const content = line.slice(1);
      if (marker !== ' ' && marker !== '+' && marker !== '-') return 'unsupported hunk content';
      if (marker !== '+') {
        if (cursor >= beforeLines.length || beforeLines[cursor] !== content)
          return 'hunk context or removal does not match before snapshot';
        cursor++;
        consumed++;
      }
      if (marker !== '-') {
        output.push(content);
        produced++;
      }
      if (marker === '+') addedLines.push(content);
      if (marker === '-') removedLines.push(content);
    }
    if (consumed !== oldCount || produced !== newCount) return 'hunk line counts disagree';
    hunks++;
  }
  if (hunks === 0) return 'patch has no change hunks';
  if (addedLines.length === 0 && removedLines.length === 0) return 'patch has no changed lines';
  output.push(...beforeLines.slice(cursor));
  if (output.join('\n') + (trailingNewline ? '\n' : '') !== after)
    return 'applying patch does not produce after snapshot';
  return {
    oldPath,
    newPath,
    addedLines,
    removedLines,
    deletionOnly: removedLines.length > 0 && addedLines.length === 0,
  };
}

/**
 * Verify a closure evidence packet. Order is fixed and each check runs only
 * when every earlier check passed, so the retained check list is always a
 * prefix of the canonical order and the only non-pass entry, if any, is last.
 * Cancellation or budget exhaustion through the gate records an `unavailable`
 * entry carrying the gate's own message and stops the sequence. A
 * deletion-only patch can never resolve on its own.
 */
export function verifyClosureEvidence(
  packet: ClosurePacket,
  gate?: VerificationGate,
): ClosureVerification {
  const checks: VerificationCheck[] = [];
  // The validated dependency records captured by packet-complete; every later
  // check scans this snapshot, never packet.dependencies again, so validation
  // and use always see the same records exactly once each.
  const dependencies: CitedDependency[] = [];
  let stopped = false;
  let revision: RevisionIdentity | undefined;
  try {
    if (
      typeof packet.metadata?.revision?.head === 'string' &&
      typeof packet.metadata.revision.parent === 'string'
    )
      revision = packet.metadata.revision;
  } catch {
    revision = undefined;
  }

  const step = (name: VerificationCheckName, work: () => VerificationCheck): void => {
    if (stopped) return;
    try {
      gate?.admit();
    } catch (error) {
      const diagnostic = diagnosticOf(error);
      checks.push({
        check: name,
        outcome: 'unavailable',
        detail: diagnostic.detail,
        reason: diagnostic.reason,
      });
      stopped = true;
      return;
    }
    try {
      checks.push(work());
    } catch (error) {
      const diagnostic = diagnosticOf(error);
      checks.push({
        check: name,
        outcome: 'unavailable',
        detail: diagnostic.detail,
        reason: 'unavailable-evidence',
      });
    }
    if (checks[checks.length - 1]?.outcome !== 'pass') stopped = true;
  };

  const complete = (): VerificationCheck => {
    const problems: string[] = [];
    if (typeof packet.finding?.id !== 'string' || packet.finding.id === '')
      problems.push('finding.id missing');
    if (typeof packet.finding?.text !== 'string' || packet.finding.text === '')
      problems.push('finding.text missing');
    if (typeof packet.task !== 'string' || packet.task === '') problems.push('task missing');
    if (typeof packet.patch !== 'string' || packet.patch === '') problems.push('patch missing');
    if (typeof packet.before !== 'string' || packet.before === '') problems.push('before missing');
    if (typeof packet.after !== 'string' || packet.after === '') problems.push('after missing');
    // The dependencies DTO must be stable data. The packet property is read
    // exactly once, then every array entry reference is captured before any
    // record field is read, and each field of each record is read exactly
    // once from the captured reference. Nothing is read twice, so no read
    // order can make validation and the later checks see different content.
    // The contract is data-only: a slot or field backed by an accessor
    // (getter on the record itself, or an index accessor on the array) is
    // rejected as unavailable evidence rather than trusted, because closure
    // must never rest on values a host can swap between reads. Missing own
    // data fields reject the same way. A throw escaping any read is caught
    // by the step and recorded as unavailable.
    let supplied: unknown;
    try {
      supplied = packet.dependencies;
    } catch (error) {
      problems.push(`dependencies unavailable: ${diagnosticOf(error).detail}`);
    }
    if (problems.length === 0) {
      // The array check lexically encloses the iteration so the compiler
      // narrows supplied here; problems.length never encodes a type fact.
      if (!Array.isArray(supplied)) problems.push('dependencies is not an array');
      else {
        const entries: unknown[] = [];
        let rejectedAccessor = false;
        for (let index = 0; index < supplied.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(supplied, index);
          if (descriptor === undefined || 'get' in descriptor || 'set' in descriptor) {
            problems.push(`dependency slot ${index} is accessor-backed`);
            rejectedAccessor = true;
            continue;
          }
          entries.push(supplied[index]);
        }
        if (!rejectedAccessor)
          for (const element of entries) {
            if (typeof element !== 'object' || element === null) {
              problems.push('dependency is not an object');
              continue;
            }
            if (
              !Object.prototype.hasOwnProperty.call(element, 'path') ||
              !Object.prototype.hasOwnProperty.call(element, 'role') ||
              !Object.prototype.hasOwnProperty.call(element, 'text')
            ) {
              problems.push('dependency record misses an own data field');
              continue;
            }
            const record = element as Record<string, unknown>;
            const pathDescriptor = Object.getOwnPropertyDescriptor(record, 'path');
            const roleDescriptor = Object.getOwnPropertyDescriptor(record, 'role');
            const textDescriptor = Object.getOwnPropertyDescriptor(record, 'text');
            if (
              pathDescriptor === undefined ||
              'get' in pathDescriptor ||
              'set' in pathDescriptor ||
              roleDescriptor === undefined ||
              'get' in roleDescriptor ||
              'set' in roleDescriptor ||
              textDescriptor === undefined ||
              'get' in textDescriptor ||
              'set' in textDescriptor
            ) {
              problems.push('dependency record field is accessor-backed');
              continue;
            }
            // Data descriptors only: each field value is read exactly once.
            const path: unknown = pathDescriptor.value;
            const role: unknown = roleDescriptor.value;
            const text: unknown = textDescriptor.value;
            if (typeof path !== 'string' || path === '') {
              problems.push('dependency path missing');
              continue;
            }
            if (typeof role !== 'string' || (role !== 'consumer' && role !== 'dependency')) {
              problems.push(`dependency ${path} has unknown role`);
              continue;
            }
            if (typeof text !== 'string' || text === '') {
              problems.push(`dependency ${path} text missing`);
              continue;
            }
            dependencies.push({ path, role, text });
          }
      }
    }
    if (revision === undefined) problems.push('metadata.revision missing');
    if (problems.length > 0)
      return {
        check: 'packet-complete',
        outcome: 'unavailable',
        detail: problems.join('; '),
        reason: 'unavailable-evidence',
      };
    return {
      check: 'packet-complete',
      outcome: 'pass',
      detail: `packet fields present; ${dependencies.length} dependencies captured`,
    };
  };

  const pinned = (): VerificationCheck => {
    if (
      revision === undefined ||
      !SHA_PATTERN.test(revision.head) ||
      !SHA_PATTERN.test(revision.parent) ||
      revision.head === revision.parent
    )
      return {
        check: 'revision-pinned',
        outcome: 'unavailable',
        detail: 'revision identity is not a pinned head over a distinct parent',
        reason: 'unpinned-revision',
      };
    return {
      check: 'revision-pinned',
      outcome: 'pass',
      detail: `revision pinned at ${revision.head}`,
    };
  };

  let deletionOnly = false;
  let removedLines: readonly string[] = [];
  const coherent = (): VerificationCheck => {
    const shape = parsePatchShape(packet.patch, packet.before, packet.after);
    if (typeof shape === 'string')
      return {
        check: 'patch-coherent',
        outcome: 'unavailable',
        detail: shape,
        reason: 'unavailable-evidence',
      };
    const touched = shape.oldPath ?? shape.newPath;
    if (packet.finding.file !== undefined && packet.finding.file !== touched)
      return {
        check: 'patch-coherent',
        outcome: 'unavailable',
        detail: `patch touches ${String(touched)}, finding cites ${packet.finding.file}`,
        reason: 'unavailable-evidence',
      };
    if (packet.before === packet.after)
      return {
        check: 'patch-coherent',
        outcome: 'unavailable',
        detail: 'before and after content are identical',
        reason: 'unavailable-evidence',
      };
    deletionOnly = shape.deletionOnly;
    removedLines = shape.removedLines;
    return {
      check: 'patch-coherent',
      outcome: 'pass',
      detail:
        `patch coherent: +${shape.addedLines.length}/-${shape.removedLines.length}` +
        ` on ${String(touched)}`,
    };
  };

  const trigger = (): VerificationCheck => {
    const spans = quotedSpans(packet.finding.text);
    const symbols = removedDeclarations(removedLines);
    if (spans === undefined || symbols === undefined)
      return {
        check: 'trigger-removed',
        outcome: 'unavailable',
        detail: `trigger evidence exceeds scan limits (${MAX_SPANS} quoted spans, ${MAX_DECLARATIONS} declarations)`,
        reason: 'unavailable-evidence',
      };
    for (const span of spans) {
      if (packet.after.includes(span))
        return {
          check: 'trigger-removed',
          outcome: 'fail',
          detail: `quoted trigger survives in after content: ${oneLine(span)}`,
          reason: 'deleted-trigger-survives',
        };
      for (const dependency of dependencies) {
        if (dependency.text.includes(span))
          return {
            check: 'trigger-removed',
            outcome: 'fail',
            detail:
              `quoted trigger survives in cited ${dependency.role} ` +
              `${dependency.path}: ${oneLine(span)}`,
            reason: 'deleted-trigger-survives',
          };
      }
    }
    for (const symbol of symbols) {
      const redeclared = DECLARATION_SURVIVAL(symbol);
      if (redeclared.test(packet.after))
        return {
          check: 'trigger-removed',
          outcome: 'fail',
          detail: `removed declaration re-declared in after content: ${symbol}`,
          reason: 'deleted-trigger-survives',
        };
      for (const dependency of dependencies) {
        if (redeclared.test(dependency.text))
          return {
            check: 'trigger-removed',
            outcome: 'fail',
            detail:
              `removed declaration still declared in cited ${dependency.role} ` +
              `${dependency.path}: ${symbol}`,
            reason: 'deleted-trigger-survives',
          };
      }
    }
    // Removed declarations can supply counter-evidence, but their removal
    // alone does not link the patch to the finding's actual trigger.
    if (spans.length === 0)
      return {
        check: 'trigger-removed',
        outcome: 'unavailable',
        detail:
          'finding carries no quoted trigger span; removed declarations alone do not establish finding-linked trigger evidence',
        reason: 'no-citable-trigger',
      };
    return {
      check: 'trigger-removed',
      outcome: 'pass',
      detail: `no survival of ${spans.length} quoted spans, ${symbols.length} removed declarations`,
    };
  };

  const covered = (): VerificationCheck => {
    if (deletionOnly)
      return {
        check: 'dependencies-covered',
        outcome: 'unavailable',
        detail: 'a deleted line alone cannot establish closure',
        reason: 'deleted-line-alone',
      };
    if (packet.relevantDependenciesComplete !== true)
      return {
        check: 'dependencies-covered',
        outcome: 'unavailable',
        detail: 'relevant consumer/dependency completeness is not attested for the changed surface',
        reason: 'omitted-consumer-or-dependency',
      };
    return {
      check: 'dependencies-covered',
      outcome: 'pass',
      detail:
        `packet attests ${dependencies.length} cited dependencies ` +
        'complete at the pinned revision',
    };
  };

  step('packet-complete', complete);
  step('revision-pinned', pinned);
  step('patch-coherent', coherent);
  step('trigger-removed', trigger);
  step('dependencies-covered', covered);

  const last = checks[checks.length - 1];
  if (last === undefined)
    return { verdict: 'uncertain', reason: 'unavailable-evidence', checks, revision };
  const allPass = checks.length === 5 && checks.every((entry) => entry.outcome === 'pass');
  if (allPass)
    return {
      verdict: 'resolved',
      reason: 'closure-evidence-complete',
      checks,
      revision,
    };
  if (last.outcome === 'fail')
    return {
      verdict: 'unresolved',
      reason: last.reason ?? 'deleted-trigger-survives',
      checks,
      revision,
    };
  return { verdict: 'uncertain', reason: last.reason ?? 'unavailable-evidence', checks, revision };
}
