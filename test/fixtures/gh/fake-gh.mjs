#!/usr/bin/env node
// fake-gh — the CLI-driven `gh` test double for the review family's I11 trap
// tests (E1 slice 3). Dependency-free, node: built-ins only, run via the
// CQ_GH_BIN seam (makeGhRunner({ bin }) points the runner at THIS file; the
// scenario/log files ride the spawned env).
//
// CONFIG (env):
//   CQ_GH_SCENARIO — path to a scenario JSON. Missing/unparseable → stderr +
//                    exit 2 (loud: a mispointed test must never pass).
//   CQ_GH_LOG      — optional file; ONE JSON line per invocation,
//                    `{ "args": [...] }`, appended before any routing, so
//                    tests can assert exactly what was called.
//
// SCENARIO JSON:
//   { "routes": [ { "when":   { "containsAll"?: string[], "containsAny"?: string[],
//                               "subcommand"?: string,   "hasFlag"?: string,
//                               "paginate"?: boolean },
//                   "stdout"?: string, "file"?: string, "code"?: number,
//                   "pages"?: unknown[][], "paginateableGraphql"?: boolean } ] }
//   First matching route wins; no match → `fake-gh: no route for <args>` +
//   exit 1. `file` resolves relative to the scenario file's directory.
//   `subcommand` matches args[1] for `api` calls, args[0] otherwise.
//   `paginate: true` matches only calls bearing `--paginate` (false: only
//   calls without it). `code` exits nonzero AFTER printing the payload.
//
// BUILT-IN TRAP BEHAVIORS (mimic real gh; always on, not scenario-dependent):
//   a. args containing `/replies` → exit 404 (the replies-endpoint-404 trap:
//      pull review comments have no /replies endpoint; per-comment reply
//      chains only exist via in_reply_to_id on the flat collection).
//   b. `api graphql` collision guard (I11): a `-f`/`-F` flag named `query`
//      appearing more than once, or a document declaring a `$query` variable,
//      exits 1 with gh's collision error family. Never name a GraphQL
//      variable `query` — the document rides the `-f query=` slot.
//   c. `pages: [[...], [...]]` payloads: WITH `--paginate` the fake returns
//      ONE merged JSON array of all pages' items (gh's documented merge);
//      WITHOUT it, only `pages[0]` — silent page-2 loss, exactly the trap.
//   d. `--paginate` on `api graphql` → exit 1 (`--paginate is not supported
//      with graphql`) unless the matched route sets `paginateableGraphql`:
//      true — GraphQL paginates via cursors, never double-pagination.
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const flat = args.join(' ');

/** Loud, stderr-first exit. */
const die = (code, message) => {
  process.stderr.write(`fake-gh: ${message}\n`);
  process.exit(code);
};

// Log EVERY invocation before any routing or trap, so tests see exactly what
// was called — including the calls that are about to be rejected.
const logPath = process.env.CQ_GH_LOG;
if (logPath) {
  appendFileSync(logPath, `${JSON.stringify({ args })}\n`);
}

// (a) The replies-endpoint-404 trap.
if (flat.includes('/replies')) {
  process.stderr.write('gh: Not Found (HTTP 404) — pull review comments have no /replies endpoint\n');
  process.exit(404);
}

// Scenario load — loud on missing/unparseable (exit 2).
const scenarioPath = process.env.CQ_GH_SCENARIO;
if (!scenarioPath) {
  die(2, 'CQ_GH_SCENARIO is not set');
}
let scenario;
try {
  scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
} catch (err) {
  die(2, `cannot read scenario ${scenarioPath}: ${err && err.message}`);
}

const hasFlag = (flag) => args.includes(flag);

/** The -f/-F flags as { name, value }, in order (values keep their `=`-joined text). */
const flags = [];
for (let i = 0; i < args.length - 1; i++) {
  if ((args[i] === '-f' || args[i] === '-F') && typeof args[i + 1] === 'string' && args[i + 1].includes('=')) {
    const eq = args[i + 1].indexOf('=');
    flags.push({ name: args[i + 1].slice(0, eq), value: args[i + 1].slice(eq + 1) });
  }
}

/** Route matcher: every present `when` key constrains; absent keys are wildcards. */
const matches = (when) => {
  if (when.containsAll !== undefined && !when.containsAll.every((needle) => flat.includes(needle))) {
    return false;
  }
  if (when.containsAny !== undefined && !when.containsAny.some((needle) => flat.includes(needle))) {
    return false;
  }
  if (when.subcommand !== undefined) {
    const sub = args[0] === 'api' ? args[1] : args[0];
    if (sub !== when.subcommand) {
      return false;
    }
  }
  if (when.hasFlag !== undefined && !hasFlag(when.hasFlag)) {
    return false;
  }
  if (when.paginate === true && !hasFlag('--paginate')) {
    return false;
  }
  if (when.paginate === false && hasFlag('--paginate')) {
    return false;
  }
  return true;
};

const route = (scenario.routes ?? []).find((candidate) => matches(candidate.when ?? {}));

const isGraphql = args[0] === 'api' && args[1] === 'graphql';

// (d) No double-pagination of GraphQL.
if (isGraphql && hasFlag('--paginate') && route?.paginateableGraphql !== true) {
  die(1, 'incorrect usage: --paginate is not supported with graphql');
}

// (b) The query-collision guard (I11): a duplicated `query` flag, or a
// document declaring a `$query` variable, is the collision.
if (isGraphql) {
  const queryFlags = flags.filter((flag) => flag.name === 'query');
  if (queryFlags.length > 1) {
    die(1, 'incorrect usage: the value of a -f flag named "query" collides with the GraphQL query parameter');
  }
  const doc = queryFlags[0]?.value ?? '';
  if (/(\$query\b|\bquery\s*:)/.test(doc)) {
    die(1, 'Variable "$query" collides with the GraphQL query parameter');
  }
}

if (!route) {
  die(1, `no route for ${flat}`);
}

// Emit the payload. `pages` encodes the pagination trap: with --paginate all
// pages merge into ONE array; without it only page 1 comes back.
const emit = (text) => {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  process.exit(route.code ?? 0);
};

if (route.pages !== undefined) {
  const merged = hasFlag('--paginate') ? route.pages.flat() : (route.pages[0] ?? []);
  emit(JSON.stringify(merged));
}
if (route.file !== undefined) {
  emit(readFileSync(resolve(dirname(scenarioPath), route.file), 'utf8'));
}
if (route.stdout !== undefined) {
  emit(route.stdout);
}
die(1, `route matched but carries no payload (stdout/file/pages)`);
