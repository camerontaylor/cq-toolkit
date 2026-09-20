#!/usr/bin/env node
// gen-op-docs — ws-i scope item 5 / plan §6 "README doctrine sections
// present": generate the per-op reference from the op REGISTRY
// (src/registry/index.ts), one docs/ops/<name>.md per registry entry,
// carrying the op name, its input schema, and the result taxonomy. The
// registry is the single source of truth, so the docs cannot silently drift
// from the code; the ci.yml drift step regenerates them and fails on a dirty
// docs/ops (the step is instantiated from policy/templates/required-check.md).
//
// DETERMINISM (the drift check is meaningful only if the output is stable):
//   - entries are emitted one file per op, named <op>.md;
//   - JSON Schema object keys are sorted recursively (canonical rendering);
//   - no timestamps, no run ids, no absolute paths — only repo-relative
//     references appear in the docs;
//   - a stale docs/ops/*.md (an op removed from the registry) is deleted, so
//     a removal counts as drift too.
//
// SCHEMA SOURCE: the entry's zod `inputSchema`, rendered with zod's built-in
// `z.toJSONSchema` (draft 2020-12) — no new dependency, and no hand-rolled
// zod introspection that could disagree with zod itself. `unrepresentable:
// 'any'` maps a transform/pipe the JSON Schema vocabulary cannot express to
// `{}` instead of throwing; the generator refuses to guess beyond that.
//
// TAXONOMY SOURCE: the FROZEN `OpResult` union in src/kernel/types.ts,
// parsed here and asserted against the description table below — a changed
// taxonomy fails the generator loudly instead of emitting stale prose (the
// I5 posture: a missing reading is non-passing evidence, never a pass).
//
// BUILD DEPENDENCY: the registry is imported from the BUILT package
// (dist/registry/index.js), the same built-engine dependency the ratchet
// runners carry. Run `npm run build` first; the ci.yml static job builds (and
// its ratchet step builds) before the drift step runs.
//
// USAGE:
//   node scripts/gen-op-docs.mjs           # write docs/ops/
//   node scripts/gen-op-docs.mjs --check   # verify only; exit 1 on drift
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DOCS_DIR = path.join(ROOT, 'docs', 'ops');
const TYPES_PATH = path.join(ROOT, 'src', 'kernel', 'types.ts');
const GENERATOR_REF = 'scripts/gen-op-docs.mjs';

// One line per frozen `OpResult` status, in the union's order. Kept beside
// the parser that proves the union still holds exactly these statuses.
const STATUS_SUMMARIES = new Map([
  ['ok', 'the op succeeded; `value` carries the result.'],
  ['failed', 'the op ran and definitively failed; `error` says why.'],
  [
    'needs-human',
    'the op stopped for a decision or input only a human can supply; `reason` records it (CLI exit 3).',
  ],
  ['budget-exhausted', 'a budget bound was hit, so the op did not run or halted (CLI exit 3).'],
  [
    'indeterminate',
    'no verdict could be produced (crash, timeout, lost worker); `detail` carries what is known — callers must assume neither success nor failure.',
  ],
]);

/** Message of an unknown throwable, for one-line diagnostics. */
function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Extract the frozen `OpResult` status literals from the kernel types source
 * and assert they match the description table exactly (no missing, no extra,
 * no duplicate). The union is read up to its TERMINATING `;` — the first
 * semicolon that ends a line — so the `status: '…'` keys inside each member
 * (whose own semicolons sit mid-line) are all captured, and a comment or
 * formatting edit near the union cannot make the match drift onto a
 * neighbouring type. The anchor is the type NAME, not a literal generic
 * spelling, so a changed generic arity cannot silently break the assertion.
 */
function readOpResultStatuses(typesSource) {
  const union = typesSource.match(/export type OpResult\b[\s\S]*?;[ \t]*(?:\n|$)/);
  if (union === null) {
    throw new Error(`cannot locate the OpResult union in ${TYPES_PATH}`);
  }
  const found = [...union[0].matchAll(/status:\s*'([^']+)'/g)].map((match) => match[1]);
  const unique = [...new Set(found)];
  if (unique.length === 0) {
    throw new Error(`the OpResult union in ${TYPES_PATH} declares no status literals`);
  }
  const described = [...STATUS_SUMMARIES.keys()];
  const missing = unique.filter((status) => !STATUS_SUMMARIES.has(status));
  const extra = described.filter((status) => !unique.includes(status));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      'the frozen OpResult taxonomy no longer matches the generator descriptions ' +
        `(undescribed: [${missing.join(', ')}]; stale: [${extra.join(', ')}]) — update ` +
        `STATUS_SUMMARIES in ${GENERATOR_REF}`,
    );
  }
  return unique;
}

/** Recursively sort object keys, so the JSON rendering is canonical. */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key]);
    return sorted;
  }
  return value;
}

