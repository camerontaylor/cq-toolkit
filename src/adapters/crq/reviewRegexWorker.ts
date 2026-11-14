import { parentPort, workerData } from 'node:worker_threads';
import { translatePythonReviewPattern } from '../../policy/crq/pythonReviewRegex.js';
import type { ReviewRegexBatch } from './reviewRegexMatcher.js';

try {
  const input = workerData as ReviewRegexBatch;
  const rules = input.rules.map((rule) => ({
    text: new RegExp(translatePythonReviewPattern(rule.regex), 'u'),
    path: rule.path === null ? null : new RegExp(translatePythonReviewPattern(rule.path), 'u'),
  }));
  const hits: [number, number][] = [];
  for (const [lineIndex, line] of input.lines.entries()) {
    for (const [ruleIndex, rule] of rules.entries()) {
      if ((!rule.path || rule.path.test(line.path)) && rule.text.test(line.text)) {
        if (hits.length >= 100000) throw new Error('too many matches');
        hits.push([lineIndex, ruleIndex]);
      }
    }
  }
  parentPort?.postMessage({ ok: true, hits });
} catch {
  parentPort?.postMessage({ ok: false });
}
