// W1.9 (D11) — the conservative GitHub Actions workflow scanner the
// default-branch policy check uses to decide whether a workflow change needs
// a human. It is deliberately NOT a YAML parser (methods note, Decision 1): a
// parser dependency would change the lockfile and put third-party code on the
// privileged verification path. Instead it recognises the block-style subset
// real workflows are written in and FAILS CLOSED on everything else.
//
// Fail-closed direction: the scanner may over-flag, never under-flag. Any
// construct where this scanner and GitHub's YAML parser could read different
// structure is `{ ok: false }`, which the caller turns into a needs-human
// `workflow-unparseable` finding. Rejected (parser-differential rules):
//   - characters: any `\r` not followed by `\n`; U+0085, U+2028, U+2029; any
//     C0/C1 control or DEL except `\n`; a BOM anywhere but offset 0; tabs
//     anywhere except inside block-scalar content and comment lines; Unicode
//     space separators (e.g. NBSP) outside block-scalar content;
//   - YAML features: anchors, aliases, tags, merge keys, complex keys,
//     directives, multi-document files, document end markers, explicit
//     block-scalar indentation indicators, multi-line quoted scalars and
//     flow collections, any double-quoted scalar containing a backslash
//     escape, non-empty flow mappings (except an inline `permissions:`);
//   - keys: quoted keys (except the top-level `"on"`/`'on'`), duplicate keys
//     at every level the scanner reads, keys outside the known top-level,
//     job and step allow-lists (keys are case-sensitive, so `Permissions:` is
//     unknown), boolean-like top-level spellings other than `on`/`true`;
//   - shape: indented roots, inconsistent job/step indentation, steps that
//     are not mappings, a missing `on:` or `jobs:`.
//
// Within the subset:
//   - Privilege is a disjunction of signals: a job is privileged if ANY fires,
//     including a secret named only inside a `run:` script (it is the job's
//     text) and the default token when no `permissions:` is declared anywhere
//     (GitHub's default may be write).
//   - Change detection compares normalised text (comment-only and blank
//     structural lines and trailing comments dropped, trailing whitespace
//     stripped); block-scalar content is opaque text and is kept verbatim.
//   - `uses`, `run`, `with`, `ref`, `repository` and `persist-credentials`
//     are matched on each line's parsed key, never by regex over text.
//   - A job whose check-run name cannot be decided statically (dynamic or
//     non-literal `name:`, a matrix, a reusable-workflow call) never
//     "produces" a check, so the caller sees a missing producer rather than
//     a phantom one.
//   - The D-G.3 lint is REGRESSION-ONLY: existing violations are base-owned,
//     so on a changed file the lint judges only what the subject introduces
//     (a finding whose key — rule, job id and signal — is absent at the
//     base). New files, and files whose base is unparseable, report every
//     violation.

/** Finding kinds this module emits (a subset of the policy-diff kinds). */
export type WorkflowFindingKind =
  | 'workflow-new'
  | 'workflow-removed'
  | 'trigger-changed'
  | 'privileged-job'
  | 'workflow-unparseable'
  | 'lint';

/** One workflow-level policy finding: a kind, the workflow path, and a one-line reason. */
export interface WorkflowFinding {
  kind: WorkflowFindingKind;
  path: string;
  reason: string;
}

/** One job of a scanned workflow. */
export interface WorkflowJob {
  id: string;
  /** The job's normalised block text (its lines), used for change detection. */
  text: string;
  /** Literal `name:` value (quotes stripped); absent if there is none or it is not literal. */
  name?: string;
  /** The job has a `name:` whose value is not a plain literal (contains `${{`, a block scalar). */
  dynamicName: boolean;
  privileged: boolean;
  /** Human-readable privilege signals, e.g. `permission contents: write`, `secret DEPLOY_KEY`. */
  privilegeReasons: string[];
  /** `uses: ./path` targets (no leading `./`, no trailing `/`; the repo root is `.`). */
  localUses: string[];
  /** The job has a `run:` step. */
  hasRunSteps: boolean;
}

/** The scan of one workflow file: its recognised structure, or why it is outside the subset. */
export type WorkflowScan =
  | {
      ok: true;
      /** Normalised text of the top-level `on:` key and its block. */
      on: string;
      /** Normalised text of every top-level block except `name`, `run-name`, `on`, `jobs`. */
      context: string;
      /** Event names the workflow triggers on. */
      triggers: string[];
      jobs: ReadonlyMap<string, WorkflowJob>;
    }
  | { ok: false; reason: string };

type OkScan = WorkflowScan & { ok: true };

/** Reason strings shared by the privilege rules and the D-G.3 lint. */
const REASON_ENVIRONMENT = 'environment:';
const REASON_REUSABLE = 'reusable workflow call';
const REASON_DEFAULT_TOKEN = 'no permissions declared (default token)';

/** Top-level workflow keys GitHub documents. */
const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'name',
  'run-name',
  'on',
  'permissions',
  'env',
  'defaults',
  'concurrency',
  'jobs',
]);

/** `jobs.<job_id>` keys GitHub documents (workflow syntax reference). */
const JOB_KEYS: ReadonlySet<string> = new Set([
  'name',
  'needs',
  'permissions',
  'if',
  'runs-on',
  'snapshot',
  'environment',
  'concurrency',
  'outputs',
  'env',
  'defaults',
  'steps',
  'timeout-minutes',
  'strategy',
  'continue-on-error',
  'container',
  'services',
  'uses',
  'with',
  'secrets',
]);

/** `jobs.<job_id>.steps[*]` keys GitHub documents. */
const STEP_KEYS: ReadonlySet<string> = new Set([
  'id',
  'if',
  'name',
  'uses',
  'run',
  'working-directory',
  'shell',
  'with',
  'env',
  'continue-on-error',
  'timeout-minutes',
]);

const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/** Whether `path` is a workflow GitHub would read (only `.github/workflows/`, not subdirectories). */
export function isWorkflowPath(path: string): boolean {
  return WORKFLOW_PATH.test(path);
}

// ---------------------------------------------------------------------------
// Line classification
// ---------------------------------------------------------------------------

type LineKind = 'blank' | 'comment' | 'content' | 'node';

