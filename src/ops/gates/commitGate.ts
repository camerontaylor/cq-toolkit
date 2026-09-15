// Gates lane C3 — the commit gate: subject/trailer conventions for one
// commit message, as a pure decision over text. Zero I/O, no clocks, no
// environment — the same message always yields the same report. The
// MECHANISM is generic (subject pattern, required/optional trailer rules
// with oneOf or regex value shapes, Outcome-driven subject implications);
// the SPECIFIC taxonomy — conventional-commit subjects, Confidence/Tested/
// Not-tested/Outcome, the broken-test/code-bug/todo implication table — is
// only the shipped DEFAULT config (UC §1 row 27), replaceable wholesale
// per field by the caller.
//
// Invariants honored here:
//   - The verdict is the op's DECISION, not its status: `ok:false` reports
//     ride a `status:'ok'` result (mirrors the regression gate). The one
//     `failed` path is config whose regex sources do not compile.
//   - Trailers are recognized by the git convention ONLY in the trailing
//     paragraph (every line `Name: value`, set off by a blank line): prose
//     after a trailer block makes the block NOT trailing, so those trailers
//     are treated as missing — the gate never fishes trailers out of the
//     middle of a message.
//   - Regex sources arrive as strings and are compiled with `new RegExp`;
//     callers own their trustworthiness (same contract as the hack
//     detector's pattern config).
import type { Op } from '../../kernel/types.js';

/** One trailer rule: presence (`required`) plus a value shape (`oneOf` / `pattern`). */
export interface TrailerRule {
  /** Exact trailer name as it appears before `: ` (case-sensitive). */
  name: string;
  /** When true, absence of the trailer is a violation (default false — optional). */
  required?: boolean;
  /** Allowed values, checked exactly (trailer names like `Outcome`). */
  oneOf?: string[];
  /** Regex source the trailer's value must match (callers own trustworthiness). */
  pattern?: string;
}

/**
 * Subject implication: when the outcome trailer (the rule named by
 * `CommitGateConfig.outcomeTrailer`) has value `outcomeValue`, the subject
 * MUST match `subjectPattern` (regex source). Violations report the
 * `outcomeValue` as their rule.
 */
export interface SubjectImplication {
  outcomeValue: string;
  subjectPattern: string;
}

/**
 * Commit convention config. Every field is optional; a supplied field
 * REPLACES that slice of the shipped default (passing `trailers` drops the
 * default trailer rules entirely — only custom rules are enforced).
 */
export interface CommitGateConfig {
  /** Regex source the subject line must match when a subject is present. */
  subjectPattern?: string;
  /** When true (default), an absent subject line is a violation. */
  requireSubject?: boolean;
  /** Trailer rules enforced in order (default: the shipped taxonomy). */
  trailers?: readonly TrailerRule[];
  /** Which trailer drives subject implications (default `'Outcome'`). */
  outcomeTrailer?: string;
  /** Implication table from outcome value to required subject shape. */
  implications?: readonly SubjectImplication[];
}

/** JSON-serializable input of the `gates.commitGate` op. Plain data. */
export interface CommitGateInput {
  /** The full commit message: subject line, optional body, optional trailer block. */
  message: string;
  /** Convention config; each supplied field replaces the shipped default slice. */
  config?: CommitGateConfig;
}

/**
 * One convention violation. `rule` names what fired: `'subject'` for the
 * subject checks, the trailer name (`'Confidence'`, `'Outcome'`, …) for
 * trailer rules, the outcome value (`'broken-test'`, …) for implication
 * checks. `evidence` is the offending text (the subject, the `Name: value`
 * line); empty when the violation is an absence.
 */
export interface CommitViolation {
  rule: string;
  message: string;
  evidence: string;
}

/** The gate's report: `ok` exactly when `violations` is empty. */
export interface CommitGateReport {
  ok: boolean;
  violations: CommitViolation[];
}

/** Regex source of the shipped conventional-commit subject shape. */
export const DEFAULT_SUBJECT_PATTERN =
  '^(fix|feat|chore|test|docs|refactor|perf|build|ci|style)(\\([^)]+\\))?!?: .+';

/** The shipped trailer taxonomy, frozen: Confidence and Tested required (numeric / non-empty), Not-tested optional, Outcome constrained to the implication table's values. */
export const DEFAULT_COMMIT_TRAILERS: readonly TrailerRule[] = Object.freeze([
  { name: 'Confidence', required: true, pattern: '^[0-9]+(\\.[0-9]+)?$' },
  { name: 'Tested', required: true, pattern: '^.+$' },
  { name: 'Not-tested', required: false, pattern: '^.+$' },
  { name: 'Outcome', required: true, oneOf: ['broken-test', 'code-bug', 'todo'] },
]);

/** The shipped subject implications, frozen: what the Outcome says must be what the subject did. */
export const DEFAULT_COMMIT_IMPLICATIONS: readonly SubjectImplication[] = Object.freeze([
  { outcomeValue: 'broken-test', subjectPattern: '^fix\\(test\\):' },
  { outcomeValue: 'code-bug', subjectPattern: '^fix\\(' },
  { outcomeValue: 'todo', subjectPattern: '^chore\\(test\\): todo' },
]);

/** The outcome trailer the default implication table speaks about. */
export const DEFAULT_OUTCOME_TRAILER = 'Outcome';

/** Git trailer line: `Name: value` with a hyphen/alnum name and a non-empty value. */
const TRAILER_LINE_RE = /^[A-Za-z][A-Za-z0-9-]*: .+$/;

