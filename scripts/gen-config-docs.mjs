#!/usr/bin/env node
// gen-config-docs — generate docs/config.md from the env registry
// (src/config/env-registry.ts, built to dist/config/env-registry.js): one row
// per CQ_* name, then the foreign names the toolkit reads. The registry is the
// single source of truth (ADR-0009 "Key list"), so the table cannot drift from
// the code; the static gate's drift step runs `--check` and fails when the
// committed table is stale. Output is deterministic (sorted by name, no
// timestamps or absolute paths). Run `pnpm run build` first.
//
// USAGE:
//   node scripts/gen-config-docs.mjs           # write docs/config.md
//   node scripts/gen-config-docs.mjs --check   # verify only; exit 1 on drift
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// `--out=<file>` redirects the target (the drift-check test's seam).
const outArg = process.argv.find((arg) => arg.startsWith('--out='));
const OUT =
  outArg === undefined ? path.join(ROOT, 'docs', 'config.md') : path.resolve(outArg.slice(6));

const cell = (text) => String(text).replaceAll('|', '\\|').replace(/\s+/g, ' ').trim();
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const yesNo = (value) => (value ? 'yes' : 'no');

export function render({ CQ_ENV_ENTRIES, CQ_ENV_DENIED_PREFIXES, FOREIGN_ENV_ENTRIES }) {
  const lines = [
    '# Environment configuration',
    '',
    'Generated from the env registry by [`scripts/gen-config-docs.mjs`](../scripts/gen-config-docs.mjs).',
    'Do not edit by hand — run `pnpm run gen:config-docs`. The contract is',
    '[ADR-0009](adr/0009-config-contract-v2.md): names warn, values fail; blank means conservative.',
    '',
    '## CQ_* names',
    '',
    '`blank` is what an unset or empty value means: `conservative` is the strictest safe built-in,',
    '`neutral` is a value with no safety effect. `trust` keys never come from `cq.json`, plan data or',
    'op input. `secret` values are never printed.',
    '',
    '| Name | Kind | Trust | Blank | Status | Secret | Description |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const e of [...CQ_ENV_ENTRIES].sort(byName)) {
    lines.push(
      `| \`${e.name}\` | ${e.kind} | ${yesNo(e.trust)} | ${e.blank} | ${e.status} | ${yesNo(e.secret)} | ${cell(e.description)} |`,
    );
  }
  for (const d of [...CQ_ENV_DENIED_PREFIXES].sort((a, b) => (a.prefix < b.prefix ? -1 : 1))) {
    lines.push(
      `| \`${d.prefix}*\` | prefix | no | - | denied | yes | ${cell(d.description)} Setting it is an error. |`,
    );
  }
  lines.push(
    '',
    '## Foreign names',
    '',
    'Read by drivers, forge adapters and selfhost entries. They are never warned on. A secret name records',
    'presence only. `_URL` is not a secret suffix: a URL value is shown and recorded with userinfo, query and',
    'fragment stripped, or `[redacted-url]` when it does not parse (ADR-0009).',
    '',
    '| Name | Secret | Description |',
    '| --- | --- | --- |',
  );
  for (const f of [...FOREIGN_ENV_ENTRIES].sort(byName)) {
    lines.push(`| \`${f.name}\` | ${yesNo(f.secret)} | ${cell(f.description)} |`);
  }
  return `${lines.join('\n')}\n`;
}

async function main(argv) {
  const unknown = argv.filter((arg) => arg !== '--check' && !arg.startsWith('--out='));
  if (unknown.length > 0) {
    console.error(`gen-config-docs: unsupported argument(s): ${unknown.join(' ')}`);
    return 1;
  }
  let registry;
  try {
    registry = await import('../dist/config/env-registry.js');
  } catch (err) {
    console.error(
      `gen-config-docs: cannot import dist/config/env-registry.js — run \`pnpm run build\` first (${err instanceof Error ? err.message : String(err)})`,
    );
    return 1;
  }
  const content = render(registry);
  if (argv.includes('--check')) {
    if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== content) {
      console.error(
        'gen-config-docs: FAIL — docs/config.md is out of date; run `pnpm run gen:config-docs`',
      );
      return 1;
    }
    console.error('gen-config-docs: ok — docs/config.md up to date');
    return 0;
  }
  writeFileSync(OUT, content);
  console.error('gen-config-docs: wrote docs/config.md');
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
