// eslint JSON-formatter adapter — the wire is an ARRAY of per-file results,
// each carrying a `messages` array ({ruleId, severity 1|2, line, column,
// message}). Severity 1 maps to warning, 2 to error; ruleId null stays null
// (fatal parse errors carry no rule). A valid array — including an empty one
// behind exit 0 — parses; anything that is not an array of objects with a
// `messages` array (truncated JSON, object-shaped output, empty stdout, a
// `diagnostics[]`-shaped stand-in) is indeterminate, never clean (I5).
import type {
  CheckAdapter,
  CheckFailure,
  CheckParseResult,
  RawCheckOutput,
} from '../checkRunner.js';

/** Adapter for eslint's `--format json` output. */
export const eslintJsonAdapter: CheckAdapter = {
  name: 'eslint-json',
  parse: parseEslintJson,
};

function parseEslintJson(raw: RawCheckOutput): CheckParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.stdout);
  } catch {
    return { verdict: 'indeterminate', reason: 'eslint-json: output is not valid JSON' };
  }
  if (!Array.isArray(parsed)) {
    return {
      verdict: 'indeterminate',
      reason: 'eslint-json: expected a top-level array of per-file results',
    };
  }
  const failures: CheckFailure[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object' || !Array.isArray(entry.messages)) {
      return {
        verdict: 'indeterminate',
        reason: 'eslint-json: per-file result without a messages[] array',
      };
    }
    const file = typeof entry.filePath === 'string' ? entry.filePath : null;
    for (const message of entry.messages) {
      const severity = severityOf(message?.severity);
      if (severity === null || typeof message?.message !== 'string') {
        return {
          verdict: 'indeterminate',
          reason: 'eslint-json: message without severity 1|2 or message text',
        };
      }
      failures.push({
        file,
        line: numberOrNull(message.line),
        column: numberOrNull(message.column),
        ruleId: typeof message.ruleId === 'string' ? message.ruleId : null,
        message: message.message,
        severity,
      });
    }
  }
  return { verdict: 'parsed', set: { tool: 'eslint', failures, exitCode: raw.exitCode } };
}

/** eslint severity 1 → warning, 2 → error; anything else is not eslint's wire. */
function severityOf(value: unknown): 'error' | 'warning' | null {
  if (value === 1) {
    return 'warning';
  }
  if (value === 2) {
    return 'error';
  }
  return null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
