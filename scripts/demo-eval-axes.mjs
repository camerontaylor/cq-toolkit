#!/usr/bin/env node
// Eval-axes demo + DD-2 cross-lane USD normalization — T1.6 slice 4.
//
// Runs the SAME tiny deterministic fixture prompt on five LIVE cells and
// prints one markdown table row per cell (usage + token-derived costUSD +
// stopReason):
//
//   axis 1 — model × ai-sdk lane:   { zai/glm-4.6, deepseek/deepseek-flash }
//   axis 2 — glm-4.6 × lane:        { ai-sdk, claude-agent, subprocess }
//   axis 3 — the acp lane:          { zai/glm-5.3-flash (the served id) }
//
// (the ai-sdk × glm cell belongs to the first two axes; the acp cell
// COMPLETES the four-wide lane axis {ai-sdk, claude-agent, subprocess,
// acp} — five unique runs). The glm × ai-sdk cell rides the GLM Coding
// Plan's OpenAI-COMPATIBLE endpoint — the ai-sdk driver's zai provider
// defaults to it (owner-verified 2026-09-14: /api/paas/v4 is the
// pay-as-you-go wire, unfunded by design; /api/coding/paas/v4 is the
// plan-funded OpenAI-compat wire) — see makeDriver and
// docs/eval-axes-demo.md.
//
// THE ACP CELL (T1.8; conductor decision 2026-09-14 — eval wires REQUEST
// the model id the wire ACTUALLY serves): this lane's wire is the vendor
// harness `zcode-acp-server` (JSON-RPC over stdio, AcpDriver), whose
// served GLM is glm-5.3-flash — reported by the harness under its own
// `providerId\modelId` encoding, materialized as `builtin:bigmodel\GLM-5.3`
// (probe-recorded 2026-09-15, strategy §5). The cell requests
// glm-5.3-flash and pre-declares that served id (expectedServed); the
// identity guard demands the OBSERVED model equal it EXACTLY — any other
// id is a remap and fails the cell, exactly the other lanes' guard. The
// driver owns the mode pin (set_config_option mode=build before any
// prompt) and the binary resolution; auth is agent-side (the app's own
// credentials — no key env from this script); the cell's SPEND rides the
// vendor harness (the DD-2 discount record lives in
// docs/dd-2-usd-normalization.md).
//
// SPEND BOUNDS — what actually bounds a live run here (round-1 review
// wording): each cell is dispatched through the kernel's escalation ladder
// (runLadder, wallClockMs 120_000 — the governor owns WHEN to abort), the
// fixture prompt is tiny, toolPolicy is 'none', and retries are capped at
// MAX_ATTEMPTS per cell with NO new paid call after a cell produced a
// completed result. `Budget.maxUsd 2` (every cell) / `maxTokens 2000` (raw
// lanes; 200_000 on the acp cell — see ACP_BUDGET) ride the
// invocation as caller-side derived accounting — the drivers derive cost
// AFTER usage; maxUsd is NOT a runtime kill switch — it is what a caller
// (or governor) compares the derived figure against, so this script states
// it as the declared ceiling, not the enforcement mechanism.
//
// The claude lanes route through Z.AI's anthropic-compat
// endpoint via the drivers' own env routing (base URL +
// ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY injected from the ZAI key var);
// the STALE host ANTHROPIC_API_KEY is neutralized (empty string) first.
//
// SECRETS: key material is read from the environment and NEVER printed or
// persisted — the login shell exports Z_AI_API_KEY (mapped onto the routes'
// ZAI_API_KEY name in-process, silently) and DEEPSEEK_API_KEY. The costUSD
// column is DERIVED from usage through the vendored price map
// (src/driver/pricing/data.ts, models.dev as-of 2026-09) — the modeled,
// api-equivalent figure (DD-9), never a billing statement; the script also
// recomputes the fold independently and asserts the two agree (tolerance
// 1e-9 USD) before printing the row.
//
// Standalone by design — never runs in `npm test` (CI has no keys, no
// network). EXIT CODE: 0 only when every selected cell passed (identity,
// fixture, and fold checks green); any failed cell sets exit 1. Usage:
// zsh -lic 'node scripts/demo-eval-axes.mjs'
import { AcpDriver, AiSdkDriver, ClaudeAgentDriver, SessionStore, SubprocessDriver, runLadder } from '../dist/index.js';
import { priceOf } from '../dist/driver/pricing/index.js';
import dns from 'node:dns';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { EVAL_AXES_PROVIDER_KEYS, requiredKeys, selectCells } from './lib/eval-axes-select.mjs';

