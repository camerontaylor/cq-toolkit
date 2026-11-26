/** Inactive general review scan orchestration. No production matcher or gitleaks binding. */
import { parseDenylistPatterns } from '../ops/dev/denylist.js';
import { pythonSplitlines } from '../policy/crq/repairGates.js';
import { atomicJsonText } from '../policy/crq/pythonJson.js';
import { ReviewScanRefusal, type ReviewScanDecision } from './reviewPreparation.js';
import { EXEMPTIBLE_RULES, exemptReason, type ScanExemption } from './scanExemptions.js';

const universal = [
  'class:token-ssh-plumbing',
  'class:route-key-material',
  'class:key-material-env',
  'class:inline-secret-assignments',
];
const allow = [
  /(^|\/)\.git\//,
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)\.gjc\//,
  /(^|\/)\.DS_Store$/,
  /^policy\/denylist\/patterns\.yml$/,
];
/** Git's C-quote letter escapes (quote.c); every other unusual byte is `\NNN` octal. */
const gitQuoteEscapes: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  '\\': 0x5c,
  '"': 0x22,
};
const utf8 = new TextEncoder();

/**
 * Decode git's C-quoted pathname form (`core.quotePath`): git wraps a header
 * path carrying a tab, quote, backslash or non-ASCII byte in double quotes and
 * escapes `\\`, `\"`, the C control letters, and every other unusual byte as
 * `\NNN` octal. The quoted text is not the path, so a path-scoped rule would
 * test the escapes instead of the name and miss the file's lines. A quoted
 * form that does not decode cleanly throws: a path the scan cannot name is
 * content it cannot attribute.
 */
function decodeGitPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const inner = raw.slice(1, -1);
  const bytes: number[] = [];
  let index = 0;
  while (index < inner.length) {
    const ch = inner[index] as string;
    if (ch !== '\\') {
      const code = inner.codePointAt(index) as number;
      // Literal non-ASCII inside the quotes is git's core.quotePath=false
      // form; re-encode it so literal UTF-8 and octal escapes mix losslessly.
      if (code > 0x7f) {
        const point = String.fromCodePoint(code);
        for (const b of utf8.encode(point)) bytes.push(b);
        index += point.length;
        continue;
      }
      bytes.push(code);
      index += 1;
      continue;
    }
    const next = inner[index + 1];
    const letter = next === undefined ? undefined : gitQuoteEscapes[next];
    if (letter !== undefined) {
      bytes.push(letter);
      index += 2;
      continue;
    }
    const octal = /^\\([0-7]{3})/.exec(inner.slice(index));
    if (octal === null) throw new ReviewScanRefusal('undecodable review scan path');
    bytes.push(parseInt(octal[1] as string, 8));
    index += 4;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    throw new ReviewScanRefusal('undecodable review scan path');
  }
}

/** Drop the pinned `a/` or `b/` diff prefix from a decoded path. */
function withoutDiffPrefix(value: string): string {
  return value.startsWith('a/') || value.startsWith('b/') ? value.slice(2) : value;
}

/**
 * The b-side path of a `diff --git` header. Git quotes a name that needs it,
 * so a quoted b-side field is decoded before the prefix strip — the separator
 * is the last space from which a whole quoted string runs to end of line,
 * which keeps spaces inside the quotes intact. The unquoted form stays as it
 * was: git leaves spaces bare there, and the greedy a-side ends at the last
 * ` b/` boundary.
 */
function diffGitPath(line: string): string | null {
  const rest = line.slice('diff --git '.length);
  const quoted = /^.* ("(?:[^"\\]|\\.)*")$/s.exec(rest);
  if (quoted !== null) return withoutDiffPrefix(decodeGitPath(quoted[1] as string));
  return /^a\/(.*) b\/(.*)$/s.exec(rest)?.[2] ?? null;
}

