// Gates lane C1 — test evidence: every committed fixture (REAL captured
// tool output, see test/fixtures/check-outputs) round-trips through its
// adapter to an exact FailureSet; every malformed fixture is indeterminate
// and never clean (I5); and the `gates.checkRunner` op is proven over a FAKE
// injected runner — ok, indeterminate, and runner-throws paths, with zero
// subprocesses spawned.
//
// Split provenance: test/ops/gates/adapters.test.ts was split by subject into
// adapters.checkRunner.test.ts, adapters.eslintJson.test.ts,
// adapters.oxfmtCheck.test.ts, adapters.oxlintJson.test.ts,
// adapters.ruffKnipJson.test.ts, adapters.testNarrow.test.ts,
// adapters.tscLines.test.ts and adapters.vitestJson.test.ts. This module holds
// the fixture and parse helpers those files share.
import { readFileSync } from 'node:fs';
import {
  adapterByName,
  parseCheckOutput,
  type CheckParseResult,
  type RawCheckOutput,
} from '../../../src/ops/gates/index.js';

/** Raw captured bytes of one committed fixture. */
export function fixture(name: string): string {
  return readFileSync(new URL(`../../fixtures/check-outputs/${name}`, import.meta.url), 'utf8');
}

/** Parse through the real guarded entry point (parseCheckOutput, not the raw adapter). */
export function parseWith(
  adapter: 'vitest-json' | 'eslint-json' | 'tsc-lines',
  raw: RawCheckOutput,
): CheckParseResult {
  return parseCheckOutput(adapterByName(adapter), raw);
}