// HOST NETWORK QUIRK (found live, 2026-09-14): this host's IPv6 route to
// api.z.ai hangs (node fetch → ETIMEDOUT) while the IPv4 path works (curl
// and the agent CLI survive via happy-eyeballs/IPv4). This demo OWNS its
// process, so pin node's connect defaults to IPv4-first with family
// autoselection off — verified live: default → ETIMEDOUT, this pin → 200.
// (A library must never set process-global network policy; the driver and
// kernel stay untouched.)
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamily(false);

// --- Environment hygiene (silent) -------------------------------------------
process.env.ANTHROPIC_API_KEY = ''; // the stale, invalid host key — never used
// The source-guarded mapping: assigning `undefined` (an absent Z_AI_API_KEY)
// to process.env COERCES to the 9-char string "undefined", which would forge
// a non-empty ZAI_API_KEY out of nothing and defeat the credential gate.
if ((process.env.ZAI_API_KEY ?? '') === '' && (process.env.Z_AI_API_KEY ?? '') !== '') {
  process.env.ZAI_API_KEY = process.env.Z_AI_API_KEY; // route name mapping, never printed
}
// The acp lane's harness (zcode-acp-server) spawns the vendor CLI itself;
// when `zcode` is not on PATH the ZCODE_BIN env var names the desktop-app
// CLI (caller's env wins, set silently). The app-bundle fallback is DARWIN-
// ONLY — the path is a macOS app container and must never be handed to
// another platform's child: elsewhere the harness resolves `zcode` from
// PATH (or the caller exports ZCODE_BIN explicitly).
if ((process.env.ZCODE_BIN ?? '') === '' && process.platform === 'darwin') {
  process.env.ZCODE_BIN = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
}

// --- The fixture (identical across every cell) --------------------------------
const PROMPT = 'Reply with exactly this text and nothing else: The quick brown fox jumps over the lazy dog.';
// The zai coding wire SERVES `glm-5.3-flash` for a `glm-4.6` request
// (observed live — see the eval history) — the conductor decision: eval
// wires request the id the wire actually serves. The anthropic-compat
// lanes (claude-agent/subprocess) serve glm-4.6 truthfully, so their
// cells keep glm-4.6.
const MODEL_GLM = 'glm-5.3-flash';
// The deepseek wire SERVES `deepseek-flash` for a `deepseek-chat` request
// (observed live, docs/eval-axes-demo.md history) — the conductor decision:
// eval wires request the id the wire actually serves, so the identity check
// compares like with like and the served id is the honest axis label.
const MODEL_DEEPSEEK = 'deepseek-flash';
// The acp cell's request — the SERVED model id per the conductor decision —
// and the wire's own encoding of it, verbatim from the live probe
// (materialized config_option_update; the lazy session/new default is
// `builtin:zai\GLM-5.3` and is never surfaced by the driver).
const MODEL_GLM_SERVED = 'glm-5.3-flash';
const ACP_SERVED_ID = 'builtin:bigmodel\\GLM-5.3';
const BUDGET = { maxUsd: 2, maxTokens: 2000 };
// The acp cell's own token ceiling: the vendor harness's FIXED scaffolding
// alone materialized {input 15_719, cachedRead 11_648} tokens on the probe's
// tiny prompt (OQ-3, 2026-09-15) — the raw-chat-sized 2k cap would
// post-hoc-classify every honest acp run 'budget'. maxUsd stays the declared
// 2; the cap is a post-hoc classification threshold, never a stop.
const ACP_BUDGET = { maxUsd: 2, maxTokens: 200_000 };
const POLICY = { allow: [], mode: 'none' };
const SANDBOX = { level: 'none' };

