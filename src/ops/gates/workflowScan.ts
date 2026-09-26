// W1.9 (D11) — the conservative GitHub Actions workflow scanner the
// default-branch policy check uses to decide whether a workflow change needs
// a human. It is deliberately NOT a YAML parser (methods note, Decision 1): a
// parser dependency would change the lockfile and put third-party code on the
// privileged verification path. Instead it recognises the block-style subset
// real workflows are written in and FAILS CLOSED on everything else.
//
// Fail-closed direction: the scanner may over-flag, never under-flag.
//   - Anything outside the recognised subset (tabs in indentation, flow-style
//     `jobs`/`on` mappings, anchors/aliases/tags/merge keys, multi-document
//     files, duplicate keys, multi-line quoted or flow scalars, inconsistent
//     job indentation, explicit block-scalar indentation indicators) is
//     `{ ok: false }`; the caller turns that into a needs-human
//     `workflow-unparseable` finding.
//   - Privilege is a disjunction of textual signals: a job is privileged if
//     ANY signal fires, including a secret named only inside a `run:` script
//     (it is the job's text) and the default token when no `permissions:`
//     is declared anywhere (GitHub's default may be write).
//   - Change detection compares normalised text (comment-only and blank
//     structural lines dropped, trailing whitespace stripped); block-scalar
//     content is opaque text and is kept verbatim.
//   - The D-G.3 lint is REGRESSION-ONLY: existing violations are base-owned,
//     so on a changed file the lint judges only what the subject introduces
//     (a violation keyed `<rule>:<job id>` absent at the base). New files, and
//     files whose base is unparseable, report every violation.
//   - A job whose check-run name cannot be decided statically (dynamic or
//     non-literal `name:`, a matrix, a reusable-workflow call) never
//     "produces" a check, so the caller sees a missing producer rather than
//     a phantom one.

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
  /** The job has a `name:` whose value is not a plain literal (contains `${{`, a block scalar, escapes). */
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
  /** Column of `key`. */
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
}

const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t';
const isBreakOrEnd = (c: string | undefined): boolean => c === undefined || isSpace(c);

/**
 * Walk one structural line the way a YAML scanner would at the positions
 * that matter here: node starts (after indentation, `- `, `key: `, and flow
 * separators). Quotes only open at a node start; ` #` starts a comment
 * anywhere outside quotes. Rejects anchors, aliases, tags, complex keys,
 * merge keys, unterminated quoted scalars, unclosed flow collections and
 * explicit block-scalar indentation indicators.
 */
