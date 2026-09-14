// THE driver-conformance suite — T1.4 slice 3.
//
// Shared, parameterized behavioral contract for EVERY first-party driver on
// the frozen seam (ai-sdk today; the T1.5/T1.6 drivers reuse it verbatim by
// calling `runDriverConformance` with their own `makeDriver`). Deliberately
// driver-agnostic: the suite touches ONLY the frozen `Driver` interface,
// the harness `SessionStore` (the I6 record format every driver shares), the
// kernel's strict `WorkerResultSchema` mirror, and the governor's
// `runLadder` (the I8 governed-context mechanics). No vendor types, no
// driver internals.
//
// THE MAKE-DRIVER CONTRACT (what a conforming `makeDriver` must honor):
//   - `spec.scratchDir` — a suite-created temp directory. The driver's
//     session store MUST live at `<scratchDir>/sessions` (SESSIONS_DIR) and
//     its scratch workspaces SHOULD live under `<scratchDir>`, so the suite
//     can inspect records with harness SessionStore and clean everything up.
//   - `spec.outputSchema` — when present, the driver is CONSTRUCTED with
//     this structured-output schema; a run then carries the parsed value in
//     `WorkerResult.structuredOutput`.
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
//                                                    the governed signal
//                                                    fires, then rejects
//                                                    (the abort test);
//       { kind: 'fail' }                           — the model fails with a
//                                                    plain non-abort error
//                                                    (the error-verdict
//                                                    test).
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
//     `pricing` option), so the derived-cost test asserts a real costUSD.
//     The canonical conformance model is NEVER priced.
//   - I8: run() honors the governed `currentJobContext()` signal — the
//     abort test wraps a run in `runLadder`, fires the signal mid-run, and
//     requires stopReason 'aborted'. The scripted model blocks until the
//     signal fires.
//   - The driver MUST surface the served model id in `WorkerResult.model`
//     on a completed run (the observed-model check, leg m, binds all
//     lanes: the RESPONSE-reported id, present and equal to the requested
//     `ModelSpec.model`).
//
// Each test builds a FRESH driver via makeDriver (no state shared between
// tests) in a fresh temp scratch dir, removed in a finally block.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import type { Driver, OpInvocation, WorkerResult } from '../../src/driver/types.js';
import { WorkerResultSchema } from '../../src/kernel/schema.js';
import { SessionStore } from '../../src/harness/session.js';
import { runLadder } from '../../src/kernel/governor.js';

// ---------------------------------------------------------------------------
// The make-driver contract (public so driver implementations can type against it)
// ---------------------------------------------------------------------------

/** Scripts the model's behavior for one driver instance — OUR vocabulary, not vendor shapes. */
export type ModelDirective =
  | { kind: 'reply'; text: string }
  | { kind: 'tool-then-reply'; tool: string; input: unknown; reply: string }
  // The model BLOCKS until the governed signal fires, then rejects — the
  // script behind the I8 abort test (makeDriver wires the driver's abort
  // seam; the mock honors it).
  | { kind: 'block-until-abort' }
  // The model FAILS outright (a plain non-abort error) — the script behind
  // the error-verdict test: the driver must RETURN stopReason 'error', never
  // throw past the seam.
  | { kind: 'fail' };

