# Methods

This note records the implementation and verification methods for W1.11.

## Scope

CQ_SANDBOX support is implemented according to the accepted RS-13 matrix and the task brief.

## The run gate, the launcher env, and the network knob

- **One shared seam.** `harnessRunGate()` (src/sandbox) is the single decision every harness
  surface applies, and `buildTools` takes its `HarnessRunGate` as its fourth argument. The
  ai-sdk driver, `selectHarnessSurface`/`buildManifest`, and `createHarnessSurface` all reach it,
  so a required `CQ_SANDBOX` policy cannot be bypassed by picking a driver. A withheld `run` is
  omitted from the surface, not denied at call time — an unreachable tool never reaches
  `child_process`.
- **Opt-in by construction.** `harnessRunGate()` reads the process env only when a sandbox knob
  is actually expressed (`CQ_SANDBOX`, `CQ_SANDBOX_BACKEND`, `CQ_SANDBOX_NETWORK`, `CQ_RUN_TOOL`,
  `CQ_RUN_ENV_PASSTHROUGH`); an environment that names none keeps the pre-W1.11 behaviour where
  the command allowlist is the only gate. A driver may also pass an already-resolved
  `SandboxConfig`, which pins the same decision from data.
- **The scrub is wired to the spawn, not just the resolver.** `runShellCommand` now REQUIRES an
  explicit child env and `buildTools` supplies `buildSandboxLauncherEnv(process.env, gate)`. A
  secret in the entry process never reaches a run child; the launcher allowlist plus the
  gate's explicit passthrough do; a policy knob (`SANDBOX_POLICY_ENV_NAMES`) is refused on both
  the passthrough and a manifest's declared `envNames`, so a child cannot read the knobs that
  govern it. Declared non-knob names (the `HarnessManifest.envNames` contract the MCP surface
  already relied on) still ride through, so the mcp-bin env-scrub test is unchanged.
- **`CQ_SANDBOX_NETWORK` is advisory.** No transport boundary exists in front of a run child —
  no proxy, no netfilter, no loopback-only launcher — so the resolved value records the
  INTENDED posture for a future certified launcher and nothing claims it is enforced. The
  `runTool` decision deliberately does not depend on it.

## Verification

- `test/sandbox/launcher.test.ts` — the shared-gate cases (required policy, `CQ_RUN_TOOL=off`,
  `CQ_SANDBOX=off`, an unexpressed environment, a driver-supplied config), the live
  launcher-env case (an allowed `env` run: `PATH` and the passthrough present, the secret and
  every `CQ_*` knob absent), and the advisory-network cases.
- `npx vitest run test/sandbox test/harness/tools.test.ts test/harness/surface.test.ts test/harness/mcp-bin.test.ts test/driver/ai-sdk.test.ts` — 6 files, 136 tests passed, 2 skipped.
- `npm run check:static` and `npm run format:check` — passed; ratchet reports 0 errors against the 0-error baseline.
- `test/sandbox/config.test.ts` covers blank-to-required resolution, per-call precedence, RS-13 auto order, uncertified backend refusal, cc-native scope, `CQ_RUN_TOOL`, and launcher env scrubbing.
- `test/workflows/self-host-sandbox.test.ts` checks both the adoptable template and instantiated workflow: the unprivileged preparation job has no secret reference, uploads the trusted build, and the privileged job owns the token-bearing step and `contents: write` permission.
- `AiSdkDriver` resolves the conservative environment policy when no explicit sandbox config is supplied and passes it to the shared gate rather than deciding for itself; focused driver tests cover withheld and enabled surfaces.
- `npx vitest run test/driver/ai-sdk.test.ts test/sandbox/config.test.ts test/workflows/self-host-sandbox.test.ts` — 3 files, 47 tests passed, 2 skipped.
- `npx vitest run test/workflows/action-pins.test.ts test/workflows/self-host-concurrency.test.ts test/workflows/self-host-sandbox.test.ts` — 3 files, 30 tests passed.
