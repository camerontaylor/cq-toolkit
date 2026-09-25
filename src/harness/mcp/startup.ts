// Startup checks for the `cq-harness-mcp` server (W1.4, ADR-0002 Annex
// A.3) — split from ./bin.ts so they are importable without starting a
// server. See bin.ts for the check list and exit statuses.
import { realpathSync, statSync } from 'node:fs';
import { buildChildEnv } from '../../driver/subprocess/process.js';
import { buildSandboxLauncherEnv, harnessRunGate } from '../../sandbox/index.js';
import { createHarnessSurface, HarnessManifestSchema } from '../surface.js';
import type { HarnessManifest, HarnessSurface } from '../surface.js';

/** The startup-refusal exit status (sysexits EX_CONFIG). */
export const EXIT_CONFIG = 78;
/** The protocol-break exit status (sysexits EX_DATAERR). */
export const EXIT_PROTOCOL = 65;

/** The startup checks' result: a bound surface, or the one-line refusal reason. */
export type StartupResult =
  | { ok: true; manifest: HarnessManifest; surface: HarnessSurface }
  | { ok: false; reason: string };

/**
 * Checks 1–3 (pure of process state): parse, realpath identity, surface
 * build. The bin then applies chdir + the env scrub (checks 4–5).
 */
export function checkStartup(argv: readonly string[]): StartupResult {
  if (argv.length !== 1) {
    return {
      ok: false,
      reason: `expected exactly one argument (the manifest JSON), got ${argv.length}`,
    };
  }
  let manifest: HarnessManifest;
  try {
    manifest = HarnessManifestSchema.parse(JSON.parse(argv[0] as string));
  } catch (err) {
    return { ok: false, reason: `invalid manifest: ${oneLine(err)}` };
  }
  try {
    const real = realpathSync(manifest.workspace);
    if (real !== manifest.workspace) {
      return {
        ok: false,
        reason: `workspace realpath mismatch: manifest '${manifest.workspace}', realpath '${real}'`,
      };
    }
    if (!statSync(real).isDirectory()) {
      return { ok: false, reason: `workspace '${real}' is not a directory` };
    }
  } catch (err) {
    return { ok: false, reason: `workspace unavailable: ${oneLine(err)}` };
  }
  try {
    return { ok: true, manifest, surface: createHarnessSurface(manifest) };
  } catch (err) {
    return { ok: false, reason: `surface mismatch: ${oneLine(err)}` };
  }
}

/** Replace process.env in place with the default child-env allowlist plus resolved names. */
export function scrubEnvironment(envNames: readonly string[]): void {
  const gate = harnessRunGate();
  const explicitNames = [...envNames, ...gate.envPassthrough];
  // Validate the final run-child names through the sandbox scrub. This rejects
  // CQ_* policy knobs before process.env is replaced; otherwise a manifest
  // could smuggle one through and only fail later when the run tool executes.
  buildSandboxLauncherEnv(process.env, { envPassthrough: explicitNames });

  // buildChildEnv also reads CQ_RUN_ENV_PASSTHROUGH implicitly. Remove that
  // knob first so the MCP scrub uses ONLY the names resolved and validated
  // above; otherwise a caller could add an unvalidated name after the gate
  // decision was made.
  const parent = { ...process.env };
  delete parent.CQ_RUN_ENV_PASSTHROUGH;
  const kept = buildChildEnv(parent, undefined, explicitNames);
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, kept);
}

/** First line of an error message — stderr gets exactly one line. */
export function oneLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split('\n').join(' ').slice(0, 2_000);
}