interface Line {
  readonly raw: string;
  readonly indent: number;
  readonly kind: LineKind;
  /** For node lines: the line up to any trailing comment, trailing whitespace stripped. */
  readonly code: string;
  /** For node lines: the line starts with a `- ` sequence indicator. */
  readonly isItem: boolean;
  /** For node lines that are `key:` lines: the key, quotes stripped. */
  readonly key?: string;
  /** Column of `key` (or of the item's value). */
  readonly keyCol: number;
  /** For key lines: the value after `key:` (comment stripped, trimmed; `''` if none). */
  readonly value: string;
}

class Unparseable extends Error {}

function reject(lineNo: number, why: string): never {
  throw new Unparseable(`line ${lineNo + 1}: ${why}`);
}

interface CodeScan {
  /** Index of a trailing comment's `#`, or -1. */
  readonly commentAt: number;
  /** Column of the node owning a block-scalar header on this line, or -1 if none. */
  readonly blockParent: number;
  readonly blockKeep: boolean;
  /** Column of the node owning a trailing plain scalar (which may continue on deeper lines), or -1. */
  readonly plainParent: number;
  /** The line holds a non-empty flow mapping. */
  readonly flowMap: boolean;
}

const isSpace = (c: string | undefined): boolean => c === ' ';
const isBreakOrEnd = (c: string | undefined): boolean => c === undefined || isSpace(c);

/**
 * Walk one structural line the way a YAML scanner would at the positions
 * that matter here: node starts (after indentation, `- `, `key: `, and flow
 * separators). Quotes only open at a node start; ` #` starts a comment
 * anywhere outside quotes. Rejects anchors, aliases, tags, complex keys,
 * merge keys, unterminated or escaped quoted scalars, unclosed flow
 * collections and explicit block-scalar indentation indicators.
 */
function scanCode(s: string, lineNo: number): CodeScan {
  const n = s.length;
  let i = 0;
  let atStart = true;
  let depth = 0;
  let nodeCol = -1;
  let dashCol = -1;
  let plainParent = -1;
  let braceOpen = false;
  let flowMap = false;
  while (i < n) {
    const c = s[i];
    if (atStart) {
      if (isSpace(c)) {
        i++;
        continue;
      }
      if (braceOpen && c !== '}') flowMap = true;
      braceOpen = false;
      if (c === '#') return done(i);
      if (depth === 0 && c === '-' && isBreakOrEnd(s[i + 1])) {
        dashCol = i;
        nodeCol = -1;
        i++;
        continue;
      }
      if ((c === '&' || c === '*' || c === '!') && !isBreakOrEnd(s[i + 1])) {
        reject(
          lineNo,
          `${c === '&' ? 'anchor' : c === '*' ? 'alias' : 'tag'} is outside the subset`,
        );
      }
      if (c === '?' && isBreakOrEnd(s[i + 1])) reject(lineNo, 'complex key is outside the subset');
      if (depth === 0 && s.startsWith('<<', i) && /^<<\s*:/.test(s.slice(i))) {
        reject(lineNo, 'merge key is outside the subset');
      }
      if (depth === 0 && (c === '|' || c === '>')) {
        const header = /^[|>]([+-]?)([0-9]?)([+-]?) *(#.*)?$/.exec(s.slice(i));
        if (!header) reject(lineNo, 'malformed block scalar header');
        if (header[2] !== '') {
          reject(lineNo, 'explicit block-scalar indentation is outside the subset');
        }
        const keep = header[1] === '+' || header[3] === '+';
        const parent = nodeCol >= 0 ? nodeCol : dashCol >= 0 ? dashCol : 0;
        const hash = header[4] === undefined ? -1 : s.indexOf('#', i);
        return { commentAt: hash, blockParent: parent, blockKeep: keep, plainParent: -1, flowMap };
      }
      if (c === '"' || c === "'") {
        i = skipQuoted(s, i, lineNo);
        atStart = false;
        if (nodeCol < 0 && depth === 0) nodeCol = i;
        plainParent = -1;
        continue;
      }
      if (c === '[' || c === '{') {
        depth++;
        braceOpen = c === '{';
        i++;
        continue;
      }
      if (depth > 0 && (c === ']' || c === '}')) {
        depth--;
        i++;
        atStart = false;
        continue;
      }
      if (depth === 0) {
        // A plain scalar continues on lines deeper than its owner: the key,
        // or the `- ` of a bare sequence item.
        plainParent = nodeCol >= 0 ? nodeCol : dashCol >= 0 ? dashCol : i;
        if (nodeCol < 0) nodeCol = i;
      }
      atStart = false;
      continue;
    }
    if (c === '#' && isSpace(s[i - 1])) return done(i);
    if (c === ':' && (isBreakOrEnd(s[i + 1]) || (depth > 0 && /[,\]}]/.test(s[i + 1] ?? '')))) {
      // `key:` — the owning node of what follows is the key.
      if (depth === 0) {
        nodeCol = keyStart(s, i);
        dashCol = -1;
        plainParent = -1;
      } else {
        flowMap = true;
      }
      i++;
      atStart = true;
      continue;
    }
    if (depth > 0 && c === ',') {
      i++;
      atStart = true;
      continue;
    }
    if (depth > 0 && (c === ']' || c === '}')) {
      depth--;
      i++;
      continue;
    }
    if (depth > 0 && (c === '[' || c === '{')) {
      depth++;
      i++;
      continue;
    }
    i++;
  }
  return done(-1);

  function done(commentAt: number): CodeScan {
    if (depth > 0) reject(lineNo, 'multi-line flow collection is outside the subset');
    return {
      commentAt,
      blockParent: -1,
      blockKeep: false,
      plainParent: atStart ? -1 : plainParent,
      flowMap,
    };
  }
}

/** Column where the key ending at `colon` starts (after indentation and `- `). */
function keyStart(s: string, colon: number): number {
  const m = /^( *(?:- +)*)/.exec(s.slice(0, colon));
  return m ? m[1]!.length : 0;
}

