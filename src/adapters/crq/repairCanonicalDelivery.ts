/**
 * `bounded.require_canonical_delivery(root, job, written_back=True, retained=...)`
 * (apps/crq-python/crq_repair/bounded.py:72), the ownership check `repair_tick.harvest`
 * runs before it trusts a repair job's retained result. Inactive: nothing imports this
 * from a runtime entry point.
 *
 * In Python's order, for a job that has a `canonical_finding_id`:
 * 1. the id must be 64 lowercase hex (else `ValueError: invalid canonical finding identity`);
 * 2. `<root>/state/backfill/findings/triage/<id>.json` is read as text and parsed; any
 *    `OSError` or `ValueError` is `ValueError: canonical delivery state unavailable`, the
 *    one text the harvest keeps retryable;
 * 3. the row must be a dict whose status is `delivered` or (the `written_back` form) one of
 *    `fixed`, `needs-retriage`, `needs-human`, `dismissed`, with a dict `receipt` whose
 *    `repair_task` equals the job's `job`;
 * 4. a non-`delivered` row only counts when its `previous_event_id` names this job's own
 *    retained `repair-outcome` event (`finding-event`, source key `repair-outcome:...`,
 *    actor `crq-repair`, same finding and action, `evidence.repair_task` equal). Without a
 *    `retained` reader the row fails closed.
 *
 * Parity points a reader should not "fix":
 * - `==` is Python's: a receipt with no `repair_task` and a job with no `job` are both
 *   `None`, so they match; the event lookup compares `id` with `previous_event_id` the same
 *   way, so an id-less event matches an id-less row (and the field checks that follow
 *   decide).
 * - `str(event.get('source_key', ''))` renders a non-string key with its repr
 *   (`None`, `1`), never an error.
 * - A failure of `retained()` is `canonical delivery state unavailable` only for Python's
 *   `(OSError, ValueError, KeyError, TypeError)`; anything else propagates.
 * - `root` is `c.STATE.parent`: the triage row sits at `<root>/state/backfill/...`, so a state
 *   directory not named `state` reads a different tree than the findings store, as Python does.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  LedgerIntegrityError,
  LedgerJsonDecodeError,
  LedgerTimestampError,
  LedgerUnicodeDecodeError,
} from '../../policy/crq/ledger.js';
import {
  parseJsonValue,
  pythonNonFinite,
  toPlainJson,
  type JsonValue,
} from '../../policy/crq/jsonValue.js';
import { pyEq, pyStr } from '../../policy/crq/pyCompat.js';
import { isPyError, PyError } from '../../queue-runner/pyErrors.js';
import type { RepairHarvestEffects } from '../../queue-runner/repairHarvest.js';
import { SpoolConfigError } from './publisherSpool.js';

/** `WRITTEN_BACK_STATUSES`. */
const WRITTEN_BACK_STATUSES = ['fixed', 'needs-retriage', 'needs-human', 'dismissed'];
const FINDING_ID = /^[0-9a-f]{64}$/;
const UNAVAILABLE = 'canonical delivery state unavailable';
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

type Dict = Record<string, unknown>;
const isDict = (value: unknown): value is Dict =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const get = (value: Dict, key: string): unknown =>
  Object.hasOwn(value, key) ? value[key] : undefined;
/** `a == b` over decoded JSON, with integers beyond the safe range compared exactly. */
const equal = (a: unknown, b: unknown): boolean =>
  typeof a === 'bigint' && typeof b === 'bigint' ? a === b : pyEq(a, b);

export interface CanonicalDeliveryOptions {
  /** `c.STATE.parent`. */
  readonly root: string;
  /** `finding_inbox(c).publication.retained()`; absent means a non-delivered row fails closed. */
  readonly retained?: () => Promise<readonly JsonValue[]>;
}

/** Python's `(OSError, ValueError, KeyError, TypeError)` over what the stores throw. */
function isRetainedFailure(error: unknown): boolean {
  if (isPyError(error, 'OSError', 'ValueError', 'KeyError', 'TypeError')) return true;
  if (
    error instanceof LedgerIntegrityError ||
    error instanceof LedgerJsonDecodeError ||
    error instanceof LedgerUnicodeDecodeError ||
    error instanceof LedgerTimestampError ||
    error instanceof SpoolConfigError
  )
    return true;
  return typeof (error as NodeJS.ErrnoException | null)?.code === 'string';
}

const refuse = (message: string): PyError => new PyError('ValueError', message);

export function canonicalDelivery(
  options: CanonicalDeliveryOptions,
): Pick<RepairHarvestEffects, 'requireCanonicalDelivery'> {
  return {
    async requireCanonicalDelivery(job) {
      if (!Object.hasOwn(job, 'canonical_finding_id')) return;
      const fid = job['canonical_finding_id'];
      if (typeof fid !== 'string' || !FINDING_ID.test(fid)) {
        throw refuse('invalid canonical finding identity');
      }
      let row: unknown;
      try {
        const text = decoder.decode(
          await readFile(join(options.root, 'state/backfill/findings/triage', `${fid}.json`)),
        );
        row = toPlainJson(parseJsonValue(text, { parseConstant: pythonNonFinite }), {
          bigints: true,
        });
      } catch {
        // `except (OSError, ValueError)`: a read, decode or parse failure alike.
        throw refuse(UNAVAILABLE);
      }
      const receipt = isDict(row) ? get(row, 'receipt') : undefined;
      const status = isDict(row) ? get(row, 'status') : undefined;
      if (
        !isDict(row) ||
        typeof status !== 'string' ||
        !['delivered', ...WRITTEN_BACK_STATUSES].includes(status) ||
        !isDict(receipt) ||
        !equal(get(receipt, 'repair_task'), get(job, 'job'))
      ) {
        throw refuse('canonical finding is not delivered to this repair task');
      }
      if (status === 'delivered') return;
      let events: readonly JsonValue[] | undefined;
      try {
        events = options.retained === undefined ? undefined : await options.retained();
      } catch (error) {
        if (isRetainedFailure(error)) throw refuse(UNAVAILABLE);
        throw error;
      }
      const wanted = get(row, 'previous_event_id');
      let event: Dict | undefined;
      for (const raw of events ?? []) {
        const value = toPlainJson(raw, { bigints: true });
        if (isDict(value) && equal(get(value, 'id'), wanted)) {
          event = value;
          break;
        }
      }
      const payload = event === undefined ? undefined : get(event, 'payload');
      const sourceKey =
        event === undefined ? '' : Object.hasOwn(event, 'source_key') ? event['source_key'] : '';
      const evidence = isDict(payload) ? get(payload, 'evidence') : undefined;
      if (
        event === undefined ||
        !isDict(payload) ||
        get(event, 'event_type') !== 'finding-event' ||
        !pyStr(sourceKey).startsWith('repair-outcome:') ||
        get(payload, 'actor') !== 'crq-repair' ||
        get(payload, 'finding_id') !== fid ||
        !equal(get(payload, 'action'), status) ||
        !isDict(evidence) ||
        !equal(get(evidence, 'repair_task'), get(job, 'job'))
      ) {
        throw refuse("canonical finding disposition is not this repair task's outcome");
      }
    },
  };
}