/** Render one op entry as its markdown reference page. */
function renderDoc(entry, statuses) {
  const name = entry.name;
  const family = name.includes('.') ? name.slice(0, name.indexOf('.')) : name;
  const schema = z.toJSONSchema(entry.inputSchema, { io: 'input', unrepresentable: 'any' });
  const lines = [
    `# \`${name}\``,
    '',
    `Generated from the op registry by [\`${GENERATOR_REF}\`](../../${GENERATOR_REF}).`,
    'Do not edit by hand — run `npm run gen:op-docs`.',
    '',
    `- **Family:** \`${family}\``,
    `- **CLI:** \`cq ${name} [--<schema-key>=<value> ...] [--json]\`; run \`cq ${name} --help\` for the input schema (a secondary interface over the SDK — see [\`src/cli/README.md\`](../../src/cli/README.md))`,
    '',
    '## Input schema',
    '',
    "The registry entry's zod `inputSchema`, rendered as canonical JSON Schema",
    '(draft 2020-12; object keys sorted for deterministic output):',
    '',
    '```json',
    JSON.stringify(canonicalize(schema), null, 2),
    '```',
    '',
    '## Result taxonomy',
    '',
    'Every op returns exactly one of the five frozen `OpResult` statuses',
    '([`src/kernel/types.ts`](../../src/kernel/types.ts)); the CLI derives exit',
    'codes from them per invariant I1 ([`policy/DOCTRINE.md`](../../policy/DOCTRINE.md)).',
    '',
  ];
  for (const status of statuses) {
    lines.push(`- **\`${status}\`** — ${STATUS_SUMMARIES.get(status)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Import the built registry, with an actionable error when dist/ is absent. */
async function loadRegistry() {
  try {
    return await import('../dist/registry/index.js');
  } catch (err) {
    throw new Error(
      `cannot import the built registry (dist/registry/index.js) — run \`npm run build\` first (${messageOf(err)})`,
    );
  }
}

/** Compare generated docs against disk (check mode); returns drift messages. */
function collectDrift(docs, existing) {
  const drift = [];
  for (const [file, content] of docs) {
    const full = path.join(DOCS_DIR, file);
    if (!existsSync(full)) drift.push(`${file}: missing`);
    else if (readFileSync(full, 'utf8') !== content) drift.push(`${file}: out of date`);
  }
  for (const file of existing) {
    if (!docs.has(file)) drift.push(`${file}: stale (no registry entry)`);
  }
  return drift;
}

async function main(argv) {
  const unknown = argv.filter((arg) => arg !== '--check');
  if (unknown.length > 0) {
    console.error(`gen-op-docs: unsupported argument(s): ${unknown.join(' ')}`);
    console.error('usage: node scripts/gen-op-docs.mjs [--check]');
    return 1;
  }
  const check = argv.includes('--check');

  const { listWithDiagnostics } = await loadRegistry();
  const { entries, skippedFamilies } = await listWithDiagnostics();
  if (entries.length === 0) {
    console.error(
      'gen-op-docs: the registry returned no ops — refusing to write an empty docs/ops ' +
        '(a broken build must not silently erase the reference)',
    );
    return 1;
  }
  if (skippedFamilies.length > 0) {
    console.error(
      `gen-op-docs: FAIL — families contributed no registry entries: ${skippedFamilies.join(', ')}; ` +
        'refusing to generate docs from an INCOMPLETE registry (a skipped family would ' +
        'silently drop its committed docs)',
    );
    return 1;
  }

  const statuses = readOpResultStatuses(readFileSync(TYPES_PATH, 'utf8'));
  const docs = new Map();
  // Code-unit ordering, not localeCompare: the rendered order (and so the
  // drift check) must not depend on the host ICU locale.
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of [...entries].sort(byName)) {
    docs.set(`${entry.name}.md`, renderDoc(entry, statuses));
  }
  const existing = existsSync(DOCS_DIR)
    ? readdirSync(DOCS_DIR).filter((file) => file.endsWith('.md'))
    : [];

  if (check) {
    const drift = collectDrift(docs, existing);
    if (drift.length > 0) {
      for (const item of drift) console.error(`gen-op-docs: drift — ${item}`);
      console.error(
        `gen-op-docs: FAIL — ${drift.length} generated doc(s) out of date; run \`npm run gen:op-docs\``,
      );
      return 1;
    }
    console.error(`gen-op-docs: ok — ${docs.size} op doc(s) up to date`);
    return 0;
  }

  mkdirSync(DOCS_DIR, { recursive: true });
  let changed = 0;
  for (const [file, content] of docs) {
    const full = path.join(DOCS_DIR, file);
    if (!existsSync(full) || readFileSync(full, 'utf8') !== content) {
      writeFileSync(full, content);
      changed += 1;
    }
  }
  let removed = 0;
  for (const file of existing) {
    if (!docs.has(file)) {
      rmSync(path.join(DOCS_DIR, file));
      removed += 1;
    }
  }
  console.error(
    `gen-op-docs: wrote ${docs.size} op doc(s) to docs/ops/ (${changed} changed, ${removed} stale removed)`,
  );
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
