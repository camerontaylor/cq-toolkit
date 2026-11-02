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
// module ports the protected script's parser exactly (see the parser
// section), failing closed on any deviation. The script remains the
// format's authority; this port exists so the dev.review gate can apply the
// same rule classes to diff components without touching the (protected)
// scan script, and a parity test pins it to the script's source.
//
// THE SCAN: every component is ONE file's text (a per-path patch leg or an
// untracked file) with its repo-relative path; a rule carrying a `path`
// regex applies only to components whose path matches it. Findings name
// the rule id, the component, and the 1-based line numbers — never the
// matched content (inspect locally without printing secret contents).
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { parseCqConfig } from '../analyze/cqConfig.js';
import { resolveCqConfigDefaults } from '../analyze/cqConfigDefaults.js';

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

// --- The constrained parser: a PORT of scripts/denylist-scan's ---------------
//
// PARITY, NOT RESEMBLANCE: this is a line-for-line port of the protected
// script's parseScalar / splitKeyValue / assertRelativeProbePath /
// parsePatterns, so the pre-upload scan accepts exactly the files the
// authoritative scanner accepts and reads the same rules from them.
// test/ops/dev/denylist-parity.test.ts loads the script's own parser source
// and fails on any verdict or rule difference. A malformed rule must never
// parse as a weaker one: every rejection throws, and dev.review refuses the
// review before any upload (fail closed).

/** A patterns-file format error (the script's ConfigError). */
export class PatternsFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatternsFormatError';
  }
}

const TOP_KEYS = ['rules', 'clean_probes'];
const REQUIRED_RULE_KEYS = ['id', 'description', 'regex', 'sample'];
const RULE_KEYS = [...REQUIRED_RULE_KEYS, 'path', 'probe_path'];

/** Windows device names (reserved with any extension, any case). */
const WINDOWS_DEVICE_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'CONIN$',
  'CONOUT$',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

/**
 * One scalar: single-quoted (the COMPLETE grammar — an unescaped quote
 * inside is malformed, never a longer value) or plain (no `: ` and no ` #`).
 * Empty and double-quoted values are malformed.
 */
function parseScalar(raw: string, where: string): string {
  const s = raw.trim();
  if (s === '' || s === "''") throw new PatternsFormatError(`${where}: empty value`);
  if (s.startsWith('"')) {
    throw new PatternsFormatError(
      `${where}: double-quoted values are not part of the constrained format`,
    );
  }
  if (s.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(s)) {
      throw new PatternsFormatError(`${where}: unterminated single-quoted value`);
    }
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (/:\s|\s#/.test(s)) {
    throw new PatternsFormatError(`${where}: plain value contains reserved characters`);
  }
  return s;
}

function splitKeyValue(s: string, where: string): { key: string; value: string } {
  const m = /^([A-Za-z_][A-Za-z0-9_]*):(?:[ \t]+(.*))?$/.exec(s);
  if (m === null) throw new PatternsFormatError(`${where}: expected "key: value"`);
  return { key: m[1] as string, value: parseScalar(m[2] ?? '', where) };
}

