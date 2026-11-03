// W1.9 — the D11 policy check's execution provenance (ADR-0004 D-A/D-B/D-G,
// D-H.2), pinned over BOTH the generated workflows (.github/workflows/) and
// their source of truth (policy/templates/), as ratchet-provenance does for
// the W1.7 ratchet family.
//
// Pinned here:
//   1. Lockstep: each generated file is the provenance header plus its
//      template, byte for byte.
//   2. cq-signal is a wake-up only: `permissions: {}` at the top and on its
//      one job, no secrets, no checkout, no action, a no-op body.
//   3. cq-policy runs from the default branch (`workflow_run` on cq-signal;
//      dispatch honoured only on the default ref), refuses fork and foreign
//      runs, signs in environment `cq-verdict` (W1.10 Decision 6) with a
//      verdict-App token when its variable is set and GITHUB_TOKEN otherwise,
//      checks out only the trust ref with no persisted credential, never runs
//      head code, reads the posture from `vars.*`, and posts `cq/policy`.
//   4. The resolver, verdict guard and posting programs behave as documented
//      when actually run (bash + jq, with `gh` stubbed).
//
// The suite was split into per-subject files
// (policy-provenance.<subject>.test.ts) so review tooling can see below the
// 256 KiB single-file cap; this module carries the shared path and YAML-parse
// helpers all of them import.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const FILES = ['cq-signal.yml', 'cq-policy.yml'] as const;

export const template = (name: string): string =>
  readFileSync(join(ROOT, 'policy/templates', name), 'utf8');
export const generated = (name: string): string =>
  readFileSync(join(ROOT, '.github/workflows', name), 'utf8');

/** Both copies of one workflow, labelled. */
export const bothCopies = (name: string): Array<[string, string]> => [
  [`template ${name}`, template(name)],
  [`generated ${name}`, generated(name)],
];

/** Non-comment lines only: rationale comments may name what the code must not do. */
export function code(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/** The job blocks under `jobs:`, keyed by job id (two-space `<id>:` lines). */
export function jobBlocks(text: string): Map<string, string> {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === 'jobs:');
  if (start === -1) throw new Error('no jobs: block');
  const jobs = new Map<string, string>();
  let current: string | null = null;
  let body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m !== null) {
      if (current !== null) jobs.set(current, body.join('\n'));
      current = m[1] ?? null;
      body = [];
      continue;
    }
    body.push(line);
  }
  if (current !== null) jobs.set(current, body.join('\n'));
  return jobs;
}

/** The `on:` block (top-level, up to the next top-level key). */
export function onBlock(text: string): string {
  const m = /^on:\n((?: .*\n|\n)*)/m.exec(text);
  if (m === null || m[1] === undefined) throw new Error('no on: block');
  return m[1];
}

/** The step items (six-space `- ` lines) of one job block. */
export function steps(job: string): string[] {
  const out: string[] = [];
  let current: string[] | null = null;
  for (const line of job.split('\n')) {
    if (/^ {6}- /.test(line)) {
      if (current !== null) out.push(current.join('\n'));
      current = [line];
    } else if (current !== null) {
      if (line.trim() !== '' && !line.startsWith('        ')) {
        out.push(current.join('\n'));
        current = null;
      } else {
        current.push(line);
      }
    }
  }
  if (current !== null) out.push(current.join('\n'));
  return out;
}

/** The dedented `run: |` script of the step whose `name:` is `stepName`. */
export function runScript(job: string, stepName: string): string {
  const step = steps(job).find((s) => s.startsWith(`      - name: ${stepName}\n`));
  if (step === undefined) throw new Error(`no step named ${stepName}`);
  const lines = step.split('\n');
  const at = lines.findIndex((line) => line === '        run: |');
  if (at === -1) throw new Error(`step ${stepName} has no run: | block`);
  const script: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== '' && !line.startsWith('          ')) break;
    script.push(line.startsWith('          ') ? line.slice(10) : '');
  }
  return script.join('\n');
}
