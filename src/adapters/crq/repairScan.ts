/**
 * Local repair-patch scanner adapter.
 *
 * Reuses the existing denylist rule engine and gitleaks defaults scanner; the
 * only ported Python detail is `crq.ALLOWLIST_PATHS`. The adapter parses the
 * patch on LF line boundaries (stripping CRLF terminators), scans added/removed
 * content, and returns counts only. It never returns matched text, a secret,
 * a remote scan or a persisted report.
 */
import {
  makeGitleaksDefaultsScanner,
  type DenylistRule,
  type GitleaksEffects,
} from '../../ops/dev/denylist.js';
import type {
  RepairScan,
  RepairScanReport,
  RepairScanResult,
} from '../../ops/crq/internal/repairPrepareGates.js';

/** `crq.ALLOWLIST_PATHS`, verbatim. */
const ALLOWLIST_PATHS: readonly RegExp[] = [
  /(^|\/)\.git\//,
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)\.gjc\//,
  /(^|\/)\.DS_Store$/,
  /^policy\/denylist\/patterns\.yml$/,
];

function allowlisted(path: string): boolean {
  return ALLOWLIST_PATHS.some((pattern) => pattern.test(path));
}

interface PatchLine {
  readonly path: string;
  readonly content: string;
}

/**
 * Parse the patch on LF only; only added/removed content counts.
 *
 * A trailing CR is a CRLF terminator, but any other line-break byte stays in
 * the payload. Python `splitlines` would turn text after a lone CR into a
 * separate unprefixed line that this parser must not drop, because an
 * instruction such as `fix it\rpk-...` would otherwise hide a denylisted
 * value from the scan.
 */
function patchLines(patch: string): PatchLine[] {
  let path: string | undefined;
  let inHeader = false;
  const lines: PatchLine[] = [];
  for (const rawLine of patch.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith('diff --git')) {
      const match = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      path = match?.[2];
      inHeader = true;
      continue;
    }
    if (line.startsWith('@@')) {
      inHeader = false;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('+++ ') || line.startsWith('--- ')) {
        const candidate = line.slice(4);
        if (candidate !== '/dev/null') {
          path =
            candidate.startsWith('a/') || candidate.startsWith('b/')
              ? candidate.slice(2)
              : candidate;
        }
      }
      continue;
    }
    if (path === undefined || line.length === 0) continue;
    const prefix = line[0];
    if (prefix !== '+' && prefix !== '-') continue;
    lines.push({ path, content: line.slice(1) });
  }
  return lines;
}

interface CompiledRule {
  readonly regex: RegExp;
  readonly path: RegExp | undefined;
}

function compileRules(rules: readonly DenylistRule[]): CompiledRule[] {
  return rules.map((rule) => ({
    regex: new RegExp(rule.regex),
    path: rule.path === undefined ? undefined : new RegExp(rule.path),
  }));
}

function countDenylistHits(lines: readonly PatchLine[], rules: readonly CompiledRule[]): number {
  let hits = 0;
  for (const line of lines) {
    if (allowlisted(line.path)) continue;
    for (const rule of rules) {
      if (rule.path !== undefined && !rule.path.test(line.path)) continue;
      if (rule.regex.test(line.content)) hits += 1;
    }
  }
  return hits;
}

interface GitleaksVerdict {
  readonly gitleaks: RepairScanReport['gitleaks'];
  readonly gitleaksHits: number;
}

async function gitleaksVerdict(input: {
  readonly patch: string;
  readonly path: string;
  readonly effects: GitleaksEffects;
  readonly available: () => boolean | Promise<boolean>;
}): Promise<GitleaksVerdict> {
  let available: boolean;
  try {
    available = await input.available();
  } catch {
    return { gitleaks: 'error', gitleaksHits: 0 };
  }
  if (!available) return { gitleaks: 'not-run', gitleaksHits: 0 };
  try {
    const scanner = makeGitleaksDefaultsScanner(input.effects);
    const components = await scanner([
      { component: 'repair-patch', text: input.patch, path: input.path },
    ]);
    if (!Array.isArray(components) || components.length !== 1) {
      return { gitleaks: 'error', gitleaksHits: 0 };
    }
    const hits = components[0]?.hits;
    if (!Array.isArray(hits)) return { gitleaks: 'error', gitleaksHits: 0 };
    let gitleaksHits = 0;
    for (const hit of hits) {
      if (hit === null || typeof hit !== 'object') {
        return { gitleaks: 'error', gitleaksHits: 0 };
      }
      const record = hit as { readonly ruleId?: unknown; readonly lines?: unknown };
      if (typeof record.ruleId !== 'string' || record.ruleId === '') {
        return { gitleaks: 'error', gitleaksHits: 0 };
      }
      if (!Array.isArray(record.lines) || record.lines.length === 0) {
        return { gitleaks: 'error', gitleaksHits: 0 };
      }
      for (const line of record.lines) {
        if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1) {
          return { gitleaks: 'error', gitleaksHits: 0 };
        }
      }
      gitleaksHits += record.lines.length;
    }
    return { gitleaks: gitleaksHits > 0 ? 'hits' : 'clean', gitleaksHits };
  } catch {
    return { gitleaks: 'error', gitleaksHits: 0 };
  }
}

/**
 * Build the scanner. `gitleaksAvailable` is an injected availability probe;
 * an absent probe means the caller owns the binary check. A failing gitleaks
 * is never reported clean; an unavailable gitleaks reports `not-run` with
 * `clean` decided by the denylist alone (the caller classifies it as skipped).
 */
export function makeRepairScan(input: {
  readonly rules: readonly DenylistRule[];
  readonly gitleaksEffects: GitleaksEffects;
  readonly gitleaksAvailable?: () => boolean | Promise<boolean>;
}): RepairScan {
  const rules = compileRules(input.rules);
  const available = input.gitleaksAvailable ?? (() => true);
  return {
    async scanDiff(request): Promise<RepairScanResult> {
      const lines = patchLines(request.patch);
      const denylistHits = countDenylistHits(lines, rules);
      const path = lines[0]?.path ?? 'unknown';
      const verdict = await gitleaksVerdict({
        patch: request.patch,
        path,
        effects: input.gitleaksEffects,
        available,
      });
      const clean =
        denylistHits === 0 && verdict.gitleaks !== 'error' && verdict.gitleaksHits === 0;
      return {
        clean,
        report: {
          denylistRules: rules.length,
          denylistHits,
          gitleaks: verdict.gitleaks,
          gitleaksHits: verdict.gitleaksHits,
        },
      };
    },
  };
}