export interface ReviewScannerEffects {
  /** Compile all rules, then return strictly ordered [line, rule] matches, or throw. */
  match(input: {
    rules: readonly { regex: string; path: string | null }[];
    lines: readonly { path: string; text: string }[];
  }): Promise<readonly (readonly [number, number])[]>;
  /** Missing binary is explicit. Errors or missing reports cannot become clean. */
  gitleaks(diff: string): Promise<
    | { kind: 'not-run' }
    | {
        kind: 'exit';
        code: number;
        hits: readonly { rule: string | null; diffLine: number | null }[] | null;
      }
  >;
  /** Persist exact redacted report before returning a decision. */
  writeReport(text: string): Promise<void>;
}
export async function scanReviewDiff(
  input: {
    patternsText: string;
    diff: string;
    base: string | null;
    head: string | null;
    foreign: boolean;
    extraClasses: readonly string[];
    artifactPath: string;
    /** Base-commit exemptions; absent means none. */
    exemptions?: readonly ScanExemption[];
    exemptionError?: string | null;
  },
  effects: ReviewScannerEffects,
): Promise<ReviewScanDecision> {
  if (!input.artifactPath) throw new Error('missing scan artifact path');
  const parsed = parseDenylistPatterns(input.patternsText, 'denylist patterns');
  const classes = input.foreign ? new Set([...universal, ...input.extraClasses]) : null;
  if (classes) {
    for (const name of classes)
      if (!parsed.rules.some((rule) => rule.id === name))
        throw new Error(`unknown scan class: ${name}`);
  }
  const selected = classes ? parsed.rules.filter((rule) => classes.has(rule.id)) : parsed.rules;
  if (!selected.length) throw new Error('empty scan class set');
  const rules = selected.map((rule) => ({
    id: rule.id,
    regex: rule.regex,
    path: rule.path ?? null,
  }));
  const hits: { rule: string; file: string; diff_line: number }[] = [];
  const exempted: { rule: string; file: string; diff_line: number; reason: string }[] = [];
  const candidates: { path: string; text: string; diffLine: number }[] = [];
  let path: string | null = null;
  let header = false;
  const handle = (line: string, diffLine: number, physicalStart = true): void => {
    // Only a physical patch record can open a file section; a logical fragment
    // split out of hunk content (after U+2028 and similar) is never a header.
    if (physicalStart && line.startsWith('diff --git')) {
      path = diffGitPath(line);
      header = true;
      return;
    }
    if (line.startsWith('@@')) {
      header = false;
      return;
    }
    if (header) {
      if (line.startsWith('+++ ') || line.startsWith('--- ')) {
        // Git appends one literal tab to an unquoted label that holds a space;
        // drop only that, never a filename's own spaces or escaped tabs.
        const raw = line.slice(4);
        const next = raw.endsWith('\t') ? raw.slice(0, -1) : raw;
        if (next !== '/dev/null') path = withoutDiffPrefix(decodeGitPath(next));
      }
      return;
    }
    if (!line || (line[0] !== '+' && line[0] !== '-') || path === null) return;
    const currentPath = path;
    if (allow.some((p) => p.test(currentPath))) return;
    candidates.push({ path, text: line.slice(1), diffLine });
  };
  // Headers and file labels split on physical patch lines only, so a literal
  // U+2028 in a filename survives until the path is decoded and matched.
  // Hunk content keeps Python splitlines and its line numbering.
  const physical = input.diff.split(/\r\n|\n|\r/);
  let counted = 0;
  for (const [index, piece] of physical.entries()) {
    const last = index === physical.length - 1;
    // A piece ending in a logical-only terminator (U+2028, ...) keeps the empty
    // logical line its physical LF then closes, as Python splitlines does.
    const gap =
      last || piece === ''
        ? 0
        : pythonSplitlines(`${piece}\n`).length - pythonSplitlines(piece).length;
    if (header || piece.startsWith('diff --git')) {
      handle(piece, counted + 1);
      counted += (piece === '' ? (last ? 0 : 1) : pythonSplitlines(piece).length) + gap;
    } else if (piece === '') {
      if (!last) counted += 1;
    } else {
      for (const [at, sub] of pythonSplitlines(piece).entries()) {
        counted += 1;
        handle(sub, counted, at === 0);
      }
      counted += gap;
    }
  }
  try {
    const matches = await effects.match({ rules, lines: candidates });
    if (!Array.isArray(matches)) throw new Error('invalid matcher result');
    let previous = -1;
    for (const pair of matches as unknown[]) {
      if (!Array.isArray(pair) || pair.length !== 2) throw new Error('invalid matcher result');
      const lineIndex: unknown = pair[0];
      const ruleIndex: unknown = pair[1];
      if (typeof lineIndex !== 'number' || typeof ruleIndex !== 'number')
        throw new Error('invalid matcher result');
      const candidate = candidates[lineIndex];
      const rule = rules[ruleIndex];
      const order = lineIndex * rules.length + ruleIndex;
      if (
        !Number.isSafeInteger(lineIndex) ||
        !Number.isSafeInteger(ruleIndex) ||
        !candidate ||
        !rule ||
        order <= previous
      )
        throw new Error('invalid matcher result');
      previous = order;
      const hit = { rule: rule.id, file: candidate.path, diff_line: candidate.diffLine };
      const reason = exemptReason(input.exemptions, rule.id, candidate.path);
      if (reason === null) hits.push(hit);
      else exempted.push({ ...hit, reason });
    }
  } catch {
    throw new Error('review scan matcher unavailable');
  }
  let gl: Awaited<ReturnType<ReviewScannerEffects['gitleaks']>>;
  try {
    gl = await effects.gitleaks(input.diff);
  } catch {
    throw new Error('review gitleaks unavailable');
  }
  let status = 'not-run';
  type GlHit = { rule: string | null; diff_line: number | null; file?: string };
  let glHits: GlHit[] = [];
  const glExempted: (GlHit & { reason: string })[] = [];
  if (gl.kind === 'exit') {
    if (!Number.isSafeInteger(gl.code)) throw new Error('invalid gitleaks result');
    status = `exit ${gl.code}`;
    if (gl.code !== 0) glHits = [{ rule: 'gitleaks-error', diff_line: null }];
    else {
      if (!Array.isArray(gl.hits)) throw new Error('gitleaks report unavailable');
      const reported = gl.hits.map((hit: { rule: string | null; diffLine: number | null }) => {
        if (
          !hit ||
          (hit.rule !== null && typeof hit.rule !== 'string') ||
          (hit.diffLine !== null && (!Number.isSafeInteger(hit.diffLine) || hit.diffLine < 1))
        )
          throw new Error('invalid gitleaks report');
        return { rule: hit.rule, diff_line: hit.diffLine };
      });
      // A provider-specific rule on a line vetoes exempting any other finding on it.
      const strict = new Set(
        reported
          .filter((hit) => hit.rule === null || !EXEMPTIBLE_RULES.has(hit.rule))
          .map((hit) => hit.diff_line),
      );
      const linePaths = new Map<number, string>();
      for (const candidate of candidates) linePaths.set(candidate.diffLine, candidate.path);
      glHits = [];
      for (const found of reported) {
        const file = found.diff_line === null ? undefined : linePaths.get(found.diff_line);
        const hit: GlHit = file ? { ...found, file } : found;
        const reason = strict.has(found.diff_line)
          ? null
          : exemptReason(input.exemptions, found.rule, file);
        if (reason === null) glHits.push(hit);
        else glExempted.push({ ...hit, reason });
      }
    }
  } else if (gl.kind !== 'not-run') throw new Error('invalid gitleaks result');
  const report: Record<string, unknown> = {
    base: input.base,
    head: input.head,
    denylist_rules: rules.length,
    denylist_hits: hits,
    gitleaks: status,
    gitleaks_hits: glHits,
    diff_bytes: Array.from(input.diff).length,
  };
  if (exempted.length > 0 || glExempted.length > 0 || input.exemptionError) {
    report.exempted = { denylist: exempted, gitleaks: glExempted };
    if (input.exemptionError) report.exemption_error = input.exemptionError;
  }
  await effects.writeReport(atomicJsonText(report));
  return {
    clean: hits.length === 0 && glHits.length === 0,
    denylistHits: hits.length,
    gitleaksHits: glHits.length,
    artifactPath: input.artifactPath,
  };
}