const invocationFor = (provider, model, budget = BUDGET) => ({
  prompt: PROMPT,
  modelSpec: { provider, model },
  toolPolicy: POLICY,
  sandboxPolicy: SANDBOX,
  budget,
});

/** Independent recompute of the DD-2 derived-cost fold (must equal the driver's). */
function recomputeCost(modelSpec, usage) {
  const rates = priceOf(modelSpec);
  if (rates === undefined) return undefined;
  const perMillion = (tokens, rate) => (rate === undefined ? 0 : (tokens / 1_000_000) * rate);
  return (
    perMillion(usage.input, rates.input) +
    perMillion(usage.output, rates.output) +
    perMillion(usage.cacheRead, rates.cacheRead) +
    perMillion(usage.cacheWrite, rates.cacheWrite)
  );
}

async function makeDriver(lane, provider, scratchDir) {
  const sessionsDir = join(scratchDir, `sessions-${lane}`);
  if (lane === 'ai-sdk') {
    // The standard zai provider construction (defaultProviders) now carries
    // the GLM Coding Plan's OpenAI-compatible endpoint as its DEFAULT base
    // URL (owner-verified 2026-09-14 — the plan-funded wire; the
    // pay-as-you-go /api/paas/v4 rejects the plan key with 429 by design).
    // The script leaves ZAI_BASE_URL unset so that default applies.
    return new AiSdkDriver({ sessionsDir });
  }
  if (lane === 'claude-agent') return new ClaudeAgentDriver({ sessionsDir });
  if (lane === 'subprocess') return new SubprocessDriver({ sessionsDir });
  if (lane === 'acp') {
    // The mode pin (session/set_config_option mode=build before ANY prompt —
    // sessions open in `yolo`, which never asks) and the binary resolution
    // (zcode-acp-server via PATH — the operator's global install) are the
    // DRIVER's own job; this script configures neither. modelEnv makes the
    // requested model a REAL request on the vendor's own channel (the
    // driver's documented REQUEST transport) — the served id remains what
    // the identity guard verifies.
    return new AcpDriver({ sessionsDir, modelEnv: 'ZCODE_MODEL' });
  }
  throw new Error(`unknown lane ${lane}`);
}

const u = (n) => (n === undefined ? '—' : String(n));
const usd = (n) => (n === undefined ? 'absent' : `$${n.toFixed(8)}`);

const MAX_ATTEMPTS = 2; // the live-retry budget per cell (spend discipline)
// The governed wall clock per cell attempt — generous against the observed
// per-cell latencies (~1–6 s), tight enough that a hung lane escalates
// through the ladder instead of holding the demo forever.
const WALL_CLOCK_MS = 120_000;
const FIXTURE_PHRASE = 'quick brown fox'; // the fixture's distinctive text

