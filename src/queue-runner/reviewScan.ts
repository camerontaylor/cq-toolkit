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
  const candidates: { path: string; text: string; diffLine: number }[] = [];
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
    candidates.push({ path, text: line.slice(1), diffLine: index + 1 });
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
      hits.push({ rule: rule.id, file: candidate.path, diff_line: candidate.diffLine });
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
