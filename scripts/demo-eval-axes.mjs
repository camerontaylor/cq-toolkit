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
// (the ai-sdk × glm cell belongs to both axes — four unique runs). The AXIS
// is the driver, not the provider wire: the glm × ai-sdk cell rides the
// anthropic-compat wire (@ai-sdk/anthropic at Z.AI's compat endpoint)
// because the plan key funds only that endpoint — see makeDriver and
// docs/eval-axes-demo.md. Every
// run is capped: Budget.maxUsd 2 + maxTokens 2000, toolPolicy 'none',
// sandbox 'none'. The claude lanes route through Z.AI's anthropic-compat
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
import { AiSdkDriver, ClaudeAgentDriver, SubprocessDriver } from '../dist/index.js';
import { createAnthropic } from '@ai-sdk/anthropic';
import { priceOf } from '../dist/driver/pricing/index.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import https from 'node:https';

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

/**
 * IPv4-pinned fetch for the compat wire (documented in
 * docs/eval-axes-demo.md): on this host, node/undici resolves api.z.ai with
 * IPv6 addresses first and the v6 route HANGS (ETIMEDOUT) — curl and the
 * agent CLI survive via happy-eyeballs/IPv4, plain fetch does not.
 * createAnthropic accepts a custom fetch, so this cell pins family 4 over
 * node:https (POST JSON in, JSON out — the provider's non-streaming shape).
 */
function ipv4Fetch(input, init = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const headers = new Headers(init.headers ?? (typeof input !== 'string' ? input.headers : undefined));
    const req = https.request(
      {
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? 'POST',
        headers: Object.fromEntries(headers.entries()),
        family: 4,
        timeout: 120_000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve(new Response(Buffer.concat(chunks).toString('utf8'), {
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: res.headers,
          }));
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('ipv4Fetch: socket timeout')));
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

async function makeDriver(lane, provider, scratchDir) {
  const sessionsDir = join(scratchDir, `sessions-${lane}`);
  if (lane === 'ai-sdk') {
    if (provider === 'zai') {
      // WIRE SUBSTITUTION (documented in docs/eval-axes-demo.md): the eval
      // AXIS is the DRIVER, not the provider wire. The plan key funds only
      // Z.AI's anthropic-compat endpoint (the OpenAI-compat API rejects it,
      // 429 code 1113), so this cell's `zai` provider handle is resolved
      // through @ai-sdk/anthropic pointed at that endpoint — the driver
      // instance is still AiSdkDriver; only the wire under it changes.
      // Both auth spellings were proven individually against this endpoint
      // (x-api-key via a completion-bearing curl probe; bearer via the CLI's
      // AUTH_TOKEN), but the SDK rejects passing BOTH — use exactly one:
      // apiKey (the x-api-key header). baseURL MUST carry /v1: the SDK
      // appends /messages to it, and Z.AI's gateway answers the missing-
      // /v1 path with an HTTP-200-wrapped {"msg":"404 NOT_FOUND"} envelope
      // (found live — status-only probing hid it). fetch is IPv4-pinned —
      // see ipv4Fetch above.
      return new AiSdkDriver({
        providers: {
          zai: (modelId) =>
            createAnthropic({
              apiKey: process.env.ZAI_API_KEY,
              baseURL: 'https://api.z.ai/api/anthropic/v1',
              fetch: ipv4Fetch,
            }).languageModel(modelId),
        },
        sessionsDir,
      });
    }
    return new AiSdkDriver({ sessionsDir }); // deepseek: native wire
  }
  if (lane === 'claude-agent') return new ClaudeAgentDriver({ sessionsDir });
  if (lane === 'subprocess') return new SubprocessDriver({ sessionsDir });
  throw new Error(`unknown lane ${lane}`);
}

const u = (n) => (n === undefined ? '—' : String(n));
const usd = (n) => (n === undefined ? 'absent' : `$${n.toFixed(8)}`);

const MAX_ATTEMPTS = 2; // the live-retry budget per cell (spend discipline)

async function runCell({ lane, provider, model }) {
  const scratchDir = await mkdtemp(join(tmpdir(), 'eval-axes-'));
  const attempts = [];
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const driver = await makeDriver(lane, provider, scratchDir);
      const startedAt = Date.now();
      try {
        const result = await driver.run(invocationFor(provider, model));
        const elapsedMs = Date.now() - startedAt;
        const recomputed = recomputeCost({ provider, model }, result.usage);
        if (result.stopReason === 'complete' || result.stopReason === 'budget') {
          // The DD-2 fold check: derived-only means the SAME math must give
          // the SAME number. Tolerance 1e-9 USD (float reassociation only).
          const foldAgrees =
            recomputed === undefined
              ? result.costUSD === undefined
              : Math.abs((result.costUSD ?? Number.NaN) - recomputed) <= 1e-9;
          return {
            lane, provider, model, elapsedMs,
            stopReason: result.stopReason,
            servedModel: result.model ?? 'unreported',
            usage: result.usage,
            costUSD: result.costUSD,
            costBasis: result.costBasis,
            recomputedCostUSD: recomputed,
            foldAgrees,
            text: (result.structuredOutput === undefined ? '' : JSON.stringify(result.structuredOutput)).slice(0, 60),
            sessionId: result.sessionId,
          };
        }
        attempts.push({ attempt, stopReason: result.stopReason, usage: result.usage });
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
const onlyIndex = process.argv.indexOf('--only');
const only = onlyIndex !== -1 ? process.argv[onlyIndex + 1] : undefined;
const selected = only === undefined ? cells : cells.filter((c) => `${c.lane}/${c.model}`.includes(only));

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