async function runCell({ lane, provider, model, expectedServed, budget }) {
  const scratchDir = await mkdtemp(join(tmpdir(), 'eval-axes-'));
  const attempts = [];
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const driver = await makeDriver(lane, provider, scratchDir);
      const startedAt = Date.now();
      try {
        // GOVERNED DISPATCH (the kernel's own channel): every live call runs
        // inside runLadder so the escalation ladder owns WHEN to abort — the
        // driver only obeys. A governed outcome other than 'completed' (or a
        // verdict that is not a pass, below) is recorded as evidence; the
        // retry loop NEVER issues another paid call once a cell produced a
        // completed result.
        const ladderOutcome = await runLadder(
          () => driver.run(invocationFor(provider, model, budget)),
          { wallClockMs: WALL_CLOCK_MS },
          { op: 'eval-axes', jobKey: `eval-axes/${lane}/${model}`, attempt },
        );
        const elapsedMs = Date.now() - startedAt;
        if (ladderOutcome.outcome !== 'completed') {
          attempts.push({ attempt, governedOutcome: ladderOutcome.outcome });
          continue;
        }
        const result = ladderOutcome.value;
        // The independent recompute prices the model that was actually
        // SERVED (the driver prices the served id too — the remap evidence
        // is real); the requested id is only the fallback when nothing was
        // observed. Otherwise a remapped cell would print fold disagreement
        // for a CORRECT fold.
        const pricedModel = result.model ?? model;
        const recomputed = recomputeCost({ provider, model: pricedModel }, result.usage);
        // Fixture validation (the acceptance bar for a PASS): the verdict
        // must be stopReason 'complete' — a 'budget' or 'error' stopReason
        // records the cell as failed-with-evidence — AND the assistant
        // transcript must carry the fixture's distinctive phrase (the model
        // actually answered the fixture, not something else).
        if (result.stopReason !== 'complete') {
          attempts.push({ attempt, stopReason: result.stopReason, usage: result.usage });
          continue;
        }
        const store = new SessionStore(join(scratchDir, `sessions-${lane}`));
        const record = await store.load(result.sessionId);
        const assistantText = (record?.messages ?? [])
          .filter((m) => m.role === 'assistant')
          .map((m) => m.content)
          .join('\n')
          .toLowerCase();
        if (!assistantText.includes(FIXTURE_PHRASE)) {
          attempts.push({
            attempt,
            stopReason: result.stopReason,
            fixtureResponseInvalid: `assistant transcript lacks '${FIXTURE_PHRASE}'`,
            transcriptChars: assistantText.length,
          });
          continue;
        }
        // The DD-2 fold check runs BEFORE the identity rejections: a remap
        // corrupts exactly the cost datum, so the mismatch evidence must
        // carry the fold ("the wrong model would have cost X at its real
        // rates vs Y at the requested model's rates"), not discard it.
        // Tolerance 1e-9 USD (float reassociation only).
        const foldAgrees =
          recomputed === undefined
            ? result.costUSD === undefined
            : Math.abs((result.costUSD ?? Number.NaN) - recomputed) <= 1e-9;
        // The eval axes claim MODEL IDENTITY: a completed verdict with NO
        // observed model id cannot be attributed to any model — failed with
        // evidence, and NO retry (an unreported id is not transient).
        if (typeof result.model !== 'string' || result.model === '') {
          attempts.push({
            attempt,
            stopReason: result.stopReason,
            servedModelUnreported:
              'the verdict carries no observed model id — an eval claiming model identity cannot accept it',
          });
          break;
        }
        // A served id that differs from the cell's expected id is a remap
        // (deepseek-flash / glm-5.3-flash are exactly why) — the cell fails
        // with evidence, and NO retry: a remap is endpoint configuration, a
        // retry would pay for the same answer. The expected id is the
        // requested model for every raw lane, and the PRE-DECLARED served id
        // for the acp lane (expectedServed — the conductor decision: request
        // the id the wire actually serves; this wire reports glm-5.3-flash
        // under its own `providerId\modelId` encoding, probe-recorded). The
        // fold evidence rides along: usage + what the tokens cost at the
        // SERVED model's real rates vs what they would have cost at the
        // requested model's rates — the DD-2 datum a remap corrupts.
        const expectedId = expectedServed ?? model;
        if (result.model !== expectedId) {
          attempts.push({
            attempt,
            stopReason: result.stopReason,
            servedModelMismatch: {
              requested: model,
              ...(expectedServed !== undefined ? { expectedServed } : {}),
              served: result.model,
              usage: result.usage,
              driverCostUSD: result.costUSD ?? null,
              recomputed,
            },
          });
          break;
        }
        if (!foldAgrees) {
          // A completed cell whose fold disagrees is a broken normalization,
          // not a transient — record the evidence and do NOT issue another
          // paid attempt.
          attempts.push({
            attempt,
            foldDisagreement: { driverCostUSD: result.costUSD ?? null, recomputed },
          });
          break;
        }
        return {
          lane, provider, model, elapsedMs,
          ...(expectedServed !== undefined ? { expectedServed } : {}),
          governedOutcome: ladderOutcome.outcome,
          stopReason: result.stopReason,
          servedModel: result.model ?? 'unreported',
          usage: result.usage,
          costUSD: result.costUSD,
          costBasis: result.costBasis,
          recomputedCostUSD: recomputed,
          foldAgrees,
          sessionId: result.sessionId,
        };
      } catch (err) {
        attempts.push({ attempt, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
      }
    }
    return { lane, provider, model, failed: true, attempts };
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(scratchDir, { recursive: true, force: true });
  }
}

