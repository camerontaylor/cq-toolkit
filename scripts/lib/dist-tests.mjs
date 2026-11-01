import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Check selected test contents rather than a list that drifts when fixtures
// acquire a dist dependency. False positives cost a build, not correctness.
export function needsDist(files, root) {
  return files.some((file) => /\bdist\//.test(readFileSync(resolve(root, file), 'utf8')));
}
