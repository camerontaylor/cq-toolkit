// THE shipped driver-conformance suite — T1.4 slice 3, seam v2 (ADR-0002 §4).
//
// Shared, parameterized behavioral contract for EVERY first-party driver on
// the frozen seam: each lane's test file calls `runDriverConformance` with
// its own `makeDriver` and ITS TEST FRAMEWORK's `{describe, test, expect}`
// functions (the runner is INJECTED — this module imports no test framework).
// Deliberately driver-agnostic: the suite touches ONLY the frozen `Driver`
// interface, the harness `SessionStore` (the I6 record format every driver
// shares), the driver-family strict `WorkerResultSchema` mirror, and the
// shared seam helpers (`toOutputSchema`, `withServedModelAssertion`). No
// vendor types, no driver internals — and NO kernel import: the seam rule
// (src/driver never imports src/kernel) binds this file, so the GOVERNED
// abort leg (b-ii, the kernel escalation ladder) lives in the callers' test
// tree (test/driver/conformance-kernel.ts), which imports the kernel on the
// lanes' behalf.
//
// THE MAKE-DRIVER CONTRACT (what a conforming `makeDriver` must honor):
//   - `spec.scratchDir` — a suite-created temp directory. The driver's
//     session store MUST live at `<scratchDir>/sessions` (SESSIONS_DIR) and
//     its scratch workspaces SHOULD live under `<scratchDir>`, so the suite
//     can inspect records with harness SessionStore and clean everything up.
//   - `spec.directive` — scripts the MODEL's behavior for this driver's
//     runs, in OUR vocabulary (never vendor shapes):
//       { kind: 'reply', text }                    — the model replies with
//                                                    exactly this text;
//       { kind: 'tool-then-reply', tool, input, reply }
//                                                  — the model issues ONE
//                                                    tool call with this
//                                                    name/input, then
//                                                    replies with `reply`;
//       { kind: 'block-until-abort' }              — the model blocks until
//                                                    the abort signal fires,
//                                                    then rejects (the abort
//                                                    tests);
//       { kind: 'fail' }                           — the model fails with a
//                                                    plain non-abort error
//                                                    (the error-verdict
//                                                    test).
//       { kind: 'reply-invalid-json' }             — the model replies with
//                                                    text that is NOT the
//                                                    JSON object a
//                                                    structured-output
//                                                    schema demands (the
//                                                    output-invalid legs).
//     The scripted model MUST report token usage (input/output/cacheRead/
//     cacheWrite, reasoning optional) — the usage contract needs numbers.
//   - Tool permissions follow the frozen `OpInvocation` policies: the
//     isolation tests WRITE with `echo conformance-marker > note.txt` — a
//     redirecting command, which token patterns deny by design (shell-
//     metacharacter guard), so makeDriver MUST permit that write via an
//     anchored re: pattern (e.g. 're:^echo .* > note\.txt$'); a 'read-only'
//     sandbox MUST deny edit/run (the denial test rides that documented
//     harness mapping).
//   - `spec.pricedModel` — when present, makeDriver must resolve this
//     ModelSpec onto its scripted model THROUGH its price map (ai-sdk: the
//     `pricing` option), so the derived-cost test asserts a real costUSD
//     labeled `costBasis: 'modeled'` (the api-equivalent figure; DD-9). The
//     canonical conformance model is NEVER priced.
//   - I8: run() honors `RunOptions.signal` — seam v2's only cancellation
//     channel (leg b-iii: a pre-aborted signal never dispatches; a
//     mid-run fire settles 'aborted' with NO governor in the loop). Leg
//     b-v re-runs b-iii THROUGH the seam's pass-through wrappers; the
//     kernel-ladder leg (b-ii) is the callers' kernel test.
//   - `OpInvocation.workspace` (seam v2, ADR-0002 §2.4): when set without a
//     sessionRef, the fresh record is created IN the bound directory's
//     realpath and the tool write lands there (leg f-iii); with a
//     sessionRef recording a DIFFERENT realpath, the run throws
//     PRE-DISPATCH with `errorClassOf → 'config'` (leg f-iv). Session
//     records stay in the lane's sessionsDir — never in the workspace.
//   - The driver MUST surface the served model id in `WorkerResult.model`
//     on a completed run (the observed-model check, leg m, binds all
//     lanes: the RESPONSE-reported id, present and equal to the requested
//     `ModelSpec.model`).
//
// Each test builds a FRESH driver via makeDriver (no state shared between
// tests) in a fresh temp scratch dir, removed in a finally block.
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { toOutputSchema } from './common/structured.js';
import { errorClassOf } from './errors.js';
import { normaliseModelId, servedModelCheck, withServedModelAssertion } from './served-model.js';
import type { ServedModelPolicy } from './served-model.js';
import { SEAM_VERSION } from './types.js';
import type { Budget, Driver, OpInvocation, RunOptions, WorkerResult } from './types.js';
import { WorkerResultSchema } from './schema.js';
import { SessionStore } from '../harness/session.js';

// ---------------------------------------------------------------------------
// The injected test-runner surface (no test framework is imported here)
// ---------------------------------------------------------------------------

/** The minimal expectation surface the suite uses — vitest-compatible. */
export interface ConformanceExpectation {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeDefined(): void;
  toBeUndefined(): void;
  toBeCloseTo(expected: number, numDigits?: number): void;
  toBeGreaterThan(expected: number): void;
  toBeGreaterThanOrEqual(expected: number): void;
  toBeLessThanOrEqual(expected: number): void;
  toContain(expected: unknown): void;
  readonly not: ConformanceExpectation;
  readonly resolves: ConformanceExpectation;
}

/** The test-framework functions a caller injects (vitest's own work verbatim). */
export interface ConformanceRunner {
  describe(name: string, fn: () => void): void;
  test(name: string, fn: () => void | Promise<void>): void;
  expect(actual: unknown): ConformanceExpectation;
}