/** probe_path must be a repo-relative, '/'-separated path of plain Windows-safe names. */
function assertRelativeProbePath(value: string, where: string): void {
  if (win32.isAbsolute(value)) {
    throw new PatternsFormatError(
      `${where}: probe_path must be repo-relative, got absolute "${value}"`,
    );
  }
  if (value.includes('\\')) {
    throw new PatternsFormatError(`${where}: probe_path must be '/'-separated, got "${value}"`);
  }
  for (const seg of value.split('/')) {
    if (seg === '') {
      throw new PatternsFormatError(
        `${where}: probe_path must not contain empty segments, got "${value}"`,
      );
    }
    const canonical = seg.replace(/[ .]+$/, '');
    if (canonical !== seg || canonical === '.' || canonical === '..') {
      throw new PatternsFormatError(`${where}: probe_path segment "${seg}" is not a plain name`);
    }
    // eslint-disable-next-line no-control-regex -- C0 controls are exactly what is rejected
    if (/[<>:"|?*\x00-\x1f]/.test(seg)) {
      throw new PatternsFormatError(
        `${where}: probe_path segment ${JSON.stringify(seg)} is not a plain name`,
      );
    }
    const stem = (seg.split('.')[0] ?? '').replace(/[ .]+$/, '').toUpperCase();
    if (WINDOWS_DEVICE_NAMES.has(stem)) {
      throw new PatternsFormatError(
        `${where}: probe_path segment ${JSON.stringify(seg)} is a Windows device name`,
      );
    }
  }
}

/**
 * Parse the constrained patterns file. Fail closed: unexpected keys,
 * duplicate sections or keys, malformed nesting or indentation, tabs,
 * missing required keys, empty or malformed scalars, zero rules, an empty
 * clean_probes list, or duplicate rule ids all throw — never skip, never
 * guess. `sourceName` prefixes the line locations in errors.
 */
export function parseDenylistPatterns(text: string, sourceName: string): DenylistPatterns {
  const rules: Record<string, string>[] = [];
  const cleanProbes: string[] = [];
  const seenSections = new Set<string>();
  let section: string | null = null;
  let rule: Record<string, string> | null = null;

  for (const [idx, raw] of text.split(/\r?\n/).entries()) {
    const where = `${sourceName}:${String(idx + 1)}`;
    if (raw.includes('\t')) {
      throw new PatternsFormatError(
        `${where}: tab indentation is not part of the constrained format`,
      );
    }
    const t = raw.trim();
    if (t === '' || t.startsWith('#')) continue;

    if (/^[A-Za-z_][A-Za-z0-9_]*:$/.test(raw)) {
      const key = raw.slice(0, -1);
      if (!TOP_KEYS.includes(key))
        throw new PatternsFormatError(`${where}: unexpected top-level key "${key}"`);
      if (seenSections.has(key))
        throw new PatternsFormatError(`${where}: duplicate section "${key}"`);
      seenSections.add(key);
      section = key;
      rule = null;
      continue;
    }
    if (section === null)
      throw new PatternsFormatError(`${where}: content before the first section`);

    if (/^ {2}- /.test(raw)) {
      const rest = raw.slice(4);
      if (section === 'clean_probes') {
        cleanProbes.push(parseScalar(rest, where));
      } else {
        const kv = splitKeyValue(rest.trim(), where);
        if (kv.key !== 'id') {
          throw new PatternsFormatError(
            `${where}: rule item must start with "id", got "${kv.key}"`,
          );
        }
        rule = { id: kv.value };
        rules.push(rule);
      }
      continue;
    }

    if (/^ {4}[A-Za-z_]/.test(raw)) {
      if (section !== 'rules' || rule === null) {
        throw new PatternsFormatError(`${where}: nested key outside a rule item`);
      }
      const kv = splitKeyValue(raw.trim(), where);
      if (!RULE_KEYS.includes(kv.key))
        throw new PatternsFormatError(`${where}: unexpected rule key "${kv.key}"`);
      if (Object.hasOwn(rule, kv.key))
        throw new PatternsFormatError(`${where}: duplicate rule key "${kv.key}"`);
      if (kv.key === 'probe_path') assertRelativeProbePath(kv.value, where);
      rule[kv.key] = kv.value;
      continue;
    }

    throw new PatternsFormatError(`${where}: malformed line (unexpected indentation or structure)`);
  }

  if (rules.length === 0) throw new PatternsFormatError(`${sourceName}: zero rules parsed`);
  if (cleanProbes.length === 0)
    throw new PatternsFormatError(`${sourceName}: clean_probes missing or empty`);
  for (const r of rules) {
    for (const k of REQUIRED_RULE_KEYS) {
      if (typeof r[k] !== 'string' || r[k] === '') {
        throw new PatternsFormatError(`rule "${String(r['id'])}": missing required key "${k}"`);
      }
    }
  }
  if (new Set(rules.map((r) => r['id'])).size !== rules.length) {
    throw new PatternsFormatError(`${sourceName}: duplicate rule ids`);
  }
  return {
    rules: rules.map((r) => ({
      id: r['id'] as string,
      description: r['description'] as string,
      regex: r['regex'] as string,
      ...(r['path'] !== undefined ? { path: r['path'] } : {}),
    })),
    cleanProbes,
  };
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
  (
    components: readonly ScanComponentInput[],
    options?: { timeoutMs?: number },
  ): ComponentScan[] | Promise<ComponentScan[]>;
}

/**
 * Compose scanners for the pre-upload gate: hits from ANY composed scanner
 * refuse the upload — gitleaks DEFAULTS and the repo's project rules are
 * independent nets, and the gate clears only when both do.
 */
export function composeScanners(...scanners: DiffSecretScanner[]): DiffSecretScanner {
  return async (components, options): Promise<ComponentScan[]> => {
    const merged = new Map<string, ComponentScan>();
    for (const scanner of scanners) {
      for (const scan of await scanner(components, options)) {
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
  return async (components, options): Promise<ComponentScan[]> => {
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
        { timeoutMs: Math.max(1, Math.min(GITLEAKS_TIMEOUT_MS, options?.timeoutMs ?? Infinity)) },
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

/** Portable review scanner: always gitleaks defaults, plus project rules only when configured. */
export function makePortableReviewScanner(
  repoRoot: string,
  effects: GitleaksEffects,
  configText: string | null,
  packageName = 'repository',
): DiffSecretScanner {
  const defaults = makeGitleaksDefaultsScanner(effects);
  if (configText === null) return defaults;
  const parsed = parseCqConfig(configText, repoRoot);
  if (!parsed.ok) {
    return async () => {
      throw new Error(`review config invalid: ${parsed.reason}`);
    };
  }
  const policy = resolveCqConfigDefaults(parsed.config, { packageName });
  return policy.review.denylistPatternsFile === undefined
    ? defaults
    : composeScanners(defaults, makeRepoDiffScanner(repoRoot, policy.review.denylistPatternsFile));
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
export function makeRepoDiffScanner(
  repoRoot: string,
  patternsFile = 'policy/denylist/patterns.yml',
): DiffSecretScanner {
  let scanner: DiffSecretScanner | undefined;
  return (components) => {
    if (scanner === undefined) {
      const patternsPath = resolve(repoRoot, patternsFile);
      const rel = relative(resolve(repoRoot), patternsPath);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error(
          `denylist: configured patterns file '${patternsFile}' escapes the repository root`,
        );
      }
      let bytes: Buffer;
      try {
        bytes = readFileSync(patternsPath);
      } catch (err) {
        throw new Error(
          `denylist: cannot read the patterns file at '${patternsPath}' — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const patterns = parseDenylistPatterns(decodePolicyUtf8(bytes, patternsFile), patternsFile);
      scanner = (given) => scanComponents(given, patterns.rules);
    }
    return scanner(components);
  };
}

/**
 * Decode the policy bytes as STRICT UTF-8: an invalid sequence throws
 * instead of becoming U+FFFD, which would silently turn a rule such as
 * `'secret'` into the never-matching `'secret\uFFFD'` and let the content
 * through (independent review of #356). A leading BOM is kept in the text,
 * so the parser rejects it as the authoritative parser does.
 */
export function decodePolicyUtf8(bytes: Uint8Array, sourceName: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new PatternsFormatError(`${sourceName}: not valid UTF-8 — the policy file is corrupt`);
  }
}
