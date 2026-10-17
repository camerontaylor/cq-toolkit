// Dev lane — the pre-review SECRET SCAN over the diff components
// (docs/coderabbit-review.md §1: scan the base-to-HEAD patch, the staged
// patch, the unstaged patch, and the full content of any included untracked
// files — added AND removed lines, because a credential deleted from the
// worktree can still occur in an uploaded patch).
//
// THE PARSER IS DELIBERATELY NOT A YAML PARSER (the workflowScan decision,
// kept here): a parser dependency would change the lockfile and put
// third-party code on the trust path for a deny decision, and two parsers
// could read the same file differently. `policy/denylist/patterns.yml` is a
// CONSTRAINED format by its own header — top-level `rules` and
// `clean_probes`, rule keys id/description/regex/sample plus optional
// path/probe_path, single-quoted or plain scalars, '#' comments — and this
// module parses exactly that shape, failing closed on any deviation. The
// scripts/denylist-scan self-test remains the format's authority; this
// parser exists so the dev.review gate can apply the same rule classes to
// diff components without touching the (protected) scan script.
//
// THE SCAN: non-path rules match the component text whole; a rule carrying a
// `path` regex applies only to the segments of a patch whose file path
// matches it (a path rule can never carry its context on a flat text).
// Findings name the rule id, the component, and the 1-based line numbers —
// never the matched content (inspect locally without printing secret
// contents).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** One denylist rule as parsed from the patterns file. */
export interface DenylistRule {
  id: string;
  description: string;
  /** The raw regex source; compiled when the scan runs, never on parse. */
  regex: string;
  /** Optional path regex — when present the rule only fires on matching paths. */
  path?: string;
}

/** The parsed patterns file: the rules that gate the scan, plus the probe corpus. */
export interface DenylistPatterns {
  rules: DenylistRule[];
  cleanProbes: string[];
}

/** One scan hit: the rule that fired and where — never the matched text. */
export interface DenylistHit {
  ruleId: string;
  /** 1-based line numbers in the scanned text where the rule matched. */
  lines: number[];
}

/** One scanned component's verdict. */
export interface ComponentScan {
  component: string;
  hits: DenylistHit[];
}

// --- The constrained parser -------------------------------------------------

class PatternsFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatternsFormatError';
  }
}

/** The only top-level keys the format defines. */
const TOP_KEYS = new Set(['rules', 'clean_probes']);
/** The keys a rule may carry; id/description/regex/sample are required. */
const RULE_KEYS = new Set(['id', 'description', 'regex', 'sample', 'path', 'probe_path']);
const REQUIRED_RULE_KEYS = ['id', 'description', 'regex', 'sample'] as const;

/**
 * Parse one scalar (the format's documented spellings: single-quoted or
 * plain): leading/trailing whitespace stripped, `''` inside a single-quoted
 * scalar unescaping to a literal quote. Double quotes, block scalars,
 * anchors/aliases, and inline comments are format errors — never guessed.
 */
function parseScalar(raw: string, where: string): string {
  const text = raw.trim();
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) {
      throw new PatternsFormatError(`${where}: unterminated single-quoted scalar`);
    }
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (/^["|>&*]/.test(text)) {
    throw new PatternsFormatError(
      `${where}: unsupported scalar spelling — the format allows single-quoted or plain scalars only`,
    );
  }
  if (text.includes(' #')) {
    throw new PatternsFormatError(
      `${where}: inline comments are not part of the constrained format`,
    );
  }
  return text;
}

/**
 * Parse the constrained patterns file. Fail-closed: an unknown top-level
 * key, a rule with an unknown or missing key, a list item that is not a
 * mapping where a mapping is required, or an entry before any top-level key
 * all throw — never silently skip. The rules list is order-preserving; the
 * clean_probes list is parsed (the format carries it) but only the rules
 * gate the scan.
 */