// ---------------------------------------------------------------------------
// The make-driver contract (public so driver implementations can type against it)
// ---------------------------------------------------------------------------

/** Scripts the model's behavior for one driver instance — OUR vocabulary, not vendor shapes. */
export type ModelDirective =
  | { kind: 'reply'; text: string }
  | { kind: 'tool-then-reply'; tool: string; input: unknown; reply: string; toolIdentity?: string }
  // The model BLOCKS until the abort signal fires, then rejects — the
  // script behind the I8 abort tests (makeDriver wires the driver's abort
  // seam; the mock honors it).
  | { kind: 'block-until-abort' }
  // The model FAILS outright (a plain non-abort error) — the script behind
  // the error-verdict test: the driver must RETURN stopReason 'error', never
  // throw past the seam.
  | { kind: 'fail' }
  // The model replies with text that is NOT the JSON object a structured-
  // output schema demands — the script behind the output-invalid legs (seam
  // v2, ADR-0002 §2.3): the driver must repair once (W3.4) and then settle
  // error/'output-invalid' with usage kept.
  | { kind: 'reply-invalid-json' };

/** Per-driver construction hints the suite hands to `makeDriver`. */
export interface ConformanceSpec {
  /** Script the model's behavior for this driver's runs. */
  directive?: ModelDirective;
  /**
   * A ModelSpec the driver's PRICE MAP knows: makeDriver must resolve this
   * handle onto its scripted model THROUGH its pricing, so the derived-cost
   * test can assert costUSD is a real number. (The canonical conformance
   * model is by contract NEVER priced — the absent-costUSD assertion needs
   * an unknown model to catch fabricating drivers.)
   *
   * `rates` — the per-million USD rates (input/output required; cache
   * directions optional — an absent rate is a zero-priced term, DD-2) that
   * makeDriver's price map MUST attach to this provider+model key. When
   * declared, the derived-cost test recomputes Σ tokens/1e6 × rate over the
   * SERVED model id (result.model ?? requested; leg m binds it to the
   * requested id) with the requested provider and asserts costUSD equals it
   * EXACTLY — pricing the wrong key (e.g. the requested id when the
   * response reports a served remap) or mispricing a token class fails
   * here, not just a NaN/absent figure.
   */
  pricedModel?: {
    provider: string;
    model: string;
    rates?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  };
  /** Suite-created temp dir: session store at `<scratchDir>/sessions`, workspaces under it. */
  scratchDir: string;
}

/** A conforming driver factory: fresh driver per call, honoring the ConformanceSpec contract. */
export type ConformanceMakeDriver = (spec: ConformanceSpec) => Driver;

/** The session-store directory name inside scratchDir (the suite reads records through it). */
export const SESSIONS_DIR = 'sessions';

/**
 * The canonical provider handle + model id of the suite's invocations. A
 * conforming makeDriver resolves THIS handle to its scripted model (the
 * ai-sdk instantiation registers it in its `providers` override).
 */
export const CONFORMANCE_PROVIDER = 'conformance';
export const CONFORMANCE_MODEL = 'conformance-1';

/** Banned vendor vocabulary — a serialized WorkerResult must contain NONE of these (case-sensitive). */
export const BANNED_VOCABULARY: readonly string[] = [
  'SDKMessage',
  'BaseMessage',
  'RunState',
  'AIMessage',
  'HumanMessage',
  'SystemMessage',
  'ToolMessage',
  'UIMessage',
  'ModelMessage',
  'ResponseMessage',
];

/**
 * The canonical conformance invocation; only the pieces a caller names
 * differ. Exported so the callers' kernel-side legs (b-ii) dispatch on the
 * SAME canonical invocation the shipped suite uses.
 */
