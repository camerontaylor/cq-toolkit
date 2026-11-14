/**
 * Shared fixtures for the S4 backfill suites.
 *
 * The group-P families under `apps/crq-python/fixtures/group-p` are the oracle's
 * own differential vectors, so every port reads them the same way here rather
 * than through a per-suite copy.
 */
import { readFileSync } from 'node:fs';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import {
  BACKFILL_BLAME_OPTIONS,
  BACKFILL_INVENTORY_VERSION,
  BACKFILL_SNAPSHOT_KEYS,
} from '../../../src/policy/crq/backfillInventory.js';
import { ledgerJsonDigest } from '../../../src/policy/crq/pythonJson.js';

const GROUP_P = new URL('../../../apps/crq-python/fixtures/group-p/', import.meta.url);

/** One vector case: the oracle's input, its recorded expectation and source. */
export interface VectorCase {
  readonly name: string;
  readonly source: string;
  readonly input: JsonObject;
  readonly expect: JsonObject;
}

function stringAt(object: JsonObject, key: string): string {
  const value = object.get(key);
  if (typeof value !== 'string') throw new Error(`missing string ${key}`);
  return value;
}

/** Every case of one group-P family (`<name>.json`). */
export function loadFamily(name: string): VectorCase[] {
  const document = parseJsonValue(readFileSync(new URL(`${name}.json`, GROUP_P), 'utf8'));
  if (!(document instanceof JsonObject))
    throw new Error(`${name}: family document is not an object`);
  const cases = document.get('cases');
  if (!Array.isArray(cases)) throw new Error(`${name}: missing cases`);
  return cases.map((entry) => {
    if (!(entry instanceof JsonObject)) throw new Error(`${name}: case is not an object`);
    const input = entry.get('input');
    const expected = entry.get('expect');
    if (!(input instanceof JsonObject) || !(expected instanceof JsonObject)) {
      throw new Error(`${name}: malformed case ${String(entry.get('name'))}`);
    }
    return {
      name: stringAt(entry, 'name'),
      source: stringAt(entry, 'source'),
      input,
      expect: expected,
    };
  });
}

/** One field of a vector object, refusing an absent key. */
export function valueAt(object: JsonObject, key: string): unknown {
  const value = object.get(key);
  if (value === undefined) throw new Error(`missing value ${key}`);
  return value;
}

/** One string field of a vector object, refusing an absent or non-string key. */
export function textAt(object: JsonObject, key: string): string {
  return stringAt(object, key);
}

/**
 * A retained capture manifest over these snapshot payloads, with the digest the
 * oracle would record: `replay` recomputes `id` from the manifest and each
 * snapshot reference from the payload it names.
 */
export function captureFixtureManifest(inputs: JsonObject): Record<string, unknown> {
  const snapshots: Record<string, unknown> = {};
  for (const key of BACKFILL_SNAPSHOT_KEYS) {
    const value = inputs.get(key);
    if (value === undefined) continue;
    snapshots[key] = { sha256: ledgerJsonDigest(value), location: `fixture/${key}` };
  }
  const manifest: Record<string, unknown> = {
    version: BACKFILL_INVENTORY_VERSION,
    repo: 'example/primary',
    target: '1'.repeat(40),
    tree: '2'.repeat(40),
    ledger_head: '3'.repeat(40),
    evaluated_at: '2026-11-09T00:00:00Z',
    snapshots,
    git_version: 'git version 2.43.0',
    blame_options: [...BACKFILL_BLAME_OPTIONS],
    construction_version: 'fixture-v1',
    scoring_version: 'fixture-v1',
    limits_version: 1,
    tiers_version: 1,
    git_bundle: { sha256: '4'.repeat(64), location: 'fixture/git.bundle' },
    raw_queue: { sha256: '5'.repeat(64), location: 'fixture/raw-queue' },
    queue_encoding: 'legacy-number-tag/v1',
  };
  manifest['id'] = ledgerJsonDigest(manifest);
  return manifest;
}