export function parseDenylistPatterns(text: string, sourceName: string): DenylistPatterns {
  const lines = text.split(/\r?\n/);
  const rules: DenylistRule[] = [];
  const cleanProbes: string[] = [];
  let section: 'none' | 'rules' | 'clean_probes' = 'none';
  // The rule under construction; finalized when the next `- ` item or a
  // top-level line arrives, and at end of input. Declared as a FUNCTION so
  // its `never` return narrows the callers (a const arrow would not).
  let current: Map<string, string> | null = null;
  function fail(lineNo: number, why: string): never {
    throw new PatternsFormatError(`${sourceName}:${String(lineNo + 1)}: ${why}`);
  }

  function finishCurrent(): void {
    if (current === null) return;
    for (const key of REQUIRED_RULE_KEYS) {
      if (!current.has(key)) fail(lines.length, `rule is missing required key '${key}'`);
    }
    const rule: DenylistRule = {
      id: current.get('id') as string,
      description: current.get('description') as string,
      regex: current.get('regex') as string,
    };
    const path = current.get('path');
    if (path !== undefined) rule.path = path;
    rules.push(rule);
    current = null;
  }

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo] as string;
    const stripped = line.trim();
    if (stripped === '' || stripped.startsWith('#')) continue;

    if (!line.startsWith(' ')) {
      // A top-level `key:` line — the only structural form at column 0.
      // (List items are indented in this format; an unindented `- …` item
      // fails below as an unexpected top-level line — fail-closed, never
      // guessed.)
      finishCurrent();
      const match = /^([A-Za-z_][A-Za-z0-9_]*):\s*$/.exec(stripped);
      if (match === null) {
        fail(lineNo, "unexpected top-level line — expected 'rules:' or 'clean_probes:'");
      }
      const key = match[1] as string;
      if (!TOP_KEYS.has(key)) {
        fail(
          lineNo,
          `unknown top-level key '${key}' — the format defines rules and clean_probes only`,
        );
      }
      section = key as 'rules' | 'clean_probes';
      continue;
    }

    if (section === 'none') fail(lineNo, 'content before any top-level key');

    if (section === 'clean_probes') {
      const match = /^-\s+(.*)$/.exec(stripped);
      if (match === null) {
        fail(lineNo, 'clean_probes entries must be `- <scalar>` list items');
      }
      if (/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.test(match?.[1] as string)) {
        fail(lineNo, 'clean_probes entries must be `- <scalar>` list items, not mappings');
      }
      cleanProbes.push(parseScalar(match[1] as string, `${sourceName}:${String(lineNo + 1)}`));
      continue;
    }

    // section === 'rules': a `- key: value` list start, or a continuation
    // `key: value` line belonging to the open rule.
    const ruleStart = /^-\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(stripped);
    if (ruleStart !== null) {
      finishCurrent();
      current = new Map();
      const key = ruleStart[1] as string;
      if (!RULE_KEYS.has(key)) fail(lineNo, `unknown rule key '${key}'`);
      current.set(key, parseScalar(ruleStart[2] as string, `${sourceName}:${String(lineNo + 1)}`));
      continue;
    }
    const keyLine = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(stripped);
    if (keyLine === null || current === null) {
      fail(lineNo, 'rules entries must be `- key: value` mappings');
    }
    const key = keyLine?.[1] as string;
    if (!RULE_KEYS.has(key)) fail(lineNo, `unknown rule key '${key}'`);
    current?.set(key, parseScalar(keyLine?.[2] as string, `${sourceName}:${String(lineNo + 1)}`));
  }
  finishCurrent();

  return { rules, cleanProbes };
}

// --- The scan ---------------------------------------------------------------

/** One file's segment of a unified diff: its old/new paths and its raw text. */
export interface PatchSegment {
  /** Old and new paths from the segment's headers, /dev/null excluded. */
  paths: string[];
  /** The segment's raw text, starting at its `diff --git` line. */
  text: string;
  /** The segment's first line's 1-based index in the WHOLE patch. */
  startLine: number;
}

/**
 * Split a unified diff at `diff --git` boundaries into per-file segments,
 * each carrying BOTH header paths (old and new — a rename's rule match must
 * consider either) and its offset in the whole patch, so a path-scoped rule
 * applies ONLY to the segment of the file it names and hit line numbers stay
 * absolute in the patch.
 */
export function patchSegments(patch: string): PatchSegment[] {
  const lines = patch.split('\n');
  const segments: PatchSegment[] = [];
  let current: { paths: string[]; lines: string[]; startLine: number } | null = null;
  const flush = (): void => {
    if (current === null) return;
    segments.push({
      paths: current.paths,
      text: current.lines.join('\n'),
      startLine: current.startLine,
    });
    current = null;
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string;
    if (line.startsWith('diff --git ')) {
      flush();
      current = { paths: [], lines: [line], startLine: index + 1 };
      continue;
    }
    if (current === null) continue; // preamble before the first header
    current.lines.push(line);
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const path = line.slice(4).trim();
      const stripped = path.startsWith('b/') || path.startsWith('a/') ? path.slice(2) : path;
      if (stripped !== '/dev/null' && stripped !== '' && !current.paths.includes(stripped)) {
        current.paths.push(stripped);
      }
    }
  }
  flush();
  if (segments.length === 0 && patch !== '') {
    // No `diff --git` boundaries (a headerless patch): the whole text is
    // ONE segment with every header path — content is never silently
    // dropped for lack of a boundary to split at.
    const paths: string[] = [];
    for (const line of lines) {
      if (line.startsWith('--- ') || line.startsWith('+++ ')) {
        const path = line.slice(4).trim();
        const stripped = path.startsWith('b/') || path.startsWith('a/') ? path.slice(2) : path;
        if (stripped !== '/dev/null' && stripped !== '' && !paths.includes(stripped)) {
          paths.push(stripped);
        }
      }
    }
    segments.push({ paths, text: patch, startLine: 1 });
  }
  return segments;
}

