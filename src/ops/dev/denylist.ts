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
// THE SCAN: every component is ONE file's text (a per-path patch leg or an
// untracked file) with its repo-relative path; a rule carrying a `path`
// regex applies only to components whose path matches it. Findings name
// the rule id, the component, and the 1-based line numbers — never the
// matched content (inspect locally without printing secret contents).
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

/**
 * One component to scan: a single file's patch on one diff leg, or one
 * untracked file's content — always with its repo-relative path, so
 * path-scoped rules (the *.env class, the scratch-dir class) apply exactly
 * as they would after commit. dev.review builds one component per (leg,
 * path) from git's own NUL-separated path lists, so no patch header is ever
 * parsed for a path.
 */
export interface ScanComponentInput {
  /** The component's name in evidence (`<leg>:<path>`). */
  component: string;
  text: string;
  path: string;
}

/**
 * Scan one text with the rules; a `path`-carrying rule applies only when
 * the component's path matches it. Regexes compile here (never at parse
 * time); an uncompilable rule throws naming the rule id — a broken pattern
 * is a scan fault, never a silent skip. Hits carry 1-based line numbers,
 * never the matched content.
 */
export function scanText(
  text: string,
  rules: readonly DenylistRule[],
  path: string | undefined,
): DenylistHit[] {
  const lines = text.split('\n');
  const hits: DenylistHit[] = [];
  for (const rule of rules) {
    let re: RegExp;
    let pathRe: RegExp | undefined;
    try {
      re = new RegExp(rule.regex);
      if (rule.path !== undefined) pathRe = new RegExp(rule.path);
    } catch (err) {
      throw new Error(
        `denylist: rule '${rule.id}' does not compile — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (pathRe !== undefined && (path === undefined || !pathRe.test(path))) continue;
    const matched: number[] = [];
    for (const [index, line] of lines.entries()) {
      if (re.test(line)) matched.push(index + 1);
    }
    if (matched.length > 0) hits.push({ ruleId: rule.id, lines: matched });
  }
  return hits;
}

/** Scan every component with the project rules; one verdict per component, in input order. */
export function scanComponents(
  components: readonly ScanComponentInput[],
  rules: readonly DenylistRule[],
): ComponentScan[] {
  return components.map(({ component, text, path }) => ({
    component,
    hits: scanText(text, rules, path),
  }));
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