const cells = [
  { lane: 'ai-sdk', provider: 'zai', model: MODEL_GLM },
  { lane: 'ai-sdk', provider: 'deepseek', model: MODEL_DEEPSEEK },
  { lane: 'claude-agent', provider: 'zai', model: MODEL_GLM },
  { lane: 'subprocess', provider: 'zai', model: MODEL_GLM },
  {
    // The four-wide lane axis completes here: the acp lane rides the SERVED
    // id (conductor decision) with the probe-recorded wire encoding as the
    // expected served id, and its own token ceiling (ACP_BUDGET — the
    // harness's fixed scaffolding dwarfs the raw-chat 2k cap).
    lane: 'acp', provider: 'zai', model: MODEL_GLM_SERVED,
    expectedServed: ACP_SERVED_ID, budget: ACP_BUDGET,
  },
];

// `--only <substring>` selection and the credential gate live in
// scripts/lib/eval-axes-select.mjs (no dist dependency) so the vitest
// suite can cover them directly; this script only wires them together.
let selected;
try {
  selected = selectCells(cells, process.argv);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const { missing, unmapped } = requiredKeys(selected, EVAL_AXES_PROVIDER_KEYS, process.env);
if (unmapped !== null) {
  console.error(`demo-eval-axes: no credential mapping for provider '${unmapped}' — refusing to run`);
  process.exit(1);
}
if (missing.length > 0) {
  console.error(`demo-eval-axes: missing key env var(s) for the selected cells: ${missing.join(', ')} — refusing to run`);
  process.exit(1);
}

const results = [];
for (const cell of selected) {
  process.stderr.write(`running cell ${cell.lane} × ${cell.provider}/${cell.model} …\n`);
  results.push({ ...cell, ...(await runCell(cell)) });
}
// A failed cell fails the RUN: the exit code carries the verdict so any
// caller (CI, a wrapper) cannot mistake red evidence for a green demo.
if (results.some((r) => r.failed === true)) {
  process.exitCode = 1;
}

// --- Markdown output -----------------------------------------------------------
console.log('| lane | provider | model | served model | stopReason | input | output | cacheRead | cacheWrite | costUSD (modeled) | fold agrees |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of results) {
  if (r.failed) {
    const last = r.attempts[r.attempts.length - 1] ?? {};
    console.log(`| ${r.lane} | ${r.provider} | ${r.model} | — | FAILED after ${r.attempts.length} attempts | — | — | — | — | absent | — |`);
    console.log(`> cell ${r.lane}/${r.model} failure evidence: ${JSON.stringify(last)}`);
    continue;
  }
  console.log(
    `| ${r.lane} | ${r.provider} | ${r.model} | ${r.servedModel} | ${r.stopReason} | ${u(r.usage.input)} | ${u(r.usage.output)} | ${u(r.usage.cacheRead)} | ${u(r.usage.cacheWrite)} | ${usd(r.costUSD)} | ${r.foldAgrees ? 'yes' : 'NO'} |`,
  );
}
console.log('\n--- raw JSON (for the docs) ---');
console.log(JSON.stringify(results, null, 2));
