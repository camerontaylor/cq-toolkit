/**
 * Replay of the triage phase tail against the Python oracle.
 *
 * `apps/crq-python/triage_phase_vectors.py` drives the PRODUCTION
 * `crq_repair.triage.phase` with a scripted judge, a fake inbox over a temp
 * `triage/` directory, a fake repo and a fake clock, and records the ordered
 * call trace (context, context_error, judge, triage, deliver) plus the report
 * or the escaping exception class. Each case also records the head/tail
 * boundary (mechanical plans and judgment candidates), so this test does not
 * depend on the TS head: it feeds the boundary and the same script to
 * `triagePhaseTail` and compares the trace and report byte for byte.
 *
 * No process, filesystem write, provider, queue or network participates.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  toPlainJson,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import { ContextScanError, errorReason } from '../../../src/policy/crq/triageContextScan.js';
import {
  TriageGitFailure,
  type TriageDecisionRepo,
} from '../../../src/policy/crq/triageDecision.js';
import {
  RepairRoundCeilingError,
  TriageInjectedFailure,
  TriageJudgeTimeout,
  TriageTailRefusal,
  triagePhaseTail,
  type TriageTailInbox,
  type TriageTailReport,
  type TriageTailRow,
} from '../../../src/policy/crq/triageTail.js';

type Script = Record<string, Record<string, Record<string, unknown>>>;

interface PhaseCase {
  name: string;
  rows: Array<{ id: string }>;
  rows_json: string[];
  maximum?: number;
  seconds?: number;
  dry_run?: boolean;
  ts_refuses: boolean;
  judge?: Record<
    string,
    {
      report_json?: string;
      advance?: number;
      raises?: string;
      message?: string;
      injected_form?: boolean;
    }
  >;
  context?: Record<string, { advance?: number; raises?: string; message?: string }>;
  context_error?: Script;
  triage?: Script;
  deliver?: Record<
    string,
    { raises?: string; message?: string; injected_form?: boolean; corrupt?: unknown }
  >;
  boundary: {
    candidates: Array<{ id: string; escalate: boolean }>;
    plans: Array<{
      id: string;
      action: string;
      reason: string;
      kwargs_json: string;
      escalate: boolean;
    }>;
  };
  expected: { trace: unknown[][]; report_json?: string; raises?: string };
}

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../apps/crq-python/fixtures/crq-triage-phase/cases.json', import.meta.url),
    'utf8',
  ),
) as { tip: string; at: string; cases: PhaseCase[] };

const TRANSPORT = 'transport';
const UNCAUGHT_PYTHON = new Set(['KeyError', 'AttributeError', 'TypeError']);
// `triage.context` failures phase() records instead of raising.
const CONTEXT_CAUGHT = new Set([
  'KeyError',
  'TypeError',
  'ValueError',
  'IntegrityError',
  'CalledProcessError',
  'TimeoutExpired',
  'OSError',
  'FileNotFoundError',
]);

/** Python `json.dumps(value)` (ensure_ascii, default separators). */
function pyDump(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') {
    return JSON.stringify(value).replace(
      /[\u0080-￿]/gu,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
  }
  if (value instanceof JsonNumber) return value.raw;
  if (Array.isArray(value)) return `[${value.map(pyDump).join(', ')}]`;
  return `{${value.entries.map(([k, v]) => `${pyDump(k)}: ${pyDump(v)}`).join(', ')}}`;
}

/** Plain JS (objects in insertion order, integers) to a JsonValue. */
function toJson(value: unknown): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return JsonNumber.int(value);
  if (Array.isArray(value)) return value.map(toJson);
  return new JsonObject(Object.entries(value as object).map(([k, v]) => [k, toJson(v)]));
}

function raise(name: string, message = ''): never {
  if (name === 'TimeoutExpired') throw new TriageJudgeTimeout(message);
  if (name === 'ContextScanError') throw new ContextScanError(errorReason(message, 'str'));
  if (name === 'RepairRoundCeiling') throw new RepairRoundCeilingError(message);
  throw new TriageInjectedFailure(name, message);
}

function decisionRepo(): TriageDecisionRepo {
  return {
    resolve(value) {
      if (typeof value !== 'string') throw new TriageGitFailure('TypeError');
      if (value.length !== 40) throw new TriageGitFailure('IntegrityError');
      return value;
    },
    git() {
      throw new Error('unexpected git');
    },
    lineage() {
      throw new Error('unexpected lineage');
    },
    entryBlob() {
      throw new Error('unexpected entries');
    },
  };
}

