#!/usr/bin/env node
// Eval-axes demo + DD-2 cross-lane USD normalization — T1.6 slice 4.
//
// Runs the SAME tiny deterministic fixture prompt on four LIVE cells and
// prints one markdown table row per cell (usage + token-derived costUSD +
// stopReason):
//
//   axis 1 — model × ai-sdk lane:   { zai/glm-4.6, deepseek/deepseek-chat }
//   axis 2 — glm-4.6 × lane:        { ai-sdk, claude-agent, subprocess }
//
// (the ai-sdk × glm cell belongs to both axes — four unique runs). The glm
// × ai-sdk cell rides the GLM Coding Plan's OpenAI-COMPATIBLE endpoint —
// the ai-sdk driver's zai provider defaults to it (owner-verified
// 2026-09-14: /api/paas/v4 is the pay-as-you-go wire, unfunded by design;
// /api/coding/paas/v4 is the plan-funded OpenAI-compat wire) — see
// makeDriver and docs/eval-axes-demo.md.
//
// SPEND BOUNDS — what actually bounds a live run here (round-1 review
// wording): each cell is dispatched through the kernel's escalation ladder
// (runLadder, wallClockMs 120_000 — the governor owns WHEN to abort), the
// fixture prompt is tiny, toolPolicy is 'none', and retries are capped at
// MAX_ATTEMPTS per cell with NO new paid call after a cell produced a
// completed result. `Budget.maxUsd 2` / `maxTokens 2000` ride the
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
// network). Usage: zsh -lic 'node scripts/demo-eval-axes.mjs'
import { AiSdkDriver, ClaudeAgentDriver, SessionStore, SubprocessDriver, runLadder } from '../dist/index.js';
import { priceOf } from '../dist/driver/pricing/index.js';
import dns from 'node:dns';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';

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
if ((process.env.ZAI_API_KEY ?? '') === '') {
  process.env.ZAI_API_KEY = process.env.Z_AI_API_KEY; // route name mapping, never printed
}
const missing = ['ZAI_API_KEY', 'DEEPSEEK_API_KEY'].filter((k) => (process.env[k] ?? '') === '');
if (missing.length > 0) {
  console.error(`demo-eval-axes: missing key env var(s): ${missing.join(', ')} — refusing to run`);
  process.exit(1);
}

// --- The fixture (identical across every cell) --------------------------------
const PROMPT = 'Reply with exactly this text and nothing else: The quick brown fox jumps over the lazy dog.';
const MODEL_GLM = 'glm-4.6';
const MODEL_DEEPSEEK = 'deepseek-chat';
const BUDGET = { maxUsd: 2, maxTokens: 2000 };
const POLICY = { allow: [], mode: 'none' };
const SANDBOX = { level: 'none' };

const invocationFor = (provider, model) => ({
  prompt: PROMPT,
  modelSpec: { provider, model },
  toolPolicy: POLICY,
  sandboxPolicy: SANDBOX,
  budget: BUDGET,
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

async function runCell({ lane, provider, model }) {
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
          () => driver.run(invocationFor(provider, model)),
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
        // The eval axes claim MODEL IDENTITY: a served id that differs from
        // the cell's configured model id is a remap (deepseek-flash is
        // exactly why) — the cell fails with evidence, and NO retry: a remap
        // is endpoint configuration, a retry would pay for the same answer.
        if (typeof result.model === 'string' && result.model !== model) {
          attempts.push({
            attempt,
            stopReason: result.stopReason,
            servedModelMismatch: { requested: model, served: result.model },
          });
          break;
        }
        // The DD-2 fold check: derived-only means the SAME math must give
        // the SAME number. Tolerance 1e-9 USD (float reassociation only).
        const foldAgrees =
          recomputed === undefined
            ? result.costUSD === undefined
            : Math.abs((result.costUSD ?? Number.NaN) - recomputed) <= 1e-9;
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
];

// `--only <substring>` runs just the matching cells (e.g. the single-cell
// compat-wire retry of glm × ai-sdk) — spend discipline for targeted reruns.
// A missing value, or a value matching NO cell, is a loud usage error —
// never a silent full run.
function selectCells() {
  const onlyIndex = process.argv.indexOf('--only');
  if (onlyIndex === -1) return cells;
  const only = process.argv[onlyIndex + 1];
  const valid = cells.map((c) => `${c.lane}/${c.model}`);
  if (only === undefined || !cells.some((c) => `${c.lane}/${c.model}`.includes(only))) {
    console.error(
      `demo-eval-axes: ${only === undefined ? '--only requires a value' : `no cell matches '${only}'`} — valid cells: ${valid.join(', ')}`,
    );
    process.exit(1);
  }
  return cells.filter((c) => `${c.lane}/${c.model}`.includes(only));
}

const selected = selectCells();

const results = [];
for (const cell of selected) {
  process.stderr.write(`running cell ${cell.lane} × ${cell.provider}/${cell.model} …\n`);
  results.push({ ...cell, ...(await runCell(cell)) });
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
