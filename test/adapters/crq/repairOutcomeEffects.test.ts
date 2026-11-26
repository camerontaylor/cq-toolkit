/**
 * Replay of the Python oracle for the file-backed repair outcome effects.
 *
 * Every case in `crq-repair-harvest-effects/cases.json` was produced by the
 * production `repair_tick.mark_finding_outcome` / `record_unpublished_siblings`
 * over a real inbox and outbox. Each case is rebuilt here from its recorded
 * row and seed chain, run through `fileRepairOutcomeEffects`, and compared on
 * the exception class that escaped, the events spooled and the row bytes.
 */
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { fileRepairOutcomeEffects } from '../../../src/adapters/crq/repairOutcomeEffects.js';
import {
  fileArtifactStore,
  fileFindingInbox,
  fileFindingPublication,
} from '../../../src/adapters/crq/findingStore.js';
import {
  ledgerCanonicalBytes,
  ledgerLoads,
  ledgerValueEqual,
} from '../../../src/policy/crq/ledger.js';
import { JsonObject, type JsonValue } from '../../../src/policy/crq/jsonValue.js';
import { PyError } from '../../../src/queue-runner/pyErrors.js';

const FIXTURE = new URL(
  '../../../apps/crq-python/fixtures/crq-repair-harvest-effects/cases.json',
  import.meta.url,
);
const FIXED_SIBLING_REASON =
  'repair run failed before publication; the verified fix was not published';

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

function object(value: JsonValue | undefined, what: string): JsonObject {
  if (!(value instanceof JsonObject)) throw new Error(`${what} is not an object`);
  return value;
}
function array(value: JsonValue | undefined, what: string): JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${what} is not an array`);
  return value;
}
function text(value: JsonValue | undefined, what: string): string {
  if (typeof value !== 'string') throw new Error(`${what} is not a string`);
  return value;
}

const document = object(ledgerLoads(readFileSync(FIXTURE, 'utf8')), 'fixture');
const plain = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  outcome_cases: {
    name: string;
    op: string;
    job: Record<string, unknown>;
    result: Record<string, unknown>;
    no_rollout?: boolean;
  }[];
};
const cases = array(document.get('outcome_cases'), 'outcome_cases').map((value) =>
  object(value, 'case'),
);
const AT = text(document.get('at'), 'at');
const FINDING = text(document.get('finding_id'), 'finding_id');
const SEEDS = array(document.get('seed_events'), 'seed_events');
const MAX = (plain as unknown as { max_finding_retries: number }).max_finding_retries;

describe('repair outcome effects against the Python oracle', () => {
  test('the fixture is not vacuous', () => {
    expect(cases.length).toBeGreaterThan(25);
    const errors = new Set(cases.map((c) => object(c.get('expected'), 'e').get('error')));
    expect(errors).toEqual(new Set([null, 'KeyError', 'TypeError', 'ValueError']));
  });

  test.each(cases.map((value, index) => [text(value.get('name'), 'name'), index] as const))(
    '%s',
    async (_name, index) => {
      const chosen = cases[index] as JsonObject;
      const raw = plain.outcome_cases[index]!;
      const expected = object(chosen.get('expected'), 'expected');
      const root = await mkdtemp(join(tmpdir(), 'crq-outcome-effects-'));
      temporary.push(root);
      await mkdir(root, { recursive: true });
      if (!raw.no_rollout)
        await writeFile(
          join(root, 'backfill-rollout.json'),
          JSON.stringify({ durable_artifact_root: join(root, 'artifacts') }),
        );
      const files = fileFindingInbox(join(root, 'backfill', 'findings'));
      const publication = fileFindingPublication({
        root: join(root, 'backfill', 'publication'),
        artifacts: fileArtifactStore(join(root, 'artifacts')),
      });
      await files.writeTriage(
        FINDING,
        ledgerCanonicalBytes(object(expected.get('row_before'), 'row_before')),
      );
      for (const seed of SEEDS) await publication.spool(seed);

      const effects = fileRepairOutcomeEffects({
        stateRoot: root,
        iso: () => AT,
        maxFindingRetries: MAX,
      });
      let error: string | null = null;
      try {
        if (raw.op === 'mark') await effects.markFindingOutcome(raw.job, raw.result);
        else
          await effects.recordUnpublishedFixedSibling(
            raw.job['canonical_finding_id'],
            raw.job['job'] as string,
            FIXED_SIBLING_REASON,
            raw.job['repair_base'] ?? null,
          );
      } catch (caught) {
        if (!(caught instanceof PyError)) throw caught;
        error = caught.kind;
      }
      expect(error).toBe(expected.get('error'));

      const seedIds = new Set(SEEDS.map((s) => text(object(s, 'seed').get('id'), 'id')));
      const added = (await publication.retained()).filter(
        (value) => !seedIds.has(text(object(value, 'event').get('id'), 'id')),
      );
      const wanted = array(expected.get('events'), 'events');
      expect(added.length).toBe(wanted.length);
      added.forEach((value, position) => {
        expect(Buffer.from(ledgerCanonicalBytes(value))).toEqual(
          Buffer.from(ledgerCanonicalBytes(wanted[position] as JsonValue)),
        );
      });
      const row = await files.readTriage(FINDING);
      expect(row).not.toBeNull();
      expect(
        ledgerValueEqual(ledgerLoads(row as Uint8Array), expected.get('row_after') as JsonValue),
      ).toBe(true);
    },
  );
});