/** Per-driver construction hints the suite hands to `makeDriver`. */
export interface ConformanceSpec {
  /** Build the driver with this structured-output schema (structured-output test). */
  outputSchema?: z.ZodType;
  /** Script the model's behavior for this driver's runs. */
  directive?: ModelDirective;
  /**
   * A ModelSpec the driver's PRICE MAP knows: makeDriver must resolve this
   * handle onto its scripted model THROUGH its pricing, so the derived-cost
   * test can assert costUSD is a real number. (The canonical conformance
   * model is by contract NEVER priced — the absent-costUSD assertion needs
   * an unknown model to catch fabricating drivers.)
   */
  pricedModel?: { provider: string; model: string };
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

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

/**
 * Register the conformance describe block for one driver. Call from a test
 * file (vitest collects the tests); every test constructs a fresh driver in
 * a fresh scratch dir.
 */
export function runDriverConformance(
  makeDriver: ConformanceMakeDriver,
  opts?: { label?: string },
): void {
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

  /** The canonical conformance invocation; only the pieces a test names differ. */
  function invocation(overrides: Partial<OpInvocation> = {}): OpInvocation {
    return {
      prompt: 'conformance run',
      modelSpec: { provider: CONFORMANCE_PROVIDER, model: CONFORMANCE_MODEL },
      toolPolicy: { allow: [], mode: 'unrestricted' },
      sandboxPolicy: { level: 'workspace-write' },
      budget: {},
      ...overrides,
    };
  }

  describe(`driver conformance: ${label}`, () => {
    test('a. structured-output round-trip: parsed, plain JSON, schema-valid, stable under re-parse', async () => {
      await withScratch(async (scratchDir) => {
        const schema = z.object({ answer: z.string() }).strict();
        const driver = makeDriver({
          outputSchema: schema,
          directive: { kind: 'reply', text: '{"answer":"ok"}' },
          scratchDir,
        });
        const result = await driver.run(invocation({ prompt: 'produce structured output' }));
        expect(result.structuredOutput).toBeDefined();
        const once = JSON.parse(JSON.stringify(result.structuredOutput)) as unknown;
        // stringify → parse → revalidate → deep-equal: plain JSON in, schema-valid, no drift.
        const reparsed = schema.parse(JSON.parse(JSON.stringify(once)));
        expect(reparsed).toEqual({ answer: 'ok' });
        expect(once).toEqual(reparsed);
      });
    });

    test('b-i. budget: maxTokens trips stopReason budget with usage present', async () => {
      await withScratch(async (scratchDir) => {
        const driver = makeDriver({
          directive: { kind: 'reply', text: 'this reply is never the point' },
          scratchDir,
        });
        const result = await driver.run(invocation({ budget: { maxTokens: 1 } }));
        expect(result.stopReason).toBe('budget');
        expect(typeof result.usage.input).toBe('number');
        expect(typeof result.usage.output).toBe('number');
      });
    });

    test('b-ii. abort: governed signal fired mid-run settles stopReason aborted', async () => {
      await withScratch(async (scratchDir) => {
        const driver = makeDriver({
          directive: { kind: 'block-until-abort' },
          scratchDir,
        });
        // The governor's own channel mechanics: runLadder installs the job
        // context and fires its signal at wallClockMs; a conforming driver
        // obeys the signal and settles 'aborted' (I8 — the driver decides
        // nothing about WHEN).
        const outcome = await runLadder(
          () => driver.run(invocation()),
          { wallClockMs: 25 },
          { op: 'conformance', jobKey: 'conformance', attempt: 1 },
        );
        expect(outcome.outcome).toBe('completed');
        if (outcome.outcome !== 'completed') return; // narrow for TS
        expect(outcome.value.stopReason).toBe('aborted');
      });
    });

    test('c. denial reporting: denials non-empty, exactly the frozen {tool, reason} shape', async () => {
      await withScratch(async (scratchDir) => {
        const driver = makeDriver({
          directive: {
            kind: 'tool-then-reply',
            tool: 'edit',
            input: { path: 'x.txt', oldText: 'a', newText: 'b' },
            reply: 'noted the refusal',
          },
          scratchDir,
        });
        // read-only sandbox: edit MUST deny (documented harness mapping);
        // the denial flows into WorkerResult.denials in the frozen shape.
        const result = await driver.run(invocation({ sandboxPolicy: { level: 'read-only' } }));
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
        const result = await driver.run(invocation());
        expect(result.stopReason).toBe('complete');
        expect(typeof result.usage.input).toBe('number');
        expect(typeof result.usage.output).toBe('number');
        expect(typeof result.usage.cacheRead).toBe('number');
        expect(typeof result.usage.cacheWrite).toBe('number');
        expect(Number.isNaN(result.usage.input)).toBe(false);
        expect(Number.isNaN(result.usage.output)).toBe(false);
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
            input: { path: 'missing.txt' },
            reply: 'done anyway',
          },
          scratchDir,
        });
        const result = await driver.run(invocation());
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
            input: { command: 'echo conformance-marker > note.txt' },
            reply: 'wrote note.txt',
          },
          scratchDir,
        });
        const run1 = await driver1.run(invocation({ prompt: 'isolation run one' }));
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
            input: { path: 'note.txt' },
            reply: 'fresh workspace',
          },
          scratchDir,
        });
        const run2 = await driver2.run(invocation({ prompt: 'isolation run two' }));
        expect(run2.sessionId).not.toBe(run1.sessionId);
        const record2 = await store.load(run2.sessionId as string);
        expect(record2).toBeDefined();
        expect(record2?.workspace).not.toBe(workspace1);
        // Run 1's file is NOT in run 2's workspace: the read is denied.
        expect(
          run2.denials.some((d) => d.tool === 'read' && d.reason.includes('file not found')),
        ).toBe(true);
        // Run 1's prompt and tool message leak nowhere into run 2's record.
        expect(record2?.messages.some((m) => m.role === 'user' && m.content === 'isolation run one')).toBe(false);
        expect(record2?.messages.some((m) => m.role === 'tool' && m.content.includes('echo conformance-marker'))).toBe(false);
      });
    });

    test('f-ii. sessionRef: the recorded session continues — same workspace, same transcript', async () => {
      await withScratch(async (scratchDir) => {
        const store = new SessionStore(join(scratchDir, SESSIONS_DIR));
        const driver1 = makeDriver({
          directive: {
            kind: 'tool-then-reply',
            tool: 'run',
            input: { command: 'echo conformance-marker > note.txt' },
            reply: 'wrote note.txt',
          },
          scratchDir,
        });
        const run1 = await driver1.run(invocation({ prompt: 'resume run one' }));
        const before = await store.load(run1.sessionId as string);
        const workspace1 = before?.workspace as string;
        const lengthBefore = before?.messages.length as number;

        // Run 2 WITH sessionRef: same workspace (the file is still there) and
        // the transcript continues in the SAME record.
        const driver2 = makeDriver({
          directive: {
            kind: 'tool-then-reply',
            tool: 'read',
            input: { path: 'note.txt' },
            reply: 'resumed and read the note',
          },
          scratchDir,
        });
        const run2 = await driver2.run(
          invocation({ prompt: 'resume run two', sessionRef: run1.sessionId }),
        );
        expect(run2.sessionId).toBe(run1.sessionId);
        // No read denial: the resumed workspace still holds run 1's file.
        expect(run2.denials.some((d) => d.tool === 'read')).toBe(false);
        const after = await store.load(run1.sessionId as string);
        expect(after?.workspace).toBe(workspace1);
        expect(after?.messages.length).toBeGreaterThan(lengthBefore);
        // The transcript carries run 1 AND run 2 turns, in order.
        expect(after?.messages.some((m) => m.role === 'user' && m.content === 'resume run one')).toBe(true);
        expect(after?.messages.some((m) => m.role === 'user' && m.content === 'resume run two')).toBe(true);
      });
    });

    test('g. costUSD derived-only: ABSENT for the unpriced conformance model (a fabricating driver fails here)', async () => {
      await withScratch(async (scratchDir) => {
        const driver = makeDriver({
          directive: { kind: 'reply', text: 'ok' },
          scratchDir,
        });
        const result = await driver.run(invocation());
        // The canonical conformance model is by contract NOT in any price
        // map: a driver reporting costUSD for it is fabricating cost.
        expect(result.costUSD).toBeUndefined();
      });
    });

    test('h. costUSD present and finite when the model is priced (derived from real usage)', async () => {
      await withScratch(async (scratchDir) => {
        const pricedModel = { provider: 'conformance-priced', model: 'priced-1' };
        const driver = makeDriver({
          directive: { kind: 'reply', text: 'ok' },
          pricedModel,
          scratchDir,
        });
        const result = await driver.run(
          invocation({ modelSpec: pricedModel, prompt: 'priced run' }),
        );
        expect(result.stopReason).toBe('complete');
        expect(typeof result.costUSD).toBe('number');
        expect(Number.isFinite(result.costUSD as number)).toBe(true);
        expect(result.costUSD as number).toBeGreaterThanOrEqual(0);
      });
    });

    test('i. model failure: the driver RETURNS stopReason error — never throws past the seam', async () => {
      await withScratch(async (scratchDir) => {
        const driver = makeDriver({ directive: { kind: 'fail' }, scratchDir });
        // The run must RESOLVE with an honest error verdict (carrying the
        // seam evidence — usage, denials, sessionId) — a throw here fails
        // the suite.
        const result = await driver.run(invocation());
        expect(result.stopReason).toBe('error');
        expect(result.usage).toBeDefined();
        expect(Array.isArray(result.denials)).toBe(true);
        expect(typeof result.sessionId).toBe('string');
      });
    });

    test('j. ToolPolicy mode none: no tool ever executes (observable via the session record)', async () => {
      await withScratch(async (scratchDir) => {
        const store = new SessionStore(join(scratchDir, SESSIONS_DIR));
        const driver = makeDriver({
          directive: {
            kind: 'tool-then-reply',
            tool: 'run',
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
          invocation({ toolPolicy: { allow: [], mode: 'none' }, budget: { maxTokens: 25 } }),
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
            input: { path: 'absent.txt' },
            reply: 'done',
          },
          scratchDir,
        });
        const allowed = await allowedDriver.run(
          invocation({ toolPolicy: policy, prompt: 'allowlist allowed' }),
        );
        expect(allowed.denials.some((d) => d.tool === 'read')).toBe(true); // executed and refused on the merits
        const allowedRecord = await store.load(allowed.sessionId as string);
        expect(allowedRecord?.messages.some((m) => m.role === 'tool' && m.toolName === 'read')).toBe(true);
        // Disallowed tool: never executes — no tool message for it, and the
        // side effect (the file) never appears. maxTokens bounds the step
        // loop the same way as the none-mode test.
        const deniedDriver = makeDriver({
          directive: {
            kind: 'tool-then-reply',
            tool: 'run',
            input: { command: 'echo allowlist-marker > out-of-policy.txt' },
            reply: 'unused',
          },
          scratchDir,
        });
        const denied = await deniedDriver.run(
          invocation({ toolPolicy: policy, prompt: 'allowlist denied', budget: { maxTokens: 25 } }),
        );
        const deniedRecord = await store.load(denied.sessionId as string);
        expect(deniedRecord?.messages.some((m) => m.role === 'tool' && m.toolName === 'run')).toBe(false);
      });
    });

    test('l. path escape: a read pointing outside the workspace denies at the driver level', async () => {
      await withScratch(async (scratchDir) => {
        const driver = makeDriver({
          directive: {
            kind: 'tool-then-reply',
            tool: 'read',
            input: { path: '../../outside-secret.txt' },
            reply: 'noted',
          },
          scratchDir,
        });
        const result = await driver.run(invocation({ prompt: 'escape attempt' }));
        expect(result.denials.some((d) => d.tool === 'read' && d.reason.includes('path escape'))).toBe(true);
      });
    });

    test('m. observed model: the served model id is present and equals the requested model (the silent-remap defence)', async () => {
      await withScratch(async (scratchDir) => {
        const driver = makeDriver({ directive: { kind: 'reply', text: 'ok' }, scratchDir });
        const result = await driver.run(invocation());
        // A pre-dispatch allowlist cannot catch a server-side remap; only the
        // RESPONSE can. A driver that hides the served id, or serves a
        // different model than requested, fails here — every lane that runs
        // this suite is bound by this check.
        expect(result.model).toBeDefined();
        expect(result.model).toBe(invocation().modelSpec.model);
      });
    });
  });
}