export function conformanceInvocation(overrides: Partial<OpInvocation> = {}): OpInvocation {
  return {
    prompt: 'conformance run',
    modelSpec: { provider: CONFORMANCE_PROVIDER, model: CONFORMANCE_MODEL },
    toolPolicy: { allow: [], mode: 'unrestricted' },
    sandboxPolicy: { level: 'workspace-write' },
    budget: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

/**
 * Register the conformance suite for one driver. Call from a test file,
 * passing the test framework's own `{describe, test, expect}` as the
 * runner; every test constructs a fresh driver in a fresh scratch dir.
 */
export function runDriverConformance(
  makeDriver: ConformanceMakeDriver,
  runner: ConformanceRunner,
  opts?: { label?: string },
): void {
  const { describe, test, expect } = runner;
  const label = opts?.label ?? 'driver';

  /** Fresh scratch dir per test, cleaned up no matter how the body ends. */
  async function withScratch(body: (scratchDir: string) => Promise<void>): Promise<void> {
    const scratchDir = await mkdtemp(join(tmpdir(), 'conformance-'));
    try {
      await body(scratchDir);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  }

  describe(`driver conformance: ${label}`, () => {
    test('a. structured-output round-trip: the schema rides the INVOCATION; parsed, plain JSON, schema-valid, stable under re-parse', async () => {
      await withScratch(async (scratchDir) => {
        const schema = z.object({ answer: z.string() }).strict();
        const driver = makeDriver({
          directive: { kind: 'reply', text: '{"answer":"ok"}' },
          scratchDir,
        });
        // Seam v2 (§2.3): the structured-output contract is a PER-INVOCATION
        // request built through the shared seam — never a driver-construction
        // option.
        const result = await driver.run(
          conformanceInvocation({
            prompt: 'produce structured output',
            outputSchema: toOutputSchema('conformance/structured/v1', schema),
          }),
        );
        expect(result.stopReason).toBe('complete');
        expect(result.structuredOutput).toBeDefined();
        const once = JSON.parse(JSON.stringify(result.structuredOutput)) as unknown;
        // stringify → parse → revalidate → deep-equal: plain JSON in, schema-valid, no drift.
        const reparsed = schema.parse(JSON.parse(JSON.stringify(once)));
        expect(reparsed).toEqual({ answer: 'ok' });
        expect(once).toEqual(reparsed);
      });
    });

    test('a-ii. invocation schema + a non-JSON reply: error/output-invalid, no structuredOutput, usage kept, mirror parses', async () => {
      await withScratch(async (scratchDir) => {
        const schema = z.object({ answer: z.string() }).strict();
        const driver = makeDriver({
          directive: { kind: 'reply-invalid-json' },
          scratchDir,
        });
        const result = await driver.run(
          conformanceInvocation({
            prompt: 'produce structured output',
            outputSchema: toOutputSchema('conformance/invalid-reply/v1', schema),
          }),
        );
        // The §2.3 miss verdict is uniform: the requested object did not
        // arrive, so the run is an ERROR (never a complete with the payload
        // dropped), classed 'output-invalid'.
        expect(result.stopReason).toBe('error');
        expect(result.errorClass).toBe('output-invalid');
        expect(result.structuredOutput).toBeUndefined();
        // A real measurement keeps its evidence on the miss verdict: numbers,
        // with the model actually consulted.
        expect(typeof result.usage.input).toBe('number');
        expect(typeof result.usage.output).toBe('number');
        expect(result.usage.input).toBeGreaterThan(0);
        // The rejection is visible: the verdict carries a non-empty cause.
        expect(typeof result.error).toBe('string');
        expect((result.error as string).length).toBeGreaterThan(0);
        // The one-directional errorClass wire rule: the serialized error
        // verdict still parses through the strict mirror.
        const reparsed: WorkerResult = WorkerResultSchema.parse(JSON.parse(JSON.stringify(result)));
        expect(reparsed.stopReason).toBe('error');
        expect(reparsed.errorClass).toBe('output-invalid');
      });
    });

    test('a-iii. NO invocation schema: a JSON-shaped reply completes with structuredOutput ABSENT', async () => {
      await withScratch(async (scratchDir) => {
        // The reply LOOKS like a structured payload, but nothing requested
        // one: a lane that fabricates a structuredOutput (or parses the reply
        // unprompted) fails here — honest absence (§2.3).
        const driver = makeDriver({
          directive: { kind: 'reply', text: '{"answer":"ok"}' },
          scratchDir,
        });
        const result = await driver.run(conformanceInvocation({ prompt: 'plain reply run' }));
        expect(result.stopReason).toBe('complete');
        expect(result.structuredOutput).toBeUndefined();
        expect(result.errorClass).toBeUndefined();
      });
    });

    test('a-iv. ONE driver, TWO runs with DIFFERENT invocation schemas: each result validates against its OWN schema', async () => {
      await withScratch(async (scratchDir) => {
        // ONE reply (a driver's directive is static), TWO invocation
        // documents: each requiring a DIFFERENT key, both tolerant of the
        // key they do not name — so the shared reply satisfies each run's
        // OWN schema and the payloads stay plain data on every lane.
        const schemaA = z.object({ answer: z.string() });
        const schemaB = z.object({ otherAnswer: z.string() });
        const driver = makeDriver({
          directive: { kind: 'reply', text: '{"answer":"ok","otherAnswer":"also-ok"}' },
          scratchDir,
        });
        const runA = await driver.run(
          conformanceInvocation({
            prompt: 'schema A run',
            outputSchema: toOutputSchema('conformance/schema-a/v1', schemaA),
          }),
        );
        const runB = await driver.run(
          conformanceInvocation({
            prompt: 'schema B run',
            outputSchema: toOutputSchema('conformance/schema-b/v1', schemaB),
          }),
        );
        expect(runA.stopReason).toBe('complete');
        expect(runB.stopReason).toBe('complete');
        // Each result is valid against ITS OWN invocation schema…
        expect(schemaA.safeParse(runA.structuredOutput).success).toBe(true);
        expect(schemaB.safeParse(runB.structuredOutput).success).toBe(true);
        // …and the binding is REAL (not a rubber stamp): a THIRD run on the
        // same driver, same reply, asking for a type the reply does not
        // carry, settles the §2.3 miss — only a driver that judges every run
        // by ITS OWN invocation document produces complete/complete/error
        // from one static reply (a driver bound to one construction-level
        // schema cannot).
        const runC = await driver.run(
          conformanceInvocation({
            prompt: 'schema C run',
            outputSchema: toOutputSchema(
              'conformance/schema-c/v1',
              z.object({ answer: z.number() }),
            ),
          }),
        );
        expect(runC.stopReason).toBe('error');
        expect(runC.errorClass).toBe('output-invalid');
      });
    });

    test('b-i. budget: maxTokens trips stopReason budget with usage present', async () => {
      await withScratch(async (scratchDir) => {
        const driver = makeDriver({
          directive: { kind: 'reply', text: 'this reply is never the point' },
          scratchDir,
        });
        const result = await driver.run(conformanceInvocation({ budget: { maxTokens: 1 } }));
        expect(result.stopReason).toBe('budget');
        expect(typeof result.usage.input).toBe('number');
        expect(typeof result.usage.output).toBe('number');
      });
    });

    test('b-iv. Budget pass-through (ADR-0003): an unknown optional Budget field is IGNORED, not rejected; RunOptions.reservation is accepted', async () => {
      await withScratch(async (scratchDir) => {
        const driver = makeDriver({ directive: { kind: 'reply', text: 'ok' }, scratchDir });
        // A forward-compat cap a later ADR adds: the Budget record is OPEN —
        // a lane that rejected unknown fields would break every older caller
        // the moment the record grows. (The cast is the point: TS would
        // reject the literal; the WIRE must not.)
        const forwardBudget = {
          maxTokens: 10_000,
          aFutureCapField: 'added by a later ADR',
        } as unknown as Budget;
        const budgeted = await driver.run(conformanceInvocation({ budget: forwardBudget }));
        expect(budgeted.stopReason).toBe('complete');
        // The governor's reservation (ADR-0003 §2.2) rides RunOptions next
        // to the signal. A lane MAY ignore it — ACCEPTING the run is the
        // contract; the governor enforces, the lane informs.
        const reserved = await driver.run(conformanceInvocation(), {
          reservation: { id: 'conf-reservation', usd: 1, overshootUsd: 0, class: 'hard' },
        });
        expect(reserved.stopReason).toBe('complete');
      });
    });

    test('b-v. the pass-through wrappers forward RunOptions.signal — a wrapper that drops it kills cancellation silently', async () => {
      // Part 1 — the shared served-model wrapper over a signal-observing
      // fake: the pre-aborted signal MUST reach the inner driver. The lane
      // scope names 'ai-sdk' only because the wrapper requires one; an
      // aborted/complete-with-exact-model run is never lane-judged here.
      let seen: RunOptions | undefined;
      const fake: Driver = {
        run: async (inv, options) => {
          seen = options;
          return {
            stopReason: 'complete',
            model: inv.modelSpec.model,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            denials: [],
          };
        },
      };
      const dead = new AbortController();
      dead.abort();
      await withServedModelAssertion(fake, { lane: 'ai-sdk' }).run(conformanceInvocation(), {
        signal: dead.signal,
      });
      expect(seen).toBeDefined();
      expect(seen?.signal).toBeDefined();
      expect(seen?.signal?.aborted).toBe(true);
      // Part 2 — the REAL lane under test behind the SAME wrapper: the
      // mid-run fire still settles 'aborted' (b-iii's contract survives the
      // wrapper). The FACTORY's wrappers (reap-on-settle resolution and the
      // full resolve() stack) are proven signal-tight in
      // test/driver/factory.test.ts (leg b-v's factory half).
      await withScratch(async (scratchDir) => {
        const midRun = withServedModelAssertion(
          makeDriver({ directive: { kind: 'block-until-abort' }, scratchDir }),
          { lane: 'ai-sdk' },
        );
        const live = new AbortController();
        setTimeout(() => live.abort(), 100);
        const aborted = await midRun.run(conformanceInvocation(), { signal: live.signal });
        expect(aborted.stopReason).toBe('aborted');
        expect(aborted.error).toBeUndefined(); // the cancellation is not a failure
      });
    });

    test('c. denial reporting: denials non-empty, exactly the frozen {tool, reason} shape', async () => {
      await withScratch(async (scratchDir) => {
        const driver = makeDriver({
          directive: {
            kind: 'tool-then-reply',
            tool: 'edit',
            toolIdentity: 'edit',
            input: { path: 'x.txt', oldText: 'a', newText: 'b' },
            reply: 'noted the refusal',
          },
          scratchDir,
        });
        // read-only sandbox: edit MUST deny (documented harness mapping);
        // the denial flows into WorkerResult.denials in the frozen shape.
        const result = await driver.run(
          conformanceInvocation({ sandboxPolicy: { level: 'read-only' } }),
        );
        expect(result.denials.length).toBeGreaterThan(0);
        for (const denial of result.denials) {
          expect(Object.keys(denial).sort()).toEqual(['reason', 'tool']);
          expect(typeof denial.tool).toBe('string');
          expect(typeof denial.reason).toBe('string');
        }
        expect(result.denials[0]?.tool).toBe('edit');
      });
    });

    test('d. usage fields: input/output/cacheRead/cacheWrite numbers on a successful run', async () => {
      await withScratch(async (scratchDir) => {
        const driver = makeDriver({ directive: { kind: 'reply', text: 'ok' }, scratchDir });
        const result = await driver.run(conformanceInvocation());
        expect(result.stopReason).toBe('complete');
        expect(typeof result.usage.input).toBe('number');
        expect(typeof result.usage.output).toBe('number');
        expect(typeof result.usage.cacheRead).toBe('number');
        expect(typeof result.usage.cacheWrite).toBe('number');
        expect(Number.isNaN(result.usage.input)).toBe(false);
        expect(Number.isNaN(result.usage.output)).toBe(false);
        // The producer rule's other half (seam v2): a complete run carries
        // NO errorClass — a class on a non-error verdict would forge a
        // failure the vendor never reported.
        expect(result.errorClass).toBeUndefined();
      });
    });

    test('e. serialized result: no vendor vocabulary; parses back through the strict WorkerResult mirror', async () => {
      await withScratch(async (scratchDir) => {
        // A run WITH a tool denial, so the serialized evidence covers the
        // denial channel too.
        const driver = makeDriver({
          directive: {
            kind: 'tool-then-reply',
            tool: 'read',
            toolIdentity: 'read',
            input: { path: 'missing.txt' },
            reply: 'done anyway',
          },
          scratchDir,
        });
        const result = await driver.run(conformanceInvocation());
        const serialized = JSON.stringify(result);
        for (const banned of BANNED_VOCABULARY) {
          expect(serialized).not.toContain(banned);
        }
        // The seam contract, mechanically: the strict zod mirror (unknown
        // keys FAIL) accepts the wire form of our own result.
        const reparsed: WorkerResult = WorkerResultSchema.parse(JSON.parse(serialized));
        expect(reparsed.stopReason).toBe(result.stopReason);
        expect(reparsed.usage).toEqual(result.usage);
      });
    });

    test('f-i. isolation: a fresh run shares NOTHING with the previous one (I6)', async () => {
      await withScratch(async (scratchDir) => {
        const store = new SessionStore(join(scratchDir, SESSIONS_DIR));
        // Run 1 writes a file into its workspace via the run tool.
        const driver1 = makeDriver({
          directive: {
            kind: 'tool-then-reply',
            tool: 'run',
            toolIdentity: 'run',
            input: { command: 'echo conformance-marker > note.txt' },
            reply: 'wrote note.txt',
          },
          scratchDir,
        });
        const run1 = await driver1.run(conformanceInvocation({ prompt: 'isolation run one' }));
        expect(typeof run1.sessionId).toBe('string');
        const record1 = await store.load(run1.sessionId as string);
        expect(record1).toBeDefined();
        const workspace1 = record1?.workspace as string;
        const record1Length = record1?.messages.length as number;
        expect(record1Length).toBeGreaterThan(0);

        // Run 2 WITHOUT sessionRef: fresh workspace, fresh record, zero carry-over.
        const driver2 = makeDriver({
          directive: {
            kind: 'tool-then-reply',
            tool: 'read',
            toolIdentity: 'read',
            input: { path: 'note.txt' },
            reply: 'fresh workspace',
          },
          scratchDir,
        });
        const run2 = await driver2.run(conformanceInvocation({ prompt: 'isolation run two' }));
        expect(run2.sessionId).not.toBe(run1.sessionId);
        const record2 = await store.load(run2.sessionId as string);
        expect(record2).toBeDefined();
        expect(record2?.workspace).not.toBe(workspace1);
        // Run 1's file is NOT in run 2's workspace: the read is denied.
        expect(
          run2.denials.some((d) => d.tool === 'read' && d.reason.includes('file not found')),
        ).toBe(true);
        // Run 1's prompt and tool message leak nowhere into run 2's record.
        expect(
          record2?.messages.some((m) => m.role === 'user' && m.content === 'isolation run one'),
        ).toBe(false);
        expect(
          record2?.messages.some(
            (m) => m.role === 'tool' && m.content.includes('echo conformance-marker'),
          ),
        ).toBe(false);
      });
    });

    test('f-ii. sessionRef: the recorded session continues — same workspace, same transcript', async () => {
      await withScratch(async (scratchDir) => {
        const store = new SessionStore(join(scratchDir, SESSIONS_DIR));
        const driver1 = makeDriver({
          directive: {
            kind: 'tool-then-reply',
            tool: 'run',
            toolIdentity: 'run',
            input: { command: 'echo conformance-marker > note.txt' },
            reply: 'wrote note.txt',
          },
          scratchDir,
        });
        const run1 = await driver1.run(conformanceInvocation({ prompt: 'resume run one' }));
        const before = await store.load(run1.sessionId as string);
        const workspace1 = before?.workspace as string;
        const lengthBefore = before?.messages.length as number;

        // Run 2 WITH sessionRef: same workspace (the file is still there) and
        // the transcript continues in the SAME record.
        const driver2 = makeDriver({
          directive: {
            kind: 'tool-then-reply',
            tool: 'read',
            toolIdentity: 'read',
            input: { path: 'note.txt' },
            reply: 'resumed and read the note',
          },
          scratchDir,
        });
        if (run1.sessionId === undefined) throw new Error('first run must create a session');
        const run2 = await driver2.run(
          conformanceInvocation({ prompt: 'resume run two', sessionRef: run1.sessionId }),
        );
        expect(run2.sessionId).toBe(run1.sessionId);
        // No read denial: the resumed workspace still holds run 1's file.
        expect(run2.denials.some((d) => d.tool === 'read')).toBe(false);
        const after = await store.load(run1.sessionId as string);
        expect(after?.workspace).toBe(workspace1);
        expect(after?.messages.length).toBeGreaterThan(lengthBefore);
        // The transcript carries run 1 AND run 2 turns, in order.
        expect(
          after?.messages.some((m) => m.role === 'user' && m.content === 'resume run one'),
        ).toBe(true);
        expect(
          after?.messages.some((m) => m.role === 'user' && m.content === 'resume run two'),
        ).toBe(true);
      });
    });

    test('g. costUSD derived-only: ABSENT for the unpriced conformance model (a fabricating driver fails here)', async () => {
      await withScratch(async (scratchDir) => {
        const driver = makeDriver({
          directive: { kind: 'reply', text: 'ok' },
          scratchDir,
        });
        const result = await driver.run(conformanceInvocation());
        // The canonical conformance model is by contract NOT in any price
        // map: a driver reporting costUSD for it is fabricating cost. No
        // cost means no basis either — costBasis is never fabricated without
        // a costUSD to describe (DD-9).
        expect(result.costUSD).toBeUndefined();
        expect(result.costBasis).toBeUndefined();
      });
    });

    test('h. costUSD present, finite, and EXACTLY the derived figure when the model is priced', async () => {
      await withScratch(async (scratchDir) => {
        const pricedModel: NonNullable<ConformanceSpec['pricedModel']> = {
          provider: 'conformance-priced',
          model: 'priced-1',
          // The rates makeDriver's price map MUST attach to this
          // provider+model key (see ConformanceSpec.pricedModel): the
          // assertion below recomputes the derived cost from them.
          rates: { input: 3, output: 15 },
        };
        const driver = makeDriver({
          directive: { kind: 'reply', text: 'ok' },
          pricedModel,
          scratchDir,
        });
        const result = await driver.run(
          conformanceInvocation({ modelSpec: pricedModel, prompt: 'priced run' }),
        );
        expect(result.stopReason).toBe('complete');
        expect(typeof result.costUSD).toBe('number');
        expect(Number.isFinite(result.costUSD as number)).toBe(true);
        expect(result.costUSD as number).toBeGreaterThanOrEqual(0);
        // A derived figure is modeled — the api-equivalent list-price proxy
        // for the tokens consumed — never claimed as billed (DD-9).
        expect(result.costBasis).toBe('modeled');
        // The EXACT derived figure: Σ tokens/1e6 × rate computed over the
        // SERVED model id (result.model ?? requested; leg m binds served ===
        // requested here) with the REQUESTED provider — provider+model
        // keying. A driver pricing the wrong key or a wrong token class
        // fails here, not just on finiteness.
        const rates = pricedModel.rates;
        if (rates === undefined) {
          throw new Error('conformance: the priced-cost test must declare pricedModel.rates');
        }
        const perMillion = (tokens: number, rate: number | undefined): number =>
          rate === undefined ? 0 : (tokens / 1_000_000) * rate;
        const expected =
          perMillion(result.usage.input, rates.input) +
          perMillion(result.usage.output, rates.output) +
          perMillion(result.usage.cacheRead, rates.cacheRead) +
          perMillion(result.usage.cacheWrite, rates.cacheWrite);
        expect(result.costUSD).toBeCloseTo(expected, 12);
      });
    });

    test('i. model failure: the driver RETURNS stopReason error — never throws past the seam', async () => {
      await withScratch(async (scratchDir) => {
        const driver = makeDriver({ directive: { kind: 'fail' }, scratchDir });
        // The run must RESOLVE with an honest error verdict (carrying the
        // seam evidence — usage, denials, sessionId) — a throw here fails
        // the suite.
        const result = await driver.run(conformanceInvocation());
        expect(result.stopReason).toBe('error');
        expect(result.usage).toBeDefined();
        expect(Array.isArray(result.denials)).toBe(true);
        expect(typeof result.sessionId).toBe('string');
        // The PRODUCER RULE (seam v2 §2.2): every error verdict carries a
        // defined class — classified from structured signals, `unknown` at
        // worst, never absent and never guessed.
        expect(result.errorClass).toBeDefined();
      });
    });

    test('i-ii. pre-dispatch misconfiguration THROWS with errorClass config — never an error verdict', async () => {
      await withScratch(async (scratchDir) => {
        const driver = makeDriver({
          directive: { kind: 'reply', text: 'must never run' },
          scratchDir,
        });
        // A workspace binding naming a directory that does not exist is a
        // CALLER bug: the seam refuses PRE-dispatch with a structured
        // DispatchError('config') (§2.2) — the one throw seam v2 allows.
        let thrown: unknown;
        try {
          await driver.run(
            conformanceInvocation({ workspace: { path: join(scratchDir, 'never-created') } }),
          );
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeDefined();
        expect(errorClassOf(thrown)).toBe('config');
      });
    });

    test('s. providerSignals: plain data through the mirror; a quota verdict carries the reset its source exposed', async () => {
      await withScratch(async (scratchDir) => {
        const driver = makeDriver({ directive: { kind: 'fail' }, scratchDir });
        const result = await driver.run(conformanceInvocation());
        expect(result.stopReason).toBe('error');
        // CONDITIONAL on presence — the suite is lane-agnostic (ACP, for
        // one, never emits signals: its wire exposes no limit structure).
        // Whenever a lane DOES report provider limits, the report is PLAIN
        // DATA in the frozen field set, and the serialized result still
        // parses through the strict mirror.
        if (result.providerSignals !== undefined) {
          const signals = result.providerSignals;
          if (signals.retryAfterMs !== undefined) {
            expect(typeof signals.retryAfterMs).toBe('number');
            expect(Number.isFinite(signals.retryAfterMs)).toBe(true);
          }
          for (const window of signals.windows ?? []) {
            expect(typeof window.id).toBe('string');
            expect(window.id.length).toBeGreaterThan(0);
            if (window.utilization !== undefined) {
              expect(typeof window.utilization).toBe('number');
              expect(window.utilization).toBeGreaterThanOrEqual(0);
              expect(window.utilization).toBeLessThanOrEqual(1);
            }
            if (window.remaining !== undefined) {
              expect(typeof window.remaining).toBe('object');
            }
            if (window.resetAt !== undefined) {
              expect(typeof window.resetAt).toBe('string');
              expect(Number.isNaN(Date.parse(window.resetAt))).toBe(false);
            }
          }
          const reparsed: WorkerResult = WorkerResultSchema.parse(
            JSON.parse(JSON.stringify(result)),
          );
          expect(reparsed.stopReason).toBe('error');
        }
        // THE QUOTA PRODUCER RULE (RS-14 §4): a verdict classed 'quota'
        // whose source exposes a reset carries it — windows[*].resetAt — so
        // the caller can defer-until-reset instead of retrying blind. A lane
        // whose scripted vendor failure exposes no reset shape never
        // classifies quota here, so the assertion binds exactly where the
        // mock's fail emits the vendor's quota-with-reset shape.
        if (result.errorClass === 'quota') {
          const resets = (result.providerSignals?.windows ?? [])
            .map((window) => window.resetAt)
            .filter((resetAt) => resetAt !== undefined);
          expect(resets.length).toBeGreaterThan(0);
        }
      });
    });

    test('j. ToolPolicy mode none: no tool ever executes (observable via the session record)', async () => {
      await withScratch(async (scratchDir) => {
        const store = new SessionStore(join(scratchDir, SESSIONS_DIR));
        const driver = makeDriver({
          directive: {
            kind: 'tool-then-reply',
            tool: 'run',
            toolIdentity: 'run',
            input: { command: 'echo policy-marker > policy.txt' },
            reply: 'unused',
          },
          scratchDir,
        });
        // mode 'none' exposes NO tools; the directed tool call must never
        // reach the harness. maxTokens bounds the step loop defensively —
        // whatever verdict the driver lands on, the observable fact is that
        // the tool never ran.
        const result = await driver.run(
          conformanceInvocation({
            toolPolicy: { allow: [], mode: 'none' },
            budget: { maxTokens: 25 },
          }),
        );
        const record = await store.load(result.sessionId as string);
        expect(record?.messages.some((m) => m.role === 'tool')).toBe(false);
      });
    });

    test('k. ToolPolicy allowlist: an allowed tool executes; a disallowed tool never does', async () => {
      await withScratch(async (scratchDir) => {
        const store = new SessionStore(join(scratchDir, SESSIONS_DIR));
        const policy = { allow: ['read'], mode: 'allowlist' as const };
        // Allowed tool: executes (its outcome lands in the record/denials).
        const allowedDriver = makeDriver({
          directive: {
            kind: 'tool-then-reply',
            tool: 'read',
            toolIdentity: 'read',
            input: { path: 'absent.txt' },
            reply: 'done',
          },
          scratchDir,
        });
        const allowed = await allowedDriver.run(
          conformanceInvocation({ toolPolicy: policy, prompt: 'allowlist allowed' }),
        );
        expect(allowed.denials.some((d) => d.tool === 'read')).toBe(true); // executed and refused on the merits
        const allowedRecord = await store.load(allowed.sessionId as string);
        expect(
          allowedRecord?.messages.some((m) => m.role === 'tool' && m.toolName === 'read'),
        ).toBe(true);
        // Disallowed tool: never executes — no tool message for it, and the
        // side effect (the file) never appears. maxTokens bounds the step
        // loop the same way as the none-mode test.
        const deniedDriver = makeDriver({
          directive: {
            kind: 'tool-then-reply',
            tool: 'run',
            toolIdentity: 'run',
            input: { command: 'echo allowlist-marker > out-of-policy.txt' },
            reply: 'unused',
          },
          scratchDir,
        });
        const denied = await deniedDriver.run(
          conformanceInvocation({
            toolPolicy: policy,
            prompt: 'allowlist denied',
            budget: { maxTokens: 25 },
          }),
        );
        const deniedRecord = await store.load(denied.sessionId as string);
        expect(deniedRecord?.messages.some((m) => m.role === 'tool' && m.toolName === 'run')).toBe(
          false,
        );
      });
    });

    test('l. path escape: a read pointing outside the workspace denies at the driver level', async () => {
      await withScratch(async (scratchDir) => {
        const driver = makeDriver({
          directive: {
            kind: 'tool-then-reply',
            tool: 'read',
            toolIdentity: 'read',
            input: { path: '../../outside-secret.txt' },
            reply: 'noted',
          },
          scratchDir,
        });
        const result = await driver.run(conformanceInvocation({ prompt: 'escape attempt' }));
        expect(
          result.denials.some((d) => d.tool === 'read' && d.reason.includes('path escape')),
        ).toBe(true);
      });
    });

    test('m. observed model: the served model id is present and equals the requested model (the silent-remap defence)', async () => {
      await withScratch(async (scratchDir) => {
        const driver = makeDriver({ directive: { kind: 'reply', text: 'ok' }, scratchDir });
        const result = await driver.run(conformanceInvocation());
        // A pre-dispatch allowlist cannot catch a server-side remap; only the
        // RESPONSE can. A driver that hides the served id, or serves a
        // different model than requested, fails here — every lane that runs
        // this suite is bound by this check.
        expect(result.model).toBeDefined();
        expect(result.model).toBe(conformanceInvocation().modelSpec.model);
      });
    });

    test('m-ii. served-model policy: mismatch → error with evidence kept; lane-scoped alias → complete; unobserved policy; the acp normalisation', async () => {
      /** A fake lane that always completes with the given observed id. */
      const laneReporting = (
        observed: string | undefined,
        extra: Partial<WorkerResult> = {},
      ): Driver => ({
        run: async () => ({
          stopReason: 'complete',
          usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 },
          denials: [],
          ...(observed !== undefined ? { model: observed } : {}),
          ...extra,
        }),
      });
      const requested = (model: string): OpInvocation => ({
        ...conformanceInvocation(),
        modelSpec: { provider: 'wire', model },
      });

      // 1. OBSERVED MISMATCH → error/'served-model-mismatch': the spend
      // evidence (usage, providerSignals, the RAW observed id) is KEPT; the
      // payload (structuredOutput) is DROPPED — it is not an outcome the
      // requested model produced.
      const mismatch = await withServedModelAssertion(
        laneReporting('remapped-id', {
          structuredOutput: { answer: 'ok' },
          providerSignals: { windows: [{ id: 'rolling', utilization: 0.5 }] },
        }),
        { lane: 'ai-sdk' },
      ).run(requested('requested-id'));
      expect(mismatch.stopReason).toBe('error');
      expect(mismatch.errorClass).toBe('served-model-mismatch');
      expect(mismatch.model).toBe('remapped-id'); // the raw observation is evidence
      expect(mismatch.usage).toEqual({ input: 3, output: 4, cacheRead: 0, cacheWrite: 0 });
      expect(mismatch.providerSignals).toBeDefined();
      expect(mismatch.structuredOutput).toBeUndefined();
      // 2. A LANE-SCOPED ALIAS → complete: the declared remap admits the
      // served spelling on THAT lane only.
      const aliasPolicy: ServedModelPolicy = {
        aliases: { acp: { wire: { requested: ['remapped-id'] } } },
      };
      const aliased = await withServedModelAssertion(laneReporting('remapped-id'), {
        lane: 'acp',
        policy: aliasPolicy,
      }).run(requested('requested'));
      expect(aliased.stopReason).toBe('complete');
      // 3. THE SAME ALIAS DECLARED FOR ANOTHER LANE → still mismatch: the
      // admission never crosses lanes.
      const crossLane = await withServedModelAssertion(laneReporting('remapped-id'), {
        lane: 'ai-sdk',
        policy: aliasPolicy,
      }).run(requested('requested'));
      expect(crossLane.stopReason).toBe('error');
      expect(crossLane.errorClass).toBe('served-model-mismatch');
      // 4. UNOBSERVED (no reported id) → error: an eval/caller claiming
      // model identity cannot accept an unattributable run.
      const unobserved = await withServedModelAssertion(laneReporting(undefined), {
        lane: 'ai-sdk',
      }).run(requested('requested-id'));
      expect(unobserved.stopReason).toBe('error');
      expect(unobserved.errorClass).toBe('served-model-mismatch');
      // 5. UNOBSERVED with requireObserved[lane]=false → complete; the pure
      // check records HOW it passed ('unobserved-allowed') — the record the
      // wrapper's decision is made from.
      const allowUnobserved: ServedModelPolicy = { requireObserved: { acp: false } };
      const permitted = withServedModelAssertion(laneReporting(undefined), {
        lane: 'acp',
        policy: allowUnobserved,
      });
      const unobservedAllowed = await permitted.run(requested('requested-id'));
      expect(unobservedAllowed.stopReason).toBe('complete');
      expect(
        servedModelCheck(requested('requested-id'), unobservedAllowed, {
          lane: 'acp',
          policy: allowUnobserved,
        }),
      ).toEqual({ pass: true, via: 'unobserved-allowed' });
      // 6. an OBSERVED mismatch under requireObserved=false is STILL an
      // error: the policy admits absence, never a different model.
      const stillMismatch = await withServedModelAssertion(laneReporting('remapped-id'), {
        lane: 'acp',
        policy: allowUnobserved,
      }).run(requested('requested-id'));
      expect(stillMismatch.stopReason).toBe('error');
      expect(stillMismatch.errorClass).toBe('served-model-mismatch');
      // 7. THE ACP NORMALISER (§2.6): the wire's `builtin:bigmodel\GLM-5.3`
      // spelling equals a requested 'glm-5.3' after ONE namespace strip +
      // case-fold — and never a requested 'glm-5.3-flash'.
      const acpServed = 'builtin:bigmodel\\GLM-5.3';
      expect(normaliseModelId('acp', acpServed)).toBe('glm-5.3');
      const normalises = servedModelCheck(
        requested('glm-5.3'),
        { ...completeWorkerResult(), model: acpServed },
        { lane: 'acp' },
      );
      expect(normalises.pass).toBe(true);
      const remap = servedModelCheck(
        requested('glm-5.3-flash'),
        { ...completeWorkerResult(), model: acpServed },
        { lane: 'acp' },
      );
      expect(remap.pass).toBe(false);
    });

    test('v. SEAM_VERSION is 2 on the seam barrel (the conformance suite pins the frozen seam version)', () => {
      expect(SEAM_VERSION).toBe(2);
    });

    test('b-iii. RunOptions.signal: PRE-aborted never dispatches; fired mid-run settles aborted', async () => {
      await withScratch(async (scratchDir) => {
        // Half 1 — ALREADY aborted at entry: the driver must never dispatch.
        // The scripted model MUST NOT have run; the observable verdict is
        // the zero-usage 'aborted' with NO sessionId (no record was created
        // for a run that never dispatched).
        const preAborted = makeDriver({
          directive: { kind: 'reply', text: 'must never run' },
          scratchDir,
        });
        const dead = new AbortController();
        dead.abort();
        const result = await preAborted.run(conformanceInvocation(), { signal: dead.signal });
        expect(result.stopReason).toBe('aborted');
        expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
        expect(result.denials).toEqual([]);
        expect(result.sessionId).toBeUndefined();
        // Half 2 — fired MID-RUN: a plain AbortController, NO runLadder (the
        // governed ambient context is gone in seam v2 — RunOptions.signal is
        // the ONLY cancellation channel). The delay lands after every lane's
        // abort wiring is live; wherever it lands, the run settles the
        // honest 'aborted' verdict.
        const midRun = makeDriver({ directive: { kind: 'block-until-abort' }, scratchDir });
        const live = new AbortController();
        setTimeout(() => live.abort(), 100);
        const aborted = await midRun.run(conformanceInvocation(), { signal: live.signal });
        expect(aborted.stopReason).toBe('aborted');
        expect(aborted.error).toBeUndefined(); // the cancellation is not a failure
      });
    });

    test('f-iii. workspace binding: the tool write lands in workspace.path; the record (in sessionsDir) records its realpath', async () => {
      await withScratch(async (scratchDir) => {
        const workspaceDir = join(scratchDir, 'ws');
        await mkdir(workspaceDir);
        const driver = makeDriver({
          directive: {
            kind: 'tool-then-reply',
            tool: 'run',
            toolIdentity: 'run',
            input: { command: 'echo conformance-marker > note.txt' },
            reply: 'wrote note.txt',
          },
          scratchDir,
        });
        const result = await driver.run(
          conformanceInvocation({ workspace: { path: workspaceDir } }),
        );
        expect(result.stopReason).toBe('complete');
        // The write really executed INSIDE the bound workspace (cwd and path
        // confinement bind to realpath(workspace.path) — never prompt text).
        expect(await readFile(join(workspaceDir, 'note.txt'), 'utf8')).toContain(
          'conformance-marker',
        );
        // The fresh record was created in the LANE's sessionsDir and records
        // the bound REALPATH as its workspace (symlinks resolved BEFORE
        // storing).
        const record = await new SessionStore(join(scratchDir, SESSIONS_DIR)).load(
          result.sessionId as string,
        );
        expect(record?.workspace).toBe(await realpath(workspaceDir));
      });
    });

    test('f-iv. workspace + sessionRef naming a DIFFERENT workspace: the run THROWS pre-dispatch with errorClass config', async () => {
      await withScratch(async (scratchDir) => {
        const workspaceDir = join(scratchDir, 'ws');
        const otherDir = join(scratchDir, 'other');
        await mkdir(workspaceDir);
        await mkdir(otherDir);
        // Establish a session bound to workspaceDir.
        const first = makeDriver({ directive: { kind: 'reply', text: 'ok' }, scratchDir });
        const run1 = await first.run(conformanceInvocation({ workspace: { path: workspaceDir } }));
        expect(run1.stopReason).toBe('complete');
        if (run1.sessionId === undefined) throw new Error('first run must create a session');
        // The SAME session pointed at a DIFFERENT workspace: a caller bug —
        // a PRE-DISPATCH throw (before any dispatch), classed 'config'.
        const second = makeDriver({ directive: { kind: 'reply', text: 'ok' }, scratchDir });
        let thrown: unknown;
        try {
          await second.run(
            conformanceInvocation({ workspace: { path: otherDir }, sessionRef: run1.sessionId }),
          );
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeDefined();
        expect(errorClassOf(thrown)).toBe('config');
      });
    });
  });
}

/** A minimal complete WorkerResult for the pure served-model-check legs. */
function completeWorkerResult(): WorkerResult {
  return {
    stopReason: 'complete',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    denials: [],
  };
}