function reportToPython(report: TriageTailReport): string {
  return pyDump(
    new JsonObject([
      ['total', toJson(report.total)],
      ['judged', toJson(report.judged)],
      ['unjudged', toJson(report.unjudged)],
      ['counts', toJson(Object.fromEntries(report.counts))],
      ['delivered', toJson(report.delivered)],
      ['delivery_deferred', toJson(report.deliveryDeferred)],
      [
        'context_errors',
        toJson(
          report.contextErrors.map((e) => ({
            finding_id: e.findingId,
            type: e.type,
            target: e.target,
          })),
        ),
      ],
      ['stop_report', report.stopReport],
      ['stopped', report.stopped],
      ['dry_run', report.dryRun],
      ['judgment_candidates', [...report.judgmentCandidates]],
      [
        'outcomes',
        toJson(
          report.outcomes.map((o) => ({
            finding_id: o.findingId,
            action: o.action,
            reason: o.reason,
          })),
        ),
      ],
    ]),
  );
}

async function replay(item: PhaseCase): Promise<{ trace: unknown[][]; report?: string }> {
  const trace: unknown[][] = [];
  const store = new Map<string, Record<string, unknown>>();
  const unreadable = new Map<string, string>();
  const loaded = new Map<string, JsonObject>();
  for (const text of item.rows_json) {
    const plain = JSON.parse(text) as { finding: { id: string } };
    store.set(plain.finding.id, plain);
    loaded.set(plain.finding.id, parseJsonValue(text) as JsonObject);
  }
  const rowOf = (id: string, escalate: boolean): TriageTailRow => ({
    row: loaded.get(id) as JsonObject,
    escalate,
  });
  const clock = { now: 0 };
  const counter = { value: 0 };
  const triageCalls = (fid: string): number =>
    trace.filter((entry) => entry[0] === 'triage' && entry[1] === fid).length;

  /** Damage a row file after the head loaded it: only the delivery loop re-reads it. */
  const applyCorrupt = (spec: unknown): void => {
    if (spec === undefined) return;
    const corrupt = spec as {
      id: string;
      field?: string;
      delete?: boolean;
      value?: unknown;
      raw?: string;
      raises?: string;
    };
    if (corrupt.raw !== undefined) {
      unreadable.set(corrupt.id, corrupt.raises ?? 'JSONDecodeError');
      return;
    }
    const damaged = store.get(corrupt.id) as Record<string, unknown>;
    if (corrupt.delete === true) delete damaged[corrupt.field as string];
    else damaged[corrupt.field as string] = corrupt.value;
  };

  const inbox: TriageTailInbox<string> = {
    contextError(fid, previous, error) {
      trace.push(['context_error', fid, toPlainJson(previous), pyDump(error)]);
      const entry = item.context_error?.[fid]?.[error === null ? 'clear' : 'set'] ?? {};
      applyCorrupt(entry.corrupt);
      if (typeof entry.raises === 'string') raise(entry.raises, String(entry.message ?? ''));
      return Promise.resolve('result' in entry ? (entry.result as boolean) : true);
    },
    triage(call) {
      const expected: [string, JsonValue] = [
        'expected_previous_event_id',
        call.expectedPreviousEventId,
      ];
      // Python passes `expected_previous_event_id` first on the plan path and
      // after `failure_class` on the delivery demotion.
      const entries =
        call.actor === 'crq-triage/delivery'
          ? [...call.kwargs.entries, expected]
          : [expected, ...call.kwargs.entries];
      trace.push([
        'triage',
        call.findingId,
        fixture.tip,
        call.action,
        call.actor,
        call.reason,
        call.at,
        pyDump(new JsonObject(entries)),
      ]);
      const script = item.triage?.[call.findingId] ?? {};
      const entry = script[String(triageCalls(call.findingId))] ?? script['*'] ?? {};
      if (typeof entry.raises === 'string') raise(entry.raises, String(entry.message ?? ''));
      if (entry.none === true) return Promise.resolve(null);
      const recorded = 'action' in entry ? entry.action : call.action;
      const row = store.get(call.findingId) as Record<string, unknown>;
      row.status = typeof recorded === 'string' ? recorded : call.action;
      if (recorded === 'confirmed') row.target_current = fixture.tip;
      counter.value += 1;
      row.previous_event_id = `ev-${counter.value}`;
      if (entry.no_payload === true) return Promise.resolve(new JsonObject([]));
      return Promise.resolve(toJson({ payload: { action: recorded } }) as JsonObject);
    },
    // The listing is taken once; each file is read at its own turn, as Python does.
    async *readTriageRows() {
      const names = [...store.keys()].sort((a, b) => (`${a}.json` < `${b}.json` ? -1 : 1));
      for (const name of names) {
        const broken = unreadable.get(name);
        if (broken !== undefined) throw new TriageInjectedFailure(broken, 'unreadable row file');
        yield parseJsonValue(JSON.stringify(store.get(name))) as JsonObject;
      }
      await Promise.resolve();
    },
    deliver(fid, transport, at) {
      trace.push(['deliver', fid, transport, at]);
      const entry = item.deliver?.[fid] ?? {};
      applyCorrupt(entry.corrupt);
      if (typeof entry.raises === 'string') {
        if (entry.injected_form === true) {
          throw new TriageInjectedFailure(entry.raises, String(entry.message ?? ''));
        }
        raise(entry.raises, String(entry.message ?? ''));
      }
      return Promise.resolve({ receipt: fid });
    },
  };

  const run = triagePhaseTail<string>({
    rows: [...loaded.values()],
    plans: item.boundary.plans.map((plan) => ({
      row: rowOf(plan.id, plan.escalate),
      action: plan.action,
      reason: plan.reason,
      kwargs: parseJsonValue(plan.kwargs_json) as JsonObject,
    })),
    candidates: item.boundary.candidates.map((c) => rowOf(c.id, c.escalate)),
    tip: fixture.tip,
    at: fixture.at,
    maximum: item.maximum ?? 6,
    deadline: item.seconds ?? 600,
    clock: () => clock.now,
    dryRun: item.dry_run ?? false,
    inbox,
    transport: TRANSPORT,
    decisionRepo: decisionRepo(),
    prepareContext(candidate) {
      const id = (candidate.row.get('finding') as JsonObject).get('id') as string;
      trace.push(['context', id, candidate.escalate]);
      const entry = item.context?.[id] ?? {};
      clock.now += entry.advance ?? 0;
      if (typeof entry.raises === 'string') {
        if (!CONTEXT_CAUGHT.has(entry.raises)) raise(entry.raises, String(entry.message ?? ''));
        return { kind: 'error', errorType: entry.raises };
      }
      return { kind: 'ready', packed: new JsonObject([['packed', id]]) };
    },
    judge(request) {
      const id = (request.row.get('finding') as JsonObject).get('id') as string;
      trace.push(['judge', id, pyDump(request.packed), request.remaining, request.escalate]);
      const entry = item.judge?.[id] ?? {
        report_json: '{"stop": "ok", "verdict": "invalid", "reason": "default"}',
      };
      clock.now += entry.advance ?? 0;
      if (typeof entry.raises === 'string') {
        if (entry.injected_form === true)
          throw new TriageInjectedFailure(entry.raises, String(entry.message ?? ''));
        raise(entry.raises, String(entry.message ?? ''));
      }
      return parseJsonValue(entry.report_json as string);
    },
  });
  try {
    return { trace, report: reportToPython(await run) };
  } catch (error) {
    (error as { trace?: unknown[][] }).trace = trace;
    throw error;
  }
}

