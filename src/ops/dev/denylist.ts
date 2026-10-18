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
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

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
    if (current?.has(key)) {
      // The authoritative parser rejects duplicate rule keys; last-value-
      // wins here would silently WEAKEN the pre-upload net relative to the
      // gate the repo actually runs.
      fail(lineNo, `duplicate rule key '${key}' in one rule`);
    }
    current?.set(key, parseScalar(keyLine?.[2] as string, `${sourceName}:${String(lineNo + 1)}`));
  }
  finishCurrent();

  // Duplicate rule IDs are rejected too: a disposition or hit names the id,
  // so two rules sharing one id would be unattributable evidence.
  const seenIds = new Set<string>();
  for (const rule of rules) {
    if (seenIds.has(rule.id)) fail(lines.length, `duplicate rule id '${rule.id}'`);
    seenIds.add(rule.id);
  }
  // The authoritative parser rejects a zero-rule file: an empty rule set
  // here would silently disable every repository-specific class while the
  // scan still ran — the pre-upload net must never degrade to defaults
  // only through a malformed policy file.
  if (rules.length === 0) {
    fail(lines.length, 'no rules defined — the denylist must define at least one rule');
  }
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
 * Decode one git path: `core.quotePath` C-escapes non-ASCII bytes as
 * `\303\251` (and `"`/`\` as `\"`/`\\`) inside QUOTED header paths. The
 * escapes are OCTET escapes — decoded through a byte buffer so multi-byte
 * UTF-8 sequences reassemble as characters, not latin-1 mojibake.
 */
export function decodeGitPath(path: string): string {
  if (!path.includes('\\')) return path;
  const bytes: number[] = [];
  for (let index = 0; index < path.length; index++) {
    const char: string = path[index] ?? '';
    if (char === '') break;
    if (char === '\\') {
      const next = path[index + 1];
      if (next === undefined) break;
      if (next === 'n') {
        bytes.push(0x0a);
        index += 1;
      } else if (next === 't') {
        bytes.push(0x09);
        index += 1;
      } else if (next === 'r') {
        bytes.push(0x0d);
        index += 1;
      } else if (next >= '0' && next <= '7') {
        const octal = path.slice(index + 1, index + 4);
        if (/^[0-7]{3}$/.test(octal)) {
          bytes.push(Number.parseInt(octal, 8));
          index += 3;
        } else {
          bytes.push(next.charCodeAt(0));
          index += 1;
        }
      } else {
        bytes.push(next.charCodeAt(0));
        index += 1;
      }
    } else {
      const code = char.charCodeAt(0);
      if (code < 0x80) {
        bytes.push(code);
      } else {
        // Unescaped non-ASCII: already a character — encode it UTF-8 so the
        // single final decode is lossless.
        bytes.push(...Buffer.from(char, 'utf8'));
      }
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Parse ONE header path token: an optional pair of double quotes (git
 * quotes a side when it carries non-ASCII/specials) and the `a/` or `b/`
 * prefix. Both quoted and plain spellings decode through
 * {@link decodeGitPath}.
 */
function headerToken(token: string): string {
  const unquoted =
    token.length >= 2 && token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : token;
  const stripped =
    unquoted.startsWith('a/') || unquoted.startsWith('b/') ? unquoted.slice(2) : unquoted;
  return decodeGitPath(stripped);
}

/**
 * Parse the two paths out of a `diff --git` header line. Git quotes each
 * side INDEPENDENTLY (a rename between an ASCII and a non-ASCII path emits
 * a MIXED header: `diff --git a/foo.env "b/caf\303\251.env"`), so the two
 * tokens are parsed per-side after the `diff --git ` prefix — each either
 * double-quoted (greedy to its closing quote) or plain. For PLAIN sides
 * there is exactly one shape git emits for every non-rename header
 * (modification, add, delete, mode change): `a/<P> b/<P>` — the SAME path
 * both sides — and that self-consistency pins the split uniquely: the
 * remainder `<P> b/<P>` has odd length, so `<P>`'s length is forced by
 * parity and a filename-internal ` b/` (a binary file literally named
 * `.claude/memory.db b/notes.txt`) can never be mistaken for the
 * separator. A plain header that is NOT self-consistent is a true
 * rename/copy and yields null here — its paths arrive from the segment's
 * own `rename from`/`rename to` (or `copy`) lines, which {@link
 * patchSegments} parses. Every side decodes through {@link decodeGitPath};
 * a malformed line yields null (the text headers remain the fallback path
 * source for text files).
 */
export function diffHeaderPaths(line: string): [string, string] | null {
  const prefix = 'diff --git ';
  if (!line.startsWith(prefix)) return null;
  const rest = line.slice(prefix.length);
  // Each side: optionally-quoted token, then the a/ b/ prefixes.
  const mixedQuotedOld = /^"a\/(.*)"\s+b\/(.*)$/.exec(rest);
  if (mixedQuotedOld !== null) {
    return [decodeGitPath(mixedQuotedOld[1] ?? ''), headerToken(`b/${mixedQuotedOld[2] ?? ''}`)];
  }
  const mixedQuotedNew = /^a\/(.*?)\s+"b\/(.*)"$/.exec(rest);
  if (mixedQuotedNew !== null) {
    return [headerToken(`a/${mixedQuotedNew[1] ?? ''}`), decodeGitPath(mixedQuotedNew[2] ?? '')];
  }
  const bothQuoted = /^"a\/(.*)"\s+"b\/(.*)"$/.exec(rest);
  if (bothQuoted !== null) {
    return [decodeGitPath(bothQuoted[1] ?? ''), decodeGitPath(bothQuoted[2] ?? '')];
  }
  if (!rest.startsWith('a/')) return null;
  const remainder = rest.slice(2);
  const pathLength = (remainder.length - 3) / 2;
  if (
    Number.isInteger(pathLength) &&
    pathLength > 0 &&
    remainder.slice(pathLength, pathLength + 3) === ' b/' &&
    remainder.slice(pathLength + 3) === remainder.slice(0, pathLength)
  ) {
    const path = remainder.slice(0, pathLength);
    return [headerToken(`a/${path}`), headerToken(`b/${path}`)];
  }
  return null;
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
      // The header itself names both paths — the ONLY path source for a
      // BINARY segment (no ---/+++ text headers follow it), so a binary
      // file's encoded patch is still path-scoped for the rules. Quoted
      // (C-escaped) header spellings decode too.
      const header = diffHeaderPaths(line);
      if (header !== null) {
        for (const candidate of header) {
          if (candidate !== '/dev/null' && candidate !== '' && !current.paths.includes(candidate)) {
            current.paths.push(candidate);
          }
        }
      }
      continue;
    }
    if (current === null) continue; // preamble before the first header
    current.lines.push(line);
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const raw = line.slice(4).trim();
      const path = headerToken(
        raw.startsWith('"') && raw.endsWith('"') ? `"${raw.slice(1, -1)}"` : raw,
      );
      if (path !== '/dev/null' && path !== '' && !current.paths.includes(path)) {
        current.paths.push(path);
      }
      continue;
    }
    // Rename/copy lines carry ONE path each, unambiguously — the per-side
    // source a rename segment falls back to when its `diff --git` header is
    // not self-consistent (a plain-sided rename, binary renames included,
    // where no ---/+++ headers exist to fall back on).
    const renameCopy = /^(rename|copy) (from|to) (.+?)\r?$/.exec(line);
    if (renameCopy !== null) {
      const raw = renameCopy[3] ?? '';
      const path = decodeGitPath(
        raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw,
      );
      if (path !== '' && !current.paths.includes(path)) {
        current.paths.push(path);
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
 * Repo-relative paths of the patch's BINARY segments — a `GIT binary patch`
 * body or a `Binary files … differ` placeholder carries none of the file's
 * bytes, so the scanners must see the blob contents separately (fetched per
 * leg by the review gate) instead of trusting the textual representation.
 */
export function binaryPathsOf(patch: string): string[] {
  const paths: string[] = [];
  for (const segment of patchSegments(patch)) {
    const binary =
      segment.text.includes('GIT binary patch') || /^Binary files .+ differ$/m.test(segment.text);
    if (!binary) continue;
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

/** A component to scan: a patch, or a flat file with its repo-relative path. */
export interface ScanComponentInput {
  component: string;
  text: string;
  kind: 'patch' | 'file';
  /** The repo-relative path of a `file` component — path-scoped rules use it as context. */
  path?: string;
}

/**
 * Scan every component; returns one verdict per component in input order. A
 * patch component is scanned PER FILE SEGMENT ({@link patchSegments}): a
 * path-scoped rule fires only on the segment of the file it names — never
 * across the whole patch because some other file matched — and hit line
 * numbers stay absolute in the patch. A flat file component (untracked file
 * content) is scanned whole with ITS OWN PATH as the path context, so a
 * path-scoped rule (the *.env class, the scratch-dir class) applies to the
 * untracked file exactly as it would after commit.
 */
export function scanComponents(
  components: readonly ScanComponentInput[],
  rules: readonly DenylistRule[],
): ComponentScan[] {
  return components.map(({ component, text, kind, path }) => {
    if (kind !== 'patch') return scanText(component, text, rules, path === undefined ? [] : [path]);
    const hits: DenylistHit[] = [];
    for (const segment of patchSegments(text)) {
      // The authoritative scanner allowlists this exact intentional corpus.
      // A rename to/from another path still scans the entire segment.
      if (
        segment.paths.length > 0 &&
        segment.paths.every((entry) => entry === 'policy/denylist/patterns.yml')
      )
        continue;
      hits.push(...scanLinesWithOffset(segment.text, rules, segment.paths, segment.startLine - 1));
    }
    return { component, hits };
  });
}

/** A reusable scanner over the component set (the injected seam). */
export interface DiffSecretScanner {
  (components: readonly ScanComponentInput[]): ComponentScan[] | Promise<ComponentScan[]>;
}

/**
 * Compose scanners for the pre-upload gate: hits from ANY composed scanner
 * refuse the upload — gitleaks DEFAULTS and the repo's project rules are
 * independent nets, and the gate clears only when both do.
 */
export function composeScanners(...scanners: DiffSecretScanner[]): DiffSecretScanner {
  return async (components): Promise<ComponentScan[]> => {
    const merged = new Map<string, ComponentScan>();
    for (const scanner of scanners) {
      for (const scan of await scanner(components)) {
        const existing = merged.get(scan.component);
        merged.set(scan.component, {
          component: scan.component,
          hits: [...(existing?.hits ?? []), ...scan.hits],
        });
      }
    }
    return [...merged.values()];
  };
}

/** The command-effect surface the gitleaks scanner needs (a DevEffects subset). */
export interface GitleaksEffects {
  runCommand(
    command: string,
    args: readonly string[],
    opts: { timeoutMs: number },
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>;
  makeScratchDir(prefix: string): Promise<string>;
  removeScratchDir(path: string): Promise<void>;
}

/** The wall-clock cap for one gitleaks run over the components. */
export const GITLEAKS_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The gitleaks DEFAULT-rules half of the pre-upload scan: the components
 * are written one-per-file into a scratch dir OUTSIDE the worktree, gitleaks
 * runs over them (`detect --no-git`, JSON report, redacted), and findings
 * map back to components with absolute line numbers. The scratch dir is
 * removed afterwards. Exit 0 = clean; exit 1 = findings (the report is the
 * evidence); ANY other exit is a run FAULT (thrown — the caller refuses the
 * upload, never uploads unscanned). An exit 1 with an unreadable report is
 * also a fault: a claimed finding without readable evidence cannot gate.
 */
export function makeGitleaksDefaultsScanner(effects: GitleaksEffects): DiffSecretScanner {
  return async (components): Promise<ComponentScan[]> => {
    if (components.length === 0) return [];
    const scratch = await effects.makeScratchDir('secret-scan');
    try {
      for (const [index, component] of components.entries()) {
        await writeFile(join(scratch, `component-${String(index)}.txt`), component.text, {
          encoding: 'utf8',
          mode: 0o600,
        });
      }
      const reportPath = join(scratch, 'report.json');
      const result = await effects.runCommand(
        'gitleaks',
        [
          'detect',
          '--source',
          scratch,
          '--no-git',
          '--no-banner',
          '--report-format',
          'json',
          '--report-path',
          reportPath,
          '--redact',
        ],
        { timeoutMs: GITLEAKS_TIMEOUT_MS },
      );
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        throw new Error(
          `gitleaks failed to run (exit ${result.exitCode === null ? 'none (killed)' : String(result.exitCode)}) — ${result.stderr.trim().slice(0, 300)}`,
        );
      }
      let report: unknown;
      try {
        report = JSON.parse(await readFile(reportPath, 'utf8'));
      } catch {
        if (result.exitCode === 1) {
          throw new Error(
            'gitleaks reported findings but wrote an unreadable report — the upload is refused',
          );
        }
        report = [];
      }
      if (!Array.isArray(report)) {
        throw new Error('gitleaks report was not a JSON array — the upload is refused');
      }
      const perComponent = new Map<string, Map<string, number[]>>();
      // (the mapping loop below fills this; the exit-1 verdict check follows it)
      for (const entry of report) {
        if (entry === null || typeof entry !== 'object') continue;
        const record = entry as { File?: unknown; StartLine?: unknown; RuleID?: unknown };
        const file = typeof record.File === 'string' ? basename(record.File) : undefined;
        if (file === undefined || !file.startsWith('component-') || !file.endsWith('.txt'))
          continue;
        const index = Number(file.slice('component-'.length, -'.txt'.length));
        const component = components[index];
        if (component === undefined) continue;
        const line = typeof record.StartLine === 'number' ? record.StartLine : 0;
        const ruleId =
          typeof record.RuleID === 'string' && record.RuleID !== ''
            ? record.RuleID
            : 'gitleaks:unknown';
        const byRule = perComponent.get(component.component) ?? new Map<string, number[]>();
        const lines = byRule.get(ruleId) ?? [];
        if (!lines.includes(line)) lines.push(line);
        byRule.set(ruleId, lines);
        perComponent.set(component.component, byRule);
      }
      // EXIT 1 MEANS FINDINGS EXIST: a readable-but-empty report, or rows
      // that all failed to map to a component, can never pass as a clean
      // scan — the scanner's failing verdict without mapped evidence is a
      // fault, and the upload is refused.
      const mappedHits = [...perComponent.values()].reduce((sum, byRule) => sum + byRule.size, 0);
      if (result.exitCode === 1 && mappedHits === 0) {
        throw new Error(
          'gitleaks reported findings (exit 1) but the report yielded no mappable rows — refusing the upload without evidence',
        );
      }
      // Every component gets a verdict, in input order.
      return components.map((component) => ({
        component: component.component,
        hits: [...(perComponent.get(component.component)?.entries() ?? [])].map(
          ([ruleId, lines]) => ({
            ruleId,
            lines: [...lines].sort((a, b) => a - b),
          }),
        ),
      }));
    } finally {
      await effects.removeScratchDir(scratch).catch(() => undefined);
    }
  };
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
