// render-templates — the template render-diff gate (W1.10 Decision 15).
//
//   node scripts/render-templates.mjs --check
//   node scripts/render-templates.mjs --write
//
// --check exits 1 listing every instance whose rendered text differs from
// the committed workflow, and every table/coverage error in
// policy/templates/instances.json. --write re-instantiates: it writes each
// instance's rendered text to .github/workflows/ — but writes NOTHING while
// any table or render error stands other than a missing workflow listed
// only in "instances" with a valid render (the new instance --write is there
// to create; a missing "nonTemplated" workflow still blocks). The mechanics
// live in scripts/lib/render-templates.mjs.

import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  WORKFLOWS_DIR,
  collectRenders,
  firstDifference,
  writeBlockers,
} from './lib/render-templates.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
if (process.argv.length !== 3 || (mode !== '--check' && mode !== '--write')) {
  console.error('usage: node scripts/render-templates.mjs --check|--write');
  process.exit(2);
}

const { errors, results } = collectRenders(ROOT);
const problems = [...errors];
if (mode === '--write') {
  const blockers = writeBlockers(errors, results);
  if (blockers.length > 0) {
    for (const problem of blockers) console.error(`render-templates: ${problem}`);
    console.error('render-templates: --write refused (nothing written): fix the table first');
    process.exit(1);
  }
  // Only creatable missing instances remain, and the loop below creates them.
  problems.length = 0;
}
for (const { workflow, template, expected, actual } of results) {
  if (expected === null) continue;
  if (mode === '--write') {
    if (expected !== actual) {
      writeFileSync(join(ROOT, WORKFLOWS_DIR, workflow), expected);
      console.log(`wrote ${WORKFLOWS_DIR}/${workflow} (from ${template})`);
    }
    continue;
  }
  if (actual === null) {
    problems.push(`${WORKFLOWS_DIR}/${workflow}: missing (render of ${template})`);
  } else if (expected !== actual) {
    problems.push(
      `${WORKFLOWS_DIR}/${workflow}: differs from the render of ${template} — ${firstDifference(expected, actual)}`,
    );
  }
}
for (const problem of problems) console.error(`render-templates: ${problem}`);
if (problems.length > 0) {
  if (mode === '--check') {
    console.error('render-templates: edit the template (or instances.json), then run --write');
  }
  process.exit(1);
}
console.log(
  `render-templates: ${results.length} instances ${mode === '--check' ? 'match' : 'rendered'}`,
);