describe('triagePhaseTail against the Python oracle', () => {
  test('the fixture is large and covers raises, refusals and every seam', () => {
    expect(fixture.cases.length).toBeGreaterThan(90);
    expect(fixture.cases.some((item) => item.ts_refuses)).toBe(true);
    expect(fixture.cases.some((item) => item.expected.raises !== undefined)).toBe(true);
    const seen = new Set(fixture.cases.flatMap((item) => item.expected.trace.map((t) => t[0])));
    expect([...seen].sort()).toEqual(['context', 'context_error', 'deliver', 'judge', 'triage']);
  });

  for (const item of fixture.cases) {
    test(item.name, async () => {
      const expected = item.expected;
      if (item.ts_refuses) {
        await expect(replay(item)).rejects.toBeInstanceOf(TriageTailRefusal);
        return;
      }
      if (expected.raises !== undefined) {
        let caught: unknown;
        try {
          await replay(item);
        } catch (error) {
          caught = error;
        }
        expect(caught, 'the port must raise where Python raises').toBeDefined();
        const trace = (caught as { trace?: unknown[][] }).trace;
        // Effects Python applied before the exception stay applied.
        expect(trace).toEqual(expected.trace);
        if (caught instanceof TriageTailRefusal) {
          expect(UNCAUGHT_PYTHON.has(expected.raises)).toBe(true);
        } else {
          expect(caught).toBeInstanceOf(TriageInjectedFailure);
          expect((caught as TriageInjectedFailure).pythonType).toBe(expected.raises);
        }
        return;
      }
      const result = await replay(item);
      expect(result.trace).toEqual(expected.trace);
      expect(result.report).toBe(expected.report_json);
    });
  }
});