function skipQuoted(s: string, open: number, lineNo: number): number {
  const q = s[open];
  let i = open + 1;
  while (i < s.length) {
    const c = s[i];
    if (q === '"' && c === '\\') {
      // Escapes (`\u0041`, `\x41`, `\N`, `\L`, `\P`, …) are a parser
      // differential surface: a key or value spelled with them reads
      // differently here and in GitHub.
      reject(lineNo, 'backslash escape in a double-quoted scalar is outside the subset');
    }
    if (c === q) {
      if (q === "'" && s[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return reject(lineNo, 'multi-line quoted scalar is outside the subset');
}

const KEY_LINE = /^(?:"([^"]*)"|'((?:[^']|'')*)'|([^ "'#[\]{},][^]*?)) *:(?: +([^]*))?$/;

/** Unicode space separators that `\s` would match but YAML treats as content. */
const UNICODE_SPACE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/;

/**
 * Whole-file character rules: line breaks and controls a YAML parser could
 * read differently from this line splitter. A BOM is allowed at offset 0 only.
 */
function checkCharacters(text: string): string {
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const checks: [RegExp, string][] = [
    [/\r(?!\n)/, 'bare carriage return'],
    [/[\u0085\u2028\u2029]/, 'Unicode line break'],
    [/\uFEFF/, 'byte-order mark after offset 0'],
    // eslint-disable-next-line no-control-regex -- the rule IS about control characters
    [/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/, 'control character'],
  ];
  for (const [re, why] of checks) {
    const m = re.exec(body);
    if (m) {
      const lineNo = body.slice(0, m.index).split('\n').length - 1;
      reject(lineNo, `${why} is outside the subset`);
    }
  }
  return body;
}

/** Split a physical file into classified lines, tracking block and plain multi-line scalars. */
function classify(text: string): Line[] {
  const physical = checkCharacters(text).split('\n');
  const out: Line[] = [];
  let block: { parent: number; indent: number | null; keep: boolean; pending: number[] } | null =
    null;
  let plain: number | null = null;
  let sawNode = false;

  const flushPending = (asContent: boolean): void => {
    if (!block) return;
    for (const idx of block.pending) {
      const l = out[idx]!;
      out[idx] = { ...l, kind: asContent ? 'content' : 'blank' };
    }
    block.pending = [];
  };
  /** Tabs and Unicode spaces are only safe inside block-scalar content. */
  const structuralChars = (raw: string, no: number): void => {
    if (raw.includes('\t')) reject(no, 'tab outside block-scalar content is outside the subset');
    if (UNICODE_SPACE.test(raw)) reject(no, 'non-ASCII space outside block-scalar content');
  };

  for (let no = 0; no < physical.length; no++) {
    const raw = physical[no]!.replace(/\r$/, '').replace(/[ \t]+$/, '');
    const lead = /^[ \t]*/.exec(raw)![0];
    if (lead.includes('\t')) reject(no, 'tab in indentation is outside the subset');
    const indent = lead.length;
    const base = { raw, indent, code: '', isItem: false, keyCol: indent, value: '' };
    if (raw.length === indent) {
      out.push({ ...base, kind: 'blank' });
      if (block) block.pending.push(out.length - 1);
      continue;
    }
    if (block) {
      if (block.indent === null && indent > block.parent) block.indent = indent;
      if (block.indent !== null && indent >= block.indent) {
        flushPending(true);
        out.push({ ...base, kind: 'content' });
        continue;
      }
      flushPending(block.keep);
      block = null;
    }
    const body = raw.slice(indent);
    if (body.startsWith('#')) {
      plain = null;
      out.push({ ...base, kind: 'comment' });
      continue;
    }
    structuralChars(raw, no);
    if (plain !== null && indent > plain) {
      // Continuation of a multi-line plain scalar: opaque text, like block content.
      out.push({ ...base, kind: 'content' });
      continue;
    }
    plain = null;
    if (indent === 0) {
      if (/^---(?: |$)/.test(body)) {
        if (sawNode || !/^--- *(?:#.*)?$/.test(body)) {
          reject(no, 'multi-document file is outside the subset');
        }
        sawNode = true;
        out.push({ ...base, kind: 'comment' });
        continue;
      }
      if (/^\.\.\.(?: |$)/.test(body)) reject(no, 'document end marker is outside the subset');
      if (body.startsWith('%')) reject(no, 'YAML directive is outside the subset');
    }
    sawNode = true;
    const scan = scanCode(raw, no);
    const code = (scan.commentAt >= 0 ? raw.slice(0, scan.commentAt) : raw).replace(/ +$/, '');
    const itemMatch = /^(?:-(?: +|$))+/.exec(code.slice(indent));
    const isItem = itemMatch !== null;
    if (itemMatch && (itemMatch[0].match(/-/g) ?? []).length > 1) {
      reject(no, 'nested inline sequence is outside the subset');
    }
    const restCol = indent + (itemMatch ? itemMatch[0].length : 0);
    const rest = code.slice(restCol);
    const km = KEY_LINE.exec(rest);
    let key: string | undefined;
    let value = rest.trim();
    if (km) {
      if (km[3] === undefined && !(indent === 0 && (km[1] ?? km[2]) === 'on')) {
        reject(no, 'quoted key is outside the subset');
      }
      key = km[1] ?? (km[2] === undefined ? km[3]!.trimEnd() : km[2].replaceAll("''", "'"));
      value = (km[4] ?? '').trim();
    }
    if (scan.flowMap && !(key === 'permissions' && value.startsWith('{'))) {
      reject(no, 'flow mapping is outside the subset');
    }
    out.push({
      ...base,
      kind: 'node',
      code,
      isItem,
      ...(key === undefined ? {} : { key }),
      keyCol: restCol,
      value,
    });
    if (scan.blockParent >= 0) {
      block = { parent: scan.blockParent, indent: null, keep: scan.blockKeep, pending: [] };
    } else if (scan.plainParent >= 0) {
      plain = scan.plainParent;
    }
  }
  if (block) flushPending(block.keep);
  return out;
}

/** Normalised text of `lines`: node code and block content, comments and structural blanks dropped. */
function normalise(lines: readonly Line[]): string {
  const kept: string[] = [];
  for (const l of lines) {
    if (l.kind === 'node') kept.push(l.code);
    else if (l.kind === 'content') kept.push(l.raw);
  }
  return kept.join('\n');
}

/** Strip one level of YAML quoting from a scalar; `null` if it is not a single literal. */
function unquote(value: string): string | null {
  if (value.startsWith('"')) {
    const m = /^"([^"\\]*)"$/.exec(value);
    return m ? m[1]! : null;
  }
  if (value.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'$/.exec(value);
    return m ? m[1]!.replaceAll("''", "'") : null;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Structure helpers
// ---------------------------------------------------------------------------

/** A key's line range: its key line at `at`, its block up to `end` (exclusive). */
interface Span {
  readonly at: number;
  end: number;
}

/**
 * The block-mapping children of the node at `start` (lines `start+1..end`):
 * one consistent indent deeper than `parentIndent`, keys only, no
 * duplicates, and (when given) only keys in `allowed`.
 */
function childrenOf(
  lines: readonly Line[],
  start: number,
  end: number,
  parentIndent: number,
  where: string,
  allowed?: ReadonlySet<string>,
): Map<string, Span> {
  const children = new Map<string, Span>();
  let indent: number | null = null;
  let last: Span | null = null;
  for (let i = start + 1; i < end; i++) {
    const l = lines[i]!;
    if (l.kind !== 'node') continue;
    indent ??= l.indent;
    if (l.indent <= parentIndent || l.indent < indent) {
      reject(i, `inconsistent indentation in ${where}`);
    }
    if (l.indent > indent) continue;
    if (l.isItem || l.key === undefined) reject(i, `${where} entry is not a \`key:\` line`);
    if (children.has(l.key)) reject(i, `duplicate key ${JSON.stringify(l.key)} in ${where}`);
    if (allowed && !allowed.has(l.key))
      reject(i, `unknown key ${JSON.stringify(l.key)} in ${where}`);
    if (last) last.end = i;
    last = { at: i, end };
    children.set(l.key, last);
  }
  return children;
}

/** A key's whole value as normalised text: the inline value plus its block. */
function valueText(lines: readonly Line[], span: Span): string {
  const rest = normalise(lines.slice(span.at + 1, span.end));
  return [lines[span.at]!.value, rest].filter((s) => s !== '').join('\n');
}

/** A scalar value's literal: unquoted inline value, or `null` if it is not a literal. */
function literalOf(lines: readonly Line[], span: Span | undefined): string | null {
  if (!span) return null;
  const inline = lines[span.at]!.value;
  if (inline === '' || /^[|>]/.test(inline)) return null;
  return unquote(inline);
}

interface Step {
  /** Ordinal of the step in its job. */
  readonly index: number;
  readonly keys: ReadonlyMap<string, Span>;
  /** `with:` inputs (empty when absent). */
  readonly inputs: ReadonlyMap<string, Span>;
}

/** Private structure the lint needs beyond the public {@link WorkflowJob}. */
interface JobDetail {
  readonly lines: readonly Line[];
  readonly steps: readonly Step[];
  readonly envText: string;
}

/** Private scan-level detail: the normalised top-level `name:`. */
interface ScanDetail {
  readonly name: string;
}

const JOB_DETAIL = new WeakMap<WorkflowJob, JobDetail>();
const SCAN_DETAIL = new WeakMap<OkScan, ScanDetail>();

/** Parse the `steps:` sequence into step mappings (fails closed on any other shape). */
function readSteps(lines: readonly Line[], span: Span, jobId: string): Step[] {
  const where = `steps of job ${JSON.stringify(jobId)}`;
  const keyLine = lines[span.at]!;
  if (keyLine.value !== '' && keyLine.value !== '[]') {
    reject(span.at, `${where}: inline value is outside the subset`);
  }
  const itemStarts: number[] = [];
  let itemIndent: number | null = null;
  for (let i = span.at + 1; i < span.end; i++) {
    const l = lines[i]!;
    if (l.kind !== 'node') continue;
    itemIndent ??= l.indent;
    if (l.indent <= keyLine.indent || l.indent < itemIndent) {
      reject(i, `inconsistent indentation in ${where}`);
    }
    if (l.indent > itemIndent) continue;
    if (!l.isItem) reject(i, `${where}: entry is not a \`- \` item`);
    itemStarts.push(i);
  }
  const steps: Step[] = [];
  for (let s = 0; s < itemStarts.length; s++) {
    const at = itemStarts[s]!;
    const end = itemStarts[s + 1] ?? span.end;
    const item = lines[at]!;
    const stepWhere = `step ${s + 1} of job ${JSON.stringify(jobId)}`;
    let keyIndent: number;
    let first: number;
    if (item.key !== undefined) {
      keyIndent = item.keyCol;
      first = at;
    } else if (item.value === '') {
      const next = lines.slice(at + 1, end).find((l) => l.kind === 'node');
      if (!next) reject(at, `${stepWhere} is empty`);
      keyIndent = next.indent;
      first = at + 1;
    } else {
      reject(at, `${stepWhere} is not a mapping`);
    }
    const keys = new Map<string, Span>();
    let last: Span | null = null;
    for (let i = first; i < end; i++) {
      const l = lines[i]!;
      if (l.kind !== 'node') continue;
      const col = i === at ? item.keyCol : l.indent;
      if (col < keyIndent || (i !== at && l.indent <= item.indent)) {
        reject(i, `inconsistent indentation in ${stepWhere}`);
      }
      if (col > keyIndent) continue;
      if ((i !== at && l.isItem) || l.key === undefined) {
        reject(i, `${stepWhere} entry is not a \`key:\` line`);
      }
      if (keys.has(l.key)) reject(i, `duplicate key ${JSON.stringify(l.key)} in ${stepWhere}`);
      if (!STEP_KEYS.has(l.key)) reject(i, `unknown key ${JSON.stringify(l.key)} in ${stepWhere}`);
      if (last) last.end = i;
      last = { at: i, end };
      keys.set(l.key, last);
    }
    const withSpan = keys.get('with');
    let inputs = new Map<string, Span>();
    if (withSpan) {
      const v = lines[withSpan.at]!.value;
      if (v !== '' && v !== '{}') reject(withSpan.at, `${stepWhere}: inline \`with:\` value`);
      inputs = childrenOf(lines, withSpan.at, withSpan.end, keyIndent, `with: of ${stepWhere}`);
    }
    steps.push({ index: s, keys, inputs });
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Privilege signals
// ---------------------------------------------------------------------------

const AMBIGUOUS_BOOLEAN_KEYS = new Set(['on', 'off', 'true', 'false', 'yes', 'no', 'y', 'n']);

/**
 * The non-read permission grants of a `permissions:` key (inline value or
 * block children). `[]` means read-only/none. Anything unrecognised is a
 * grant, because an unreadable permission set may be a write one.
 */
function permissionGrants(keyLine: Line, children: readonly Line[], lineNo: number): string[] {
  const value = keyLine.value;
  if (value !== '') {
    const scalar = unquote(value);
    if (scalar === 'read-all') return [];
    if (scalar === 'write-all') return ['permissions write-all'];
    const flow = /^\{(.*)\}$/.exec(value);
    if (flow) {
      const inner = flow[1]!.trim();
      if (inner === '') return [];
      const grants: string[] = [];
      for (const part of inner.split(',')) {
        const m = /^ *([^: ]+) *: *(.*?) *$/.exec(part);
        if (!m) grants.push(`permissions ${value}`);
        else grants.push(...levelGrant(m[1]!, m[2]!));
      }
      return grants;
    }
    return [`permissions ${value}`];
  }
  const nodes = children.filter((l) => l.kind === 'node' || l.kind === 'content');
  if (nodes.length === 0) return ['permissions (empty value)'];
  const scopeIndent = nodes[0]!.indent;
  const grants: string[] = [];
  for (const l of nodes) {
    if (l.kind !== 'node' || l.indent !== scopeIndent || l.isItem || l.key === undefined) {
      grants.push(`permissions block line ${lineNo + 1} unrecognised`);
      continue;
    }
    grants.push(...levelGrant(l.key, l.value));
  }
  return grants;
}

function levelGrant(scope: string, rawLevel: string): string[] {
  const level = unquote(rawLevel) ?? rawLevel;
  return level === 'read' || level === 'none' ? [] : [`permission ${scope}: ${level}`];
}

/**
 * Secret references in `text` other than `GITHUB_TOKEN`: `secrets.NAME`,
 * any `secrets[` index form, `secrets: inherit`, and — inside `${{ }}` —
 * any other use of the `secrets` context (e.g. `toJSON(secrets)`).
 * Expression contexts are case-insensitive, so matching is too.
 */
function secretReasons(text: string, suffix = ''): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\bsecrets\.([A-Za-z_][A-Za-z0-9_-]*)/gi)) {
    if (m[1]!.toUpperCase() !== 'GITHUB_TOKEN') out.add(`secret ${m[1]}${suffix}`);
  }
  if (/\bsecrets\s*\[/i.test(text)) out.add(`secrets[...] index${suffix}`);
  if (/\bsecrets\s*:\s*['"]?inherit\b/i.test(text)) out.add(`secrets: inherit${suffix}`);
  for (const expr of text.matchAll(/\$\{\{([\s\S]*?)(?:\}\}|$)/g)) {
    for (const m of expr[1]!.matchAll(
      /\bsecrets\b(?!\s*\.\s*GITHUB_TOKEN\b)(?!\.[A-Za-z_])(?!\s*\[)/gi,
    )) {
      if (m[0] !== '') out.add(`secrets context${suffix}`);
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

interface Block {
  readonly key: string;
  readonly start: number;
  readonly end: number;
}

/** Lines strictly after `start` up to `end` (exclusive). */
const bodyOf = (lines: readonly Line[], b: Block): Line[] => lines.slice(b.start + 1, b.end);

/**
 * Scan a workflow file into its recognised structure. Never throws: any input
 * outside the subset is `{ ok: false, reason }`.
 */
export function scanWorkflow(text: string): WorkflowScan {
  try {
    return scanOrThrow(text);
  } catch (error) {
    if (error instanceof Unparseable) return { ok: false, reason: error.message };
    throw error;
  }
}

function scanOrThrow(text: string): OkScan {
  const lines = classify(text);
  const blocks: Block[] = [];
  const seen = new Set<string>();
  let current: { key: string; start: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.kind !== 'node') continue;
    if (l.indent > 0) {
      if (current === null) reject(i, 'indented content before the first top-level key');
      continue;
    }
    if (l.isItem || l.key === undefined) reject(i, 'top-level line is not a `key:` line');
    let key = l.key;
    const quoted = !/^[^"']/.test(l.code);
    if (AMBIGUOUS_BOOLEAN_KEYS.has(key.toLowerCase())) {
      const isOn = key === 'on' || (!quoted && key === 'true');
      if (!isOn) reject(i, `ambiguous top-level key ${JSON.stringify(key)}`);
      key = 'on';
    }
    if (!TOP_LEVEL_KEYS.has(key)) reject(i, `unknown top-level key ${JSON.stringify(key)}`);
    if (seen.has(key)) reject(i, `duplicate top-level key ${JSON.stringify(key)}`);
    seen.add(key);
    if (current) blocks.push({ ...current, end: i });
    current = { key, start: i };
  }
  if (current) blocks.push({ ...current, end: lines.length });

  const byKey = new Map(blocks.map((b) => [b.key, b]));
  const onBlock = byKey.get('on');
  const jobsBlock = byKey.get('jobs');
  if (!onBlock) throw new Unparseable('no top-level `on:` key');
  if (!jobsBlock) throw new Unparseable('no top-level `jobs:` key');

  const { onText, triggers } = readOn(lines, onBlock);
  const context = blocks
    .filter((b) => !['name', 'run-name', 'on', 'jobs'].includes(b.key))
    .map((b) => normalise(lines.slice(b.start, b.end)))
    .join('\n');
  const nameBlock = byKey.get('name');
  const name = nameBlock ? normalise(lines.slice(nameBlock.start, nameBlock.end)) : '';

  const permsBlock = byKey.get('permissions');
  const topGrants = permsBlock
    ? permissionGrants(lines[permsBlock.start]!, bodyOf(lines, permsBlock), permsBlock.start)
    : null;
  const workflowSecrets = ['env', 'defaults'].flatMap((k) => {
    const b = byKey.get(k);
    return b ? secretReasons(normalise(lines.slice(b.start, b.end)), ` (workflow ${k})`) : [];
  });
  const envBlock = byKey.get('env');
  const workflowEnv = envBlock ? normalise(lines.slice(envBlock.start, envBlock.end)) : '';

  const jobs = readJobs(lines, jobsBlock, { topGrants, workflowSecrets, workflowEnv });
  const scan: OkScan = { ok: true, on: onText, context, triggers, jobs };
  SCAN_DETAIL.set(scan, { name });
  return scan;
}

function readOn(lines: readonly Line[], b: Block): { onText: string; triggers: string[] } {
  const keyLine = lines[b.start]!;
  const value = keyLine.value;
  const body = bodyOf(lines, b);
  const onText = [`on:${value === '' ? '' : ` ${value}`}`, normalise(body)]
    .filter((s) => s !== '')
    .join('\n');
  if (value !== '') {
    if (value.startsWith('{')) reject(b.start, 'flow-mapping `on:` is outside the subset');
    if (/^[|>]/.test(value)) reject(b.start, 'block-scalar `on:` is outside the subset');
    if (body.some((l) => l.kind === 'node' || l.kind === 'content')) {
      reject(b.start, '`on:` has both an inline value and a block');
    }
    const flow = /^\[(.*)\]$/.exec(value);
    const items = flow
      ? flow[1]!
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '')
      : [value];
    return { onText, triggers: items.map((s) => triggerName(s, b.start)) };
  }
  const nodes = body.filter((l) => l.kind === 'node');
  const k = nodes[0]?.indent;
  const triggers: string[] = [];
  for (let i = b.start + 1; i < b.end; i++) {
    const l = lines[i]!;
    if (l.kind !== 'node') continue;
    if (l.indent < k!) reject(i, 'inconsistent `on:` indentation');
    if (l.indent > k!) continue;
    if (l.key !== undefined && !l.isItem) triggers.push(l.key);
    else if (l.isItem && l.key === undefined) triggers.push(triggerName(l.value, i));
    else reject(i, 'unrecognised `on:` entry');
  }
  return { onText, triggers };
}

function triggerName(raw: string, lineNo: number): string {
  const name = unquote(raw.trim());
  if (name === null || name === '' || /[{}[\]]/.test(name)) reject(lineNo, 'unrecognised trigger');
  return name;
}

interface WorkflowLevel {
  readonly topGrants: string[] | null;
  readonly workflowSecrets: readonly string[];
  readonly workflowEnv: string;
}

function readJobs(
  lines: readonly Line[],
  b: Block,
  level: WorkflowLevel,
): Map<string, WorkflowJob> {
  if (lines[b.start]!.value !== '') {
    reject(b.start, '`jobs:` with an inline value is outside the subset');
  }
  const starts: number[] = [];
  let jobIndent: number | null = null;
  for (let i = b.start + 1; i < b.end; i++) {
    const l = lines[i]!;
    if (l.kind !== 'node') continue;
    jobIndent ??= l.indent;
    if (l.indent < jobIndent) reject(i, 'inconsistent job indentation');
    if (l.indent > jobIndent) continue;
    if (l.isItem || l.key === undefined) reject(i, 'job entry is not a `key:` line');
    if (l.value !== '') reject(i, `job ${JSON.stringify(l.key)} has an inline value`);
    starts.push(i);
  }
  const jobs = new Map<string, WorkflowJob>();
  for (let j = 0; j < starts.length; j++) {
    const start = starts[j]!;
    const end = starts[j + 1] ?? b.end;
    const id = lines[start]!.key!;
    if (jobs.has(id)) reject(start, `duplicate job id ${JSON.stringify(id)}`);
    jobs.set(id, readJob(lines, id, start, end, level));
  }
  return jobs;
}

function readJob(
  lines: readonly Line[],
  id: string,
  start: number,
  end: number,
  level: WorkflowLevel,
): WorkflowJob {
  const jobIndent = lines[start]!.indent;
  const children = childrenOf(lines, start, end, jobIndent, `job ${JSON.stringify(id)}`, JOB_KEYS);
  const stepsSpan = children.get('steps');
  const steps = stepsSpan ? readSteps(lines, stepsSpan, id) : [];

  const text = normalise(lines.slice(start, end));
  const reasons: string[] = [];

  const perms = children.get('permissions');
  if (perms) {
    reasons.push(
      ...permissionGrants(lines[perms.at]!, lines.slice(perms.at + 1, perms.end), perms.at),
    );
  } else if (level.topGrants === null) {
    reasons.push(REASON_DEFAULT_TOKEN);
  } else {
    reasons.push(...level.topGrants.map((g) => `${g} (inherited)`));
  }
  reasons.push(...secretReasons(text), ...level.workflowSecrets);
  if (children.has('environment')) reasons.push(REASON_ENVIRONMENT);
  if (children.has('uses')) reasons.push(REASON_REUSABLE);

  let name: string | undefined;
  let dynamicName = false;
  const nameSpan = children.get('name');
  if (nameSpan) {
    const literal = literalOf(lines, nameSpan);
    if (literal === null || literal === '' || literal.includes('${{')) dynamicName = true;
    else name = literal;
  }

  const localUses = new Set<string>();
  const addLocal = (span: Span | undefined): void => {
    const target = literalOf(lines, span);
    if (target?.startsWith('./')) localUses.add(target.slice(2).replace(/\/+$/, '') || '.');
  };
  addLocal(children.get('uses'));
  for (const step of steps) addLocal(step.keys.get('uses'));

  const envSpan = children.get('env');
  const job: WorkflowJob = {
    id,
    text,
    ...(name === undefined ? {} : { name }),
    dynamicName,
    privileged: reasons.length > 0,
    privilegeReasons: [...new Set(reasons)],
    localUses: [...localUses],
    hasRunSteps: steps.some((s) => s.keys.has('run')),
  };
  JOB_DETAIL.set(job, {
    lines,
    steps,
    envText: [level.workflowEnv, envSpan ? valueText(lines, envSpan) : ''].join('\n'),
  });
  return job;
}

// ---------------------------------------------------------------------------
// Consumers: producers, lint, diff
// ---------------------------------------------------------------------------

/**
 * Job ids whose check-run name is statically `check`: a literal `name:` equal
 * to it, or no `name:` key at all and the id equal to it. Dynamic names,
 * matrix jobs (GitHub suffixes their check names) and reusable-workflow calls
 * never produce, so a caller sees a missing producer, never a phantom one.
 */
/**
 * True when a job's check-run name cannot be decided statically: a dynamic or
 * non-literal name, a reusable-workflow call, or a matrix job (GitHub
 * suffixes matrix check names). {@link producersOf} never counts such a job.
 */
export function hasUnresolvableCheckName(job: WorkflowJob): boolean {
  return (
    job.dynamicName ||
    job.privilegeReasons.includes(REASON_REUSABLE) ||
    /(?:^|[\s{,])matrix\s*:/m.test(job.text)
  );
}

export function producersOf(scan: OkScan, check: string): string[] {
  const out: string[] = [];
  for (const job of scan.jobs.values()) {
    if (hasUnresolvableCheckName(job)) continue;
    const effective = job.name ?? job.id;
    if (effective === check) out.push(job.id);
  }
  return out;
}

/** Tokens naming the head side of a PR or triggering run. */
const HEAD_TOKENS = [
  'head_sha',
  'head_ref',
  'head.sha',
  'head.ref',
  'head_branch',
  'pull_request.head',
  'merge_commit_sha',
];

/** `${{ }}` expressions a checkout `ref:`/`repository:` may use: base-side values only. */
const BASE_EXPRESSIONS: ReadonlySet<string> = new Set([
  'github.sha',
  'github.ref',
  'github.event.repository.default_branch',
  'github.event.pull_request.base.sha',
  'github.event.pull_request.base.ref',
  'github.repository',
]);

const EXPRESSION = /\$\{\{([\s\S]*?)(?:\}\}|$)/g;
const GIT_MOVE = /\bgit\b[^\n;&|]*?\b(?:checkout|switch|reset|worktree)\b/;
const FALSE_LITERALS = new Set(['false', 'False', 'FALSE']);

/**
 * A lint finding with a stable identity (`<rule>:<job id>:<signal>`) so a
 * base/subject comparison does not depend on reason-text byte equality, and
 * a NEW violation inside an already-violating job is not suppressed.
 */
interface KeyedLint {
  readonly key: string;
  readonly finding: WorkflowFinding;
}

/**
 * ADR-0004 D-G.3 lint (always a failure, in both postures):
 *   1. a `pull_request_target` workflow whose job sets `environment:` or uses
 *      a secret other than `GITHUB_TOKEN`;
 *   2. a `pull_request_target`/`workflow_run` workflow that checks out head
 *      code: an `actions/checkout` `ref:`/`repository:` with any `${{ }}`
 *      expression outside the base allow-list (or naming `refs/pull/` or a
 *      head token), or a `run:` that moves the worktree (`git checkout`,
 *      `switch`, `reset`, `worktree`) to `FETCH_HEAD` or a head expression,
 *      or names `refs/pull/` / `pull/${{`. Fetching objects is not linted;
 *   3. in such a workflow, an `actions/checkout` step without
 *      `persist-credentials: false` in a job with `run:` steps (the checkout
 *      default persists the token);
 *   4. `persist-credentials` set to anything but a false literal in a job
 *      with `run:` steps (any trigger).
 */
export function lintWorkflow(path: string, scan: OkScan): WorkflowFinding[] {
  return keyedLint(path, scan).map((k) => k.finding);
}

function keyedLint(path: string, scan: OkScan): KeyedLint[] {
  const out = new Map<string, WorkflowFinding>();
  const add = (key: string, reason: string): void => {
    if (!out.has(key)) out.set(key, { kind: 'lint', path, reason });
  };
  const prt = scan.triggers.includes('pull_request_target');
  const untrusted = prt || scan.triggers.includes('workflow_run');
  const event = prt ? 'pull_request_target' : 'workflow_run';
  for (const job of scan.jobs.values()) {
    const detail = JOB_DETAIL.get(job);
    if (!detail) throw new Error(`lintWorkflow: job ${job.id} did not come from scanWorkflow`);
    const { lines } = detail;
    if (prt) {
      for (const r of job.privilegeReasons) {
        if (r === REASON_ENVIRONMENT) {
          add(
            `prt-privilege:${job.id}:environment`,
            `pull_request_target job ${job.id} has environment:`,
          );
        } else if (r.startsWith('secret')) {
          add(`prt-privilege:${job.id}:secret:${r}`, `pull_request_target job ${job.id} has ${r}`);
        }
      }
    }
    let checkoutOrdinal = 0;
    let persistOrdinal = 0;
    for (const step of detail.steps) {
      const uses = literalOf(lines, step.keys.get('uses'));
      const isCheckout = uses !== null && /^actions\/checkout(?:@|$)/i.test(uses);
      const persistSpan = step.inputs.get('persist-credentials');
      const persist = persistSpan ? literalOf(lines, persistSpan) : null;
      if (persistSpan && !(persist !== null && FALSE_LITERALS.has(persist))) {
        persistOrdinal++;
        if (job.hasRunSteps) {
          add(
            `persist-credentials:${job.id}:${persistOrdinal}`,
            `job ${job.id} sets persist-credentials: ${valueText(lines, persistSpan)} and has run: steps`,
          );
        }
      }
      if (!untrusted) continue;
      if (isCheckout) {
        checkoutOrdinal++;
        for (const field of ['ref', 'repository']) {
          const span = step.inputs.get(field);
          if (!span) continue;
          const value = valueText(lines, span);
          const why = headCheckoutValue(value);
          if (why !== null) {
            add(
              `head-checkout:${job.id}:${field}:${value}`,
              `${event} job ${job.id} checks out ${field}: ${value} (${why})`,
            );
          }
        }
        if (job.hasRunSteps && !(persist !== null && FALSE_LITERALS.has(persist))) {
          add(
            `checkout-credentials:${job.id}:${checkoutOrdinal}`,
            `${event} job ${job.id} checkout #${checkoutOrdinal} lacks persist-credentials: false and the job has run: steps`,
          );
        }
      }
      const runSpan = step.keys.get('run');
      if (runSpan) {
        const run = valueText(lines, runSpan);
        const envSpan = step.keys.get('env');
        const env = [detail.envText, envSpan ? valueText(lines, envSpan) : ''].join('\n');
        const why = headRun(run, env);
        if (why !== null) {
          add(
            `head-run:${job.id}:${why.line}`,
            `${event} job ${job.id} step ${step.index + 1} runs head code (${why.signal}: ${why.line})`,
          );
        }
      }
    }
  }
  return [...out].map(([key, finding]) => ({ key, finding }));
}

const mentionsHead = (text: string): string | undefined => {
  const lower = text.toLowerCase();
  return HEAD_TOKENS.find((t) => lower.includes(t));
};

/** Why a checkout `ref:`/`repository:` value may name head code, or `null` if it is base-only. */
function headCheckoutValue(value: string): string | null {
  if (value.toLowerCase().includes('refs/pull/')) return 'refs/pull/';
  for (const m of value.matchAll(EXPRESSION)) {
    const expr = m[1]!.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!BASE_EXPRESSIONS.has(expr))
      return `expression \${{ ${m[1]!.trim()} }} is not a base value`;
  }
  const token = mentionsHead(value);
  return token === undefined ? null : token;
}

/**
 * Why a `run:` script may check out head code, or `null`. Fetching objects
 * is fine; moving the worktree to `FETCH_HEAD` or a head expression (inline
 * or via the step/job/workflow `env:`) is not, and `refs/pull/` or
 * `pull/${{` anywhere is.
 */
function headRun(run: string, env: string): { signal: string; line: string } | null {
  const rows = run.split('\n').map((r) => r.trim());
  const first = (re: RegExp): string => rows.find((r) => re.test(r)) ?? rows[0] ?? '';
  if (/refs\/pull\//i.test(run)) return { signal: 'refs/pull/', line: first(/refs\/pull\//i) };
  if (/pull\/\$\{\{/i.test(run)) return { signal: 'pull/${{', line: first(/pull\/\$\{\{/i) };
  if (!GIT_MOVE.test(run)) return null;
  const moveLine = first(GIT_MOVE);
  if (/FETCH_HEAD/.test(run)) return { signal: 'FETCH_HEAD', line: moveLine };
  for (const text of [run, env]) {
    for (const m of text.matchAll(EXPRESSION)) {
      const token = mentionsHead(m[1]!);
      if (token !== undefined) return { signal: `head expression (${token})`, line: moveLine };
    }
  }
  return null;
}

/**
 * The policy findings for one workflow path between the range base and the
 * subject (`null` = absent at that end). Identical text yields nothing, not
 * even lint: an unchanged file is base-owned. Lint is regression-only: a new
 * file (or one whose base is unparseable) reports every violation; otherwise
 * only violations whose key is absent at the base.
 */
export function diffWorkflow(
  path: string,
  base: string | null,
  subject: string | null,
): WorkflowFinding[] {
  if (base === subject) return [];
  if (subject === null) {
    const scan = base === null ? null : scanWorkflow(base);
    const detail =
      scan?.ok === true
        ? ` (triggers: ${scan.triggers.join(', ') || 'none'}; jobs: ${[...scan.jobs.keys()].join(', ') || 'none'})`
        : '';
    return [
      {
        kind: 'workflow-removed',
        path,
        reason: `workflow deleted: its triggers and jobs are removed${detail}`,
      },
    ];
  }
  const after = scanWorkflow(subject);
  const findings: WorkflowFinding[] = [];
  const unparseable = (side: string, scan: WorkflowScan): void => {
    if (!scan.ok) {
      findings.push({
        kind: 'workflow-unparseable',
        path,
        reason: `${side} is outside the recognised workflow subset: ${scan.reason}`,
      });
    }
  };
  if (base === null) {
    findings.push({ kind: 'workflow-new', path, reason: 'workflow absent at the range base' });
    unparseable('subject', after);
    if (after.ok) findings.push(...lintWorkflow(path, after));
    return findings;
  }
  const before = scanWorkflow(base);
  unparseable('range base', before);
  unparseable('subject', after);
  if (before.ok && after.ok) {
    findings.push(...diffScans(path, before, after));
    // Regression-only: a violation the base already has is base-owned.
    const baseKeys = new Set(keyedLint(path, before).map((k) => k.key));
    for (const k of keyedLint(path, after)) {
      if (!baseKeys.has(k.key)) findings.push(k.finding);
    }
  } else if (after.ok) {
    // No parseable base to compare against: every subject violation counts.
    findings.push(...lintWorkflow(path, after));
  }
  return findings;
}

function diffScans(path: string, before: OkScan, after: OkScan): WorkflowFinding[] {
  const findings: WorkflowFinding[] = [];
  if (before.on !== after.on) {
    findings.push({
      kind: 'trigger-changed',
      path,
      reason: `on: changed (triggers ${before.triggers.join(', ') || 'none'} -> ${after.triggers.join(', ') || 'none'})`,
    });
  }
  // A workflow's `name:` is what `workflow_run: workflows:` matches, so a
  // rename changes which workflows fire (its own watchers, or it becomes a
  // watched name).
  const beforeName = SCAN_DETAIL.get(before)?.name;
  const afterName = SCAN_DETAIL.get(after)?.name;
  if (beforeName !== afterName) {
    findings.push({
      kind: 'trigger-changed',
      path,
      reason: `workflow name changed (${beforeName || '(none)'} -> ${afterName || '(none)'}): workflow_run watchers match on it`,
    });
  }
  const ids = new Set([...before.jobs.keys(), ...after.jobs.keys()]);
  const privileged: string[] = [];
  for (const id of ids) {
    const b = before.jobs.get(id);
    const a = after.jobs.get(id);
    if (!b?.privileged && !a?.privileged) continue;
    privileged.push(id);
    const change = !b ? 'added' : !a ? 'removed' : b.text !== a.text ? 'changed' : null;
    if (change === null) continue;
    const why = [...new Set([...(b?.privilegeReasons ?? []), ...(a?.privilegeReasons ?? [])])];
    findings.push({
      kind: 'privileged-job',
      path,
      reason: `privileged job ${id} ${change} (${why.join('; ')})`,
    });
  }
  if (before.context !== after.context && privileged.length > 0) {
    findings.push({
      kind: 'privileged-job',
      path,
      reason: `workflow-level context (permissions/env/defaults/concurrency) changed with privileged job(s) ${privileged.join(', ')}`,
    });
  }
  return findings;
}