/** Segment paths named by a unified-diff header, in file order. */
export function diffPathsOf(patch: string): string[] {
  const paths: string[] = [];
  for (const segment of patchSegments(patch)) {
    for (const path of segment.paths) {
      if (!paths.includes(path)) paths.push(path);
    }
  }
  return paths;
}

/**
 * Scan one text with the rules, restricting `path`-carrying rules to the
 * given file paths (empty for a flat text — a path rule then cannot fire).
 * Regexes compile here (never at parse time); an uncompilable rule throws,
 * naming the rule id — a broken pattern is a gate fault, never a silent
 * skip. Returns hits grouped per rule, with 1-based line numbers.
 */
export function scanText(
  component: string,
  text: string,
  rules: readonly DenylistRule[],
  paths: readonly string[],
): ComponentScan {
  return { component, hits: scanLinesWithOffset(text, rules, paths, 0) };
}

/** The compiled-rule scan of one text with line numbers offset by `lineOffset`. */
function scanLinesWithOffset(
  text: string,
  rules: readonly DenylistRule[],
  paths: readonly string[],
  lineOffset: number,
): DenylistHit[] {
  const lines = text.split('\n');
  const hits: DenylistHit[] = [];
  for (const rule of rules) {
    let re: RegExp;
    try {
      re = new RegExp(rule.regex, 'g');
    } catch (err) {
      throw new Error(
        `denylist: rule '${rule.id}' does not compile — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (rule.path !== undefined) {
      let pathRe: RegExp;
      try {
        pathRe = new RegExp(rule.path);
      } catch (err) {
        throw new Error(
          `denylist: rule '${rule.id}' path does not compile — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!paths.some((path) => pathRe.test(path))) continue;
    }
    const matched: number[] = [];
    for (let index = 0; index < lines.length; index++) {
      re.lastIndex = 0;
      if (re.test(lines[index] as string)) matched.push(index + 1 + lineOffset);
    }
    if (matched.length > 0) hits.push({ ruleId: rule.id, lines: matched });
  }
  return hits;
}

/**
 * Scan every component; returns one verdict per component in input order. A
 * patch component is scanned PER FILE SEGMENT ({@link patchSegments}): a
 * path-scoped rule fires only on the segment of the file it names — never
 * across the whole patch because some other file matched — and hit line
 * numbers stay absolute in the patch. Flat texts (untracked file contents)
 * are scanned whole with no path context (a path rule cannot fire there).
 */
export function scanComponents(
  components: readonly { component: string; text: string; kind: 'patch' | 'file' }[],
  rules: readonly DenylistRule[],
): ComponentScan[] {
  return components.map(({ component, text, kind }) => {
    if (kind !== 'patch') return scanText(component, text, rules, []);
    const hits: DenylistHit[] = [];
    for (const segment of patchSegments(text)) {
      hits.push(...scanLinesWithOffset(segment.text, rules, segment.paths, segment.startLine - 1));
    }
    return { component, hits };
  });
}

/** A reusable scanner bound to one parsed rule set (the injected seam). */
export interface DiffSecretScanner {
  (
    components: readonly { component: string; text: string; kind: 'patch' | 'file' }[],
  ): ComponentScan[];
}

/**
 * The production scanner factory: binds `<repoRoot>/policy/denylist/
 * patterns.yml` and returns a scanner over that rule set. CONSTRUCTION IS
 * INERT (the registry contract — resolving an entry never touches the
 * filesystem): the file is read and parsed fail-closed on the scanner's
 * FIRST CALL, so a missing or malformed patterns file surfaces as a scan
 * fault at review time — which dev.review maps to a refusal. A dev review
 * never runs without its secret scan; it just also never reads a file at
 * import-resolution time.
 */
export function makeRepoDiffScanner(repoRoot: string): DiffSecretScanner {
  let scanner: DiffSecretScanner | undefined;
  return (components) => {
    if (scanner === undefined) {
      const patternsPath = join(repoRoot, 'policy', 'denylist', 'patterns.yml');
      let text: string;
      try {
        text = readFileSync(patternsPath, 'utf8');
      } catch (err) {
        throw new Error(
          `denylist: cannot read the patterns file at '${patternsPath}' — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const patterns = parseDenylistPatterns(text, 'policy/denylist/patterns.yml');
      scanner = (given) => scanComponents(given, patterns.rules);
    }
    return scanner(components);
  };
}
