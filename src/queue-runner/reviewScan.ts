/** Inactive general review scan orchestration. No production matcher or gitleaks binding. */
import { parseDenylistPatterns } from '../ops/dev/denylist.js';
import { pythonSplitlines } from '../policy/crq/repairGates.js';
import { atomicJsonText } from '../policy/crq/pythonJson.js';
import type { ReviewScanDecision } from './reviewPreparation.js';

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
export interface ReviewScannerEffects {
  /** Must implement Python re.compile/search semantics, or throw. Never use JS regex as a parity substitute. */
  compile(pattern: string): (text: string) => boolean;
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
  let rules: {
    id: string;
    match: (text: string) => boolean;
    path: ((text: string) => boolean) | null;
  }[];
  try {
    rules = selected.map((rule) => ({
      id: rule.id,
      match: effects.compile(rule.regex),
      path: rule.path === undefined ? null : effects.compile(rule.path),
    }));
    if (
      rules.some(
        (rule) =>
          typeof rule.match !== 'function' ||
          (rule.path !== null && typeof rule.path !== 'function'),
      )
    )
      throw new Error('invalid matcher');
  } catch {
    throw new Error('review scan matcher unavailable');
  }
  const hits: { rule: string; file: string; diff_line: number }[] = [];
  let path: string | null = null;
  let header = false;
  const lines = pythonSplitlines(input.diff);
  for (const [index, line] of lines.entries()) {
    if (line.startsWith('diff --git')) {
      path = /^diff --git a\/(.*) b\/(.*)$/.exec(line)?.[2] ?? null;
      header = true;
      continue;
    }
    if (line.startsWith('@@')) {
      header = false;
      continue;
    }
    if (header) {
      if (line.startsWith('+++ ') || line.startsWith('--- ')) {
        const next = line.slice(4);
        if (next !== '/dev/null')
          path = next.startsWith('a/') || next.startsWith('b/') ? next.slice(2) : next;
      }
      continue;
    }
    if (!line || (line[0] !== '+' && line[0] !== '-') || path === null) continue;
    const currentPath = path;
    if (allow.some((p) => p.test(currentPath))) continue;
    for (const rule of rules) {
      try {
        const inPath = rule.path === null ? true : rule.path(path);
        if (typeof inPath !== 'boolean') throw new Error('invalid matcher result');
        if (!inPath) continue;
        const matched = rule.match(line.slice(1));
        if (typeof matched !== 'boolean') throw new Error('invalid matcher result');
        if (matched) hits.push({ rule: rule.id, file: path, diff_line: index + 1 });
      } catch {
        throw new Error('review scan matcher unavailable');
      }
    }
  }
  let gl: Awaited<ReturnType<ReviewScannerEffects['gitleaks']>>;
  try {
    gl = await effects.gitleaks(input.diff);
  } catch {
    throw new Error('review gitleaks unavailable');
  }
  let status = 'not-run';
  let glHits: { rule: string | null; diff_line: number | null }[] = [];
  if (gl.kind === 'exit') {
    if (!Number.isSafeInteger(gl.code)) throw new Error('invalid gitleaks result');
    status = `exit ${gl.code}`;
    if (gl.code !== 0) glHits = [{ rule: 'gitleaks-error', diff_line: null }];
    else {
      if (!Array.isArray(gl.hits)) throw new Error('gitleaks report unavailable');
      glHits = gl.hits.map((hit: { rule: string | null; diffLine: number | null }) => {
        if (
          !hit ||
          (hit.rule !== null && typeof hit.rule !== 'string') ||
          (hit.diffLine !== null && (!Number.isSafeInteger(hit.diffLine) || hit.diffLine < 1))
        )
          throw new Error('invalid gitleaks report');
        return { rule: hit.rule, diff_line: hit.diffLine };
      });
    }
  } else if (gl.kind !== 'not-run') throw new Error('invalid gitleaks result');
  const report = {
    base: input.base,
    head: input.head,
    denylist_rules: rules.length,
    denylist_hits: hits,
    gitleaks: status,
    gitleaks_hits: glHits,
    diff_bytes: Array.from(input.diff).length,
  };
  await effects.writeReport(atomicJsonText(report));
  return {
    clean: hits.length === 0 && glHits.length === 0,
    denylistHits: hits.length,
    gitleaksHits: glHits.length,
    artifactPath: input.artifactPath,
  };
}
