#!/usr/bin/env node
// RS-13 backend certification runner (B14 evidence, NOT shared runner code).
//
// Executes the live boundary canaries from src/sandbox/probe.ts against this
// host's candidate backends and prints the certification verdict — pass and
// blocker alike, verbatim.  This is the credential-free, zero-spend proof
// path for "no synthetic certifiedBackends pass": whatever this script prints
// is what the canaries actually did, and an absent backend names its exact
// environmental blocker instead of quietly passing.
//
// Usage:
//   pnpm run build && node scripts/sandbox-certify.mjs \
//     [--network model-only|allow] [--model-proxy] [--json]
//
// --model-proxy composes model-only with a local proxy stand-in: only one
// loopback port passes and every other egress target must be refused.  A
// backend that cannot compose a proxy is uncertifiable under that posture
// and fails closed. Even a passing stand-in cannot certify a production
// endpoint identity/allowlist; proxy-composed certification is withheld.
//
// Exit 0 when at least one backend certified; exit 1 when none did (required
// mode stays fail-closed); exit 2 on usage/build errors.
//
// The script imports the BUILT module from dist/ — it is an evidence runner,
// not a build product, and holds no toolkit logic of its own.
import { stderr, stdout, exit } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const USAGE = 'usage: sandbox-certify.mjs [--network model-only|allow] [--model-proxy] [--json]';

// Strict parse BEFORE any probe work (Codex P2): an unknown, positional, or
// repeated option is a usage error, never a silent fall-back to the default
// posture — automation must get evidence for exactly the posture it asked for.
let args;
try {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      network: { type: 'string' },
      'model-proxy': { type: 'boolean' },
      json: { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
    tokens: true,
  });
  const seen = new Set();
  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) throw new Error(`option '--${token.name}' given more than once`);
    seen.add(token.name);
  }
  args = parsed.values;
} catch (error) {
  stderr.write(`sandbox-certify: ${error.message}\n${USAGE}\n`);
  exit(2);
}

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const probeUrl = pathToFileURL(join(repoRoot, 'dist', 'sandbox', 'probe.js'));

let probe;
try {
  probe = await import(probeUrl.href);
} catch (error) {
  stderr.write(
    `sandbox-certify: cannot load dist/sandbox/probe.js — run \`pnpm run build\` first\n  ${error.message}\n`,
  );
  exit(2);
}

const network = args.network;
if (network !== undefined && network !== 'model-only' && network !== 'allow') {
  stderr.write(`sandbox-certify: --network must be model-only or allow, got '${network}'\n`);
  exit(2);
}
const modelProxy = args['model-proxy'] === true;
if (modelProxy && network === 'allow') {
  stderr.write('sandbox-certify: --model-proxy contradicts --network allow\n');
  exit(2);
}

let certification;
try {
  certification = await probe.certifyBackends({
    ...(network === undefined ? {} : { network }),
    ...(modelProxy ? { modelProxy: true } : {}),
  });
} catch (error) {
  stderr.write(`sandbox-certify: probe failed: ${error?.stack ?? error}\n`);
  exit(2);
}

if (args.json === true) {
  stdout.write(`${JSON.stringify(certification, null, 2)}\n`);
} else {
  stdout.write(
    `RS-13 boundary probe — platform ${certification.platform}, posture ${certification.network}, ` +
      `egress demonstrated: ${certification.networkDemonstrated}, probed ${certification.probedAt}\n` +
      `(a pass here is a live canary observation, not an RS-13 certification claim)\n`,
  );
  for (const record of certification.records) {
    stdout.write(
      `\n[${record.backend}] certified=${record.certified} runnable=${record.runnable}\n`,
    );
    if (record.blocker !== undefined) stdout.write(`  blocker: ${record.blocker}\n`);
    for (const canary of record.canaries) {
      stdout.write(`  ${canary.verdict.padEnd(13)} ${canary.id}: ${canary.detail}\n`);
    }
  }
  stdout.write(
    `\ncertified backends: ${certification.certified.length === 0 ? '(none — required mode stays fail-closed)' : certification.certified.join(', ')}\n`,
  );
}

// exitCode (not exit()) lets piped stdout drain before the process ends.
process.exitCode = certification.certified.length === 0 ? 1 : 0;