function scanCode(s: string, lineNo: number): CodeScan {
  const n = s.length;
  let i = 0;
  let atStart = true;
  let depth = 0;
  let nodeCol = -1;
  let dashCol = -1;
  let plainParent = -1;
  while (i < n) {
    const c = s[i];
    if (atStart) {
      if (isSpace(c)) {
        i++;
        continue;
      }
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
        const header = /^[|>]([+-]?)([0-9]?)([+-]?)\s*(#.*)?$/.exec(s.slice(i));
        if (!header) reject(lineNo, 'malformed block scalar header');
        if (header[2] !== '')
          reject(lineNo, 'explicit block-scalar indentation is outside the subset');
        const keep = header[1] === '+' || header[3] === '+';
        const parent = nodeCol >= 0 ? nodeCol : dashCol >= 0 ? dashCol : 0;
        const hash = header[4] === undefined ? -1 : s.indexOf('#', i);
        return { commentAt: hash, blockParent: parent, blockKeep: keep, plainParent: -1 };
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
    };
  }
}

/** Column where the key ending at `colon` starts (after indentation and `- `). */
function keyStart(s: string, colon: number): number {
  const m = /^(\s*(?:-\s+)*)/.exec(s.slice(0, colon));
  return m ? m[1]!.length : 0;
}

function skipQuoted(s: string, open: number, lineNo: number): number {
  const q = s[open];
  let i = open + 1;
  while (i < s.length) {
    const c = s[i];
    if (q === '"' && c === '\\') {
      i += 2;
      continue;
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

const KEY_LINE =
  /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s"'#[\]{},][^]*?))\s*:(?:\s+([^]*))?$/;

/** Split a physical file into classified lines, tracking block and plain multi-line scalars. */
function classify(text: string): Line[] {
  const physical = text.replace(/^\uFEFF/, '').split('\n');
  const out: Line[] = [];
  let block: { parent: number; indent: number | null; keep: boolean; pending: number[] } | null =
    null;
  let plain: number | null = null;
  let sawNode = false;

  const push = (line: Line): void => {
    out.push(line);
  };
  const flushPending = (asContent: boolean): void => {
    if (!block) return;
    for (const idx of block.pending) {
      const l = out[idx]!;
      out[idx] = { ...l, kind: asContent ? 'content' : 'blank' };
    }
    block.pending = [];
  };

  for (let no = 0; no < physical.length; no++) {
    const raw = physical[no]!.replace(/\r$/, '').replace(/\s+$/, '');
    const lead = /^[ \t]*/.exec(raw)![0];
    if (lead.includes('\t')) reject(no, 'tab in indentation is outside the subset');
    const indent = lead.length;
    const base = { raw, indent, code: '', isItem: false, keyCol: indent, value: '' };
    if (raw.length === indent) {
      push({ ...base, kind: 'blank' });
      if (block) block.pending.push(out.length - 1);
      continue;
    }
    if (block) {
      if (block.indent === null && indent > block.parent) block.indent = indent;
      if (block.indent !== null && indent >= block.indent) {
        flushPending(true);
        push({ ...base, kind: 'content' });
        continue;
      }
      flushPending(block.keep);
      block = null;
    }
    const body = raw.slice(indent);
    if (body.startsWith('#')) {
      plain = null;
      push({ ...base, kind: 'comment' });
      continue;
    }
    if (plain !== null && indent > plain) {
      // Continuation of a multi-line plain scalar: opaque text, like block content.
      push({ ...base, kind: 'content' });
      continue;
    }
    plain = null;
    if (indent === 0) {
      if (/^---(?:\s|$)/.test(body)) {
        if (sawNode || !/^---\s*(?:#.*)?$/.test(body)) {
          reject(no, 'multi-document file is outside the subset');
        }
        sawNode = true;
        push({ ...base, kind: 'comment' });
        continue;
      }
      if (/^\.\.\.(?:\s|$)/.test(body)) reject(no, 'document end marker is outside the subset');
      if (body.startsWith('%')) reject(no, 'YAML directive is outside the subset');
    }
    sawNode = true;
    const scan = scanCode(raw, no);
    const code = (scan.commentAt >= 0 ? raw.slice(0, scan.commentAt) : raw).replace(/\s+$/, '');
    const itemMatch = /^(?:-(?:\s+|$))+/.exec(code.slice(indent));
    const isItem = itemMatch !== null;
    const restCol = indent + (itemMatch ? itemMatch[0].length : 0);
    const rest = code.slice(restCol);
    const km = KEY_LINE.exec(rest);
    if (km) {
      const key = km[1] ?? (km[2] === undefined ? km[3]!.trimEnd() : km[2].replaceAll("''", "'"));
      push({
        ...base,
        kind: 'node',
        code,
        isItem,
        key,
        keyCol: restCol,
        value: (km[4] ?? '').trim(),
      });
    } else {
      push({ ...base, kind: 'node', code, isItem, keyCol: restCol, value: rest.trim() });
    }
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
        const m = /^\s*([^:\s]+)\s*:\s*(.*?)\s*$/.exec(part);
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

  const permsBlock = byKey.get('permissions');
  const topGrants = permsBlock
    ? permissionGrants(lines[permsBlock.start]!, bodyOf(lines, permsBlock), permsBlock.start)
    : null;
  const workflowSecrets = ['env', 'defaults'].flatMap((k) => {
    const b = byKey.get(k);
    return b ? secretReasons(normalise(lines.slice(b.start, b.end)), ` (workflow ${k})`) : [];
  });

  const jobs = readJobs(lines, jobsBlock, topGrants, workflowSecrets);
  return { ok: true, on: onText, context, triggers, jobs };
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

function readJobs(
  lines: readonly Line[],
  b: Block,
  topGrants: string[] | null,
  workflowSecrets: readonly string[],
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
    jobs.set(id, readJob(lines, id, start, end, topGrants, workflowSecrets));
  }
  return jobs;
}

function readJob(
  lines: readonly Line[],
  id: string,
  start: number,
  end: number,
  topGrants: string[] | null,
  workflowSecrets: readonly string[],
): WorkflowJob {
  const jobIndent = lines[start]!.indent;
  let childIndent: number | null = null;
  const children = new Map<string, { at: number; end: number }>();
  let lastChild: string | null = null;
  for (let i = start + 1; i < end; i++) {
    const l = lines[i]!;
    if (l.kind !== 'node') continue;
    childIndent ??= l.indent;
    if (l.indent <= jobIndent || l.indent < childIndent) {
      reject(i, `inconsistent indentation in job ${JSON.stringify(id)}`);
    }
    if (l.indent > childIndent) continue;
    if (l.isItem || l.key === undefined) {
      reject(i, `job ${JSON.stringify(id)} entry is not a \`key:\` line`);
    }
    if (children.has(l.key))
      reject(i, `duplicate key ${JSON.stringify(l.key)} in job ${JSON.stringify(id)}`);
    if (lastChild !== null) children.get(lastChild)!.end = i;
    children.set(l.key, { at: i, end });
    lastChild = l.key;
  }

  const jobLines = lines.slice(start, end);
  const text = normalise(jobLines);
  const reasons: string[] = [];

  const perms = children.get('permissions');
  if (perms) {
    reasons.push(
      ...permissionGrants(lines[perms.at]!, lines.slice(perms.at + 1, perms.end), perms.at),
    );
  } else if (topGrants === null) {
    reasons.push(REASON_DEFAULT_TOKEN);
  } else {
    reasons.push(...topGrants.map((g) => `${g} (inherited)`));
  }
  reasons.push(...secretReasons(text), ...workflowSecrets);
  if (children.has('environment')) reasons.push(REASON_ENVIRONMENT);
  if (children.has('uses')) reasons.push(REASON_REUSABLE);

  let name: string | undefined;
  let dynamicName = false;
  const nameChild = children.get('name');
  if (nameChild) {
    const literal = unquote(lines[nameChild.at]!.value);
    if (literal === null || literal === '' || literal.includes('${{') || /^[|>]/.test(literal)) {
      dynamicName = true;
    } else {
      name = literal;
    }
  }

  const localUses = new Set<string>();
  let hasRunSteps = false;
  for (const l of jobLines) {
    if (l.kind !== 'node') continue;
    for (const m of l.code.matchAll(/(?:^|[\s{,])uses\s*:\s*['"]?\.\/([^\s'",}]*)/g)) {
      localUses.add(m[1]!.replace(/\/+$/, '') || '.');
    }
    if (/(?:^|[\s{,])run\s*:\s*[^\s{]/.test(l.code)) hasRunSteps = true;
  }

  return {
    id,
    text,
    ...(name === undefined ? {} : { name }),
    dynamicName,
    privileged: reasons.length > 0,
    privilegeReasons: [...new Set(reasons)],
    localUses: [...localUses],
    hasRunSteps,
  };
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
export function producersOf(scan: OkScan, check: string): string[] {
  const out: string[] = [];
  for (const job of scan.jobs.values()) {
    if (job.dynamicName || job.privilegeReasons.includes(REASON_REUSABLE)) continue;
    if (/(?:^|[\s{,])matrix\s*:/m.test(job.text)) continue;
    const effective = job.name ?? job.id;
    if (effective === check) out.push(job.id);
  }
  return out;
}

const HEAD_REF_TOKENS = [
  'head_sha',
  'head_ref',
  'head.sha',
  'head.ref',
  'head_branch',
  'pull_request.head',
  'refs/pull/',
  'merge_commit_sha',
];

/**
 * ADR-0004 D-G.3 lint (always a failure, in both postures):
 *   1. a `pull_request_target` workflow whose job sets `environment:` or uses
 *      a secret other than `GITHUB_TOKEN`;
 *   2. a `pull_request_target`/`workflow_run` workflow checking out a head
 *      ref with `actions/checkout`;
 *   3. `persist-credentials: true` in a job with `run:` steps.
 */
export function lintWorkflow(path: string, scan: OkScan): WorkflowFinding[] {
  return keyedLint(path, scan).map((k) => k.finding);
}

/**
 * A lint finding with a stable identity, `<rule>:<job id>`, so a base/subject
 * comparison does not depend on reason-text byte equality.
 */
interface KeyedLint {
  readonly key: string;
  readonly finding: WorkflowFinding;
}

function keyedLint(path: string, scan: OkScan): KeyedLint[] {
  const findings: KeyedLint[] = [];
  const prt = scan.triggers.includes('pull_request_target');
  const untrusted = prt || scan.triggers.includes('workflow_run');
  for (const job of scan.jobs.values()) {
    if (prt) {
      const hits = job.privilegeReasons.filter(
        (r) => r === REASON_ENVIRONMENT || r.startsWith('secret'),
      );
      if (hits.length > 0) {
        findings.push({
          key: `prt-privilege:${job.id}`,
          finding: {
            kind: 'lint',
            path,
            reason: `pull_request_target job ${job.id} has ${hits.join(', ')}`,
          },
        });
      }
    }
    if (untrusted) {
      for (const ref of checkoutRefs(job.text)) {
        const lower = ref.toLowerCase();
        const token = HEAD_REF_TOKENS.find((t) => lower.includes(t));
        if (token !== undefined) {
          findings.push({
            key: `head-checkout:${job.id}`,
            finding: {
              kind: 'lint',
              path,
              reason: `${prt ? 'pull_request_target' : 'workflow_run'} job ${job.id} checks out a head ref (${token})`,
            },
          });
        }
      }
    }
    if (
      job.hasRunSteps &&
      /(?:^|[\s{,])persist-credentials\s*:\s*(['"]?)true\1(?=\s*[,}]|\s*$)/im.test(job.text)
    ) {
      findings.push({
        key: `persist-credentials:${job.id}`,
        finding: {
          kind: 'lint',
          path,
          reason: `job ${job.id} sets persist-credentials: true and has run: steps`,
        },
      });
    }
  }
  return findings;
}

/** `ref:` values of the `actions/checkout` steps in a job's normalised text. */
function checkoutRefs(jobText: string): string[] {
  const rows = jobText.split('\n');
  const indentOf = (s: string): number => /^ */.exec(s)![0].length;
  // Step boundaries: `- ` items at the shallowest item indent under `steps:`.
  const stepsAt = rows.findIndex((r) => /^\s+steps\s*:\s*$/.test(r));
  if (stepsAt < 0) return [];
  const stepsIndent = indentOf(rows[stepsAt]!);
  let end = rows.length;
  for (let i = stepsAt + 1; i < rows.length; i++) {
    if (rows[i]!.trim() !== '' && indentOf(rows[i]!) <= stepsIndent) {
      end = i;
      break;
    }
  }
  const body = rows.slice(stepsAt + 1, end);
  const itemIndent = body.find((r) => r.trim() !== '');
  if (itemIndent === undefined) return [];
  const s = indentOf(itemIndent);
  const steps: string[][] = [];
  for (const r of body) {
    if (indentOf(r) === s && /^\s*-(?:\s|$)/.test(r)) steps.push([r]);
    else steps.at(-1)?.push(r);
  }
  const refs: string[] = [];
  for (const step of steps) {
    const joined = step.join('\n');
    if (!/(?:^|[\s{,-])uses\s*:\s*['"]?actions\/checkout(?:@|['"\s,}]|$)/im.test(joined)) continue;
    for (let i = 0; i < step.length; i++) {
      const m = /(?:^|[\s{,])ref\s*:(.*)$/.exec(step[i]!);
      if (!m) continue;
      const keyIndent = indentOf(step[i]!);
      const value = [m[1]!];
      for (let k = i + 1; k < step.length && indentOf(step[k]!) > keyIndent; k++)
        value.push(step[k]!);
      refs.push(value.join('\n'));
    }
  }
  return refs;
}

/**
 * The policy findings for one workflow path between the range base and the
 * subject (`null` = absent at that end). Identical text yields nothing, not
 * even lint: an unchanged file is base-owned. Lint is regression-only: a new
 * file (or one whose base is unparseable) reports every violation; otherwise
 * only violations whose `<rule>:<job id>` key is absent at the base.
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