/**
 * The `gates.commitGate` op: `ok` whenever the message was evaluated —
 * `report.ok:false` (violations present) is still a successful op, because
 * the DECISION is the value and what to do about it is the caller's
 * business. Checks, in order: subject presence (when required) and subject
 * pattern; per trailer rule — required-but-missing, then oneOf, then
 * pattern on the first occurrence of a present trailer; implications — for
 * each whose `outcomeValue` equals the outcome trailer's value, the
 * subject must match the implication's pattern. The only non-`ok` status
 * is a config regex source that does not compile.
 */
export const commitGate: Op<CommitGateInput, CommitGateReport> = async (input) => {
  const subjectPattern = input.config?.subjectPattern ?? DEFAULT_SUBJECT_PATTERN;
  const requireSubject = input.config?.requireSubject ?? true;
  const trailerRules = input.config?.trailers ?? DEFAULT_COMMIT_TRAILERS;
  const outcomeTrailer = input.config?.outcomeTrailer ?? DEFAULT_OUTCOME_TRAILER;
  const implications = input.config?.implications ?? DEFAULT_COMMIT_IMPLICATIONS;
  let violations: CommitViolation[];
  try {
    const subjectRe = new RegExp(subjectPattern);
    const rules = trailerRules.map((rule) => ({
      rule,
      valueRe: rule.pattern === undefined ? null : new RegExp(rule.pattern),
    }));
    const implicationRules = implications.map((implication) => ({
      implication,
      subjectRe: new RegExp(implication.subjectPattern),
    }));
    violations = checkMessage(input.message, {
      subjectRe,
      requireSubject,
      rules,
      outcomeTrailer,
      implicationRules,
    });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return { status: 'failed', error: `invalid pattern config for commitGate: ${messageOf(err)}` };
    }
    throw err;
  }
  return { status: 'ok', value: { ok: violations.length === 0, violations } };
};

/** Everything the checks need, with regexes already compiled. */
interface CheckedConfig {
  subjectRe: RegExp;
  requireSubject: boolean;
  rules: { rule: TrailerRule; valueRe: RegExp | null }[];
  outcomeTrailer: string;
  implicationRules: { implication: SubjectImplication; subjectRe: RegExp }[];
}

/** Subject, trailer, and implication checks over one parsed message. */
function checkMessage(message: string, config: CheckedConfig): CommitViolation[] {
  const lines = message.split(/\r?\n/);
  const subject = lines[0] ?? '';
  const trailers = trailersOf(lines);
  const violations: CommitViolation[] = [];

  if (subject.trim() === '') {
    if (config.requireSubject) {
      violations.push({
        rule: 'subject',
        message: 'commit message has no subject line',
        evidence: '',
      });
    }
  } else if (!config.subjectRe.test(subject)) {
    violations.push({
      rule: 'subject',
      message: 'subject does not match the required subject pattern',
      evidence: subject,
    });
  }

  for (const { rule, valueRe } of config.rules) {
    const value = trailers.get(rule.name);
    if (value === undefined) {
      if (rule.required === true) {
        violations.push({
          rule: rule.name,
          message: `required trailer "${rule.name}" is missing`,
          evidence: '',
        });
      }
      continue;
    }
    if (rule.oneOf && !rule.oneOf.includes(value)) {
      violations.push({
        rule: rule.name,
        message: `"${rule.name}" value is not one of the allowed values (${rule.oneOf.join(', ')})`,
        evidence: `${rule.name}: ${value}`,
      });
    }
    if (valueRe && !valueRe.test(value)) {
      violations.push({
        rule: rule.name,
        message: `"${rule.name}" value does not match the required pattern`,
        evidence: `${rule.name}: ${value}`,
      });
    }
  }

  const outcomeValue = trailers.get(config.outcomeTrailer);
  if (outcomeValue !== undefined) {
    for (const { implication, subjectRe } of config.implicationRules) {
      if (implication.outcomeValue !== outcomeValue || subjectRe.test(subject)) {
        continue;
      }
      violations.push({
        rule: implication.outcomeValue,
        message: `"${config.outcomeTrailer}: ${outcomeValue}" requires a subject matching ${implication.subjectPattern}`,
        evidence: subject,
      });
    }
  }
  return violations;
}

/**
 * Trailers of a message: the trailing paragraph's `Name: value` lines, or
 * none. The trailing paragraph is the LAST non-blank paragraph, and only
 * when the message has at least two paragraphs (a bare subject paragraph
 * is never its own trailer block) and EVERY line of it matches the git
 * trailer shape — one non-trailer line (prose) voids the whole block.
 * First occurrence wins for a repeated trailer name.
 */
function trailersOf(lines: string[]): Map<string, string> {
  const paragraphs: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') {
      if (current.length > 0) {
        paragraphs.push(current);
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    paragraphs.push(current);
  }
  const trailers = new Map<string, string>();
  if (paragraphs.length < 2) {
    return trailers;
  }
  const last = paragraphs[paragraphs.length - 1];
  if (!last.every((line) => TRAILER_LINE_RE.test(line))) {
    return trailers;
  }
  for (const line of last) {
    const separator = line.indexOf(': ');
    const name = line.slice(0, separator);
    const value = line.slice(separator + 2);
    if (!trailers.has(name)) {
      trailers.set(name, value);
    }
  }
  return trailers;
}

/** Error message of an unknown throwable, for `failed` results. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
