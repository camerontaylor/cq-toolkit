// A deliberately bounded per-fix map, not the full affected import closure.
// Reuse the wrapper's test predicate, reviewed non-import mappings and cap.
import { isTest, NON_IMPORT_MAP } from './affected-tests.mjs';

export function selectRelatedTests(changed, allTests) {
  const selected = new Set();
  for (const file of changed) {
    if (isTest(file) && allTests.includes(file)) selected.add(file);
    const stem = /^src\/(.*)\.(?:ts|mts|js|mjs)$/.exec(file)?.[1];
    if (stem) {
      const prefix = `test/${stem}`;
      for (const test of allTests)
        if (test.startsWith(prefix) && !test.slice(prefix.length).includes('/')) selected.add(test);
    }
    for (const [pattern, targets] of NON_IMPORT_MAP) {
      if (pattern.test(file))
        for (const test of allTests)
          if (targets.some((target) => target.test(test))) selected.add(test);
    }
  }
  const files = [...selected].sort();
  return { files, advisory: files.length === 0 ? 'no related tests mapped' : undefined };
}
