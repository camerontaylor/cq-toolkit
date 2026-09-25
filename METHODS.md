# Methods

This note records the implementation and verification methods for W1.11.

## Scope

CQ_SANDBOX support is implemented according to the accepted RS-13 matrix and the task brief.

## Verification

- `test/sandbox/config.test.ts` covers blank-to-required resolution, per-call precedence, RS-13 auto order, uncertified backend refusal, cc-native scope, `CQ_RUN_TOOL`, and launcher env scrubbing.
- `test/workflows/self-host-sandbox.test.ts` checks both the adoptable template and instantiated workflow: the unprivileged preparation job has no secret reference, uploads the trusted build, and the privileged job owns the token-bearing step and `contents: write` permission.
- `AiSdkDriver` resolves the conservative environment policy when no explicit sandbox config is supplied and omits `run` from the model tool surface unless the resolved `runTool` is `on`; focused driver tests cover withheld and enabled surfaces.
- `npx vitest run test/driver/ai-sdk.test.ts test/sandbox/config.test.ts test/workflows/self-host-sandbox.test.ts` — 3 files, 47 tests passed, 2 skipped.
- `npx vitest run test/workflows/action-pins.test.ts test/workflows/self-host-concurrency.test.ts test/workflows/self-host-sandbox.test.ts` — 3 files, 30 tests passed.
- `npm run check:static` and `npm run format:check` — passed; ratchet reports 0 errors against the 0-error baseline.
