# Methods

This note records the implementation and verification methods for W1.11.

## Scope

CQ_SANDBOX support is implemented according to the accepted RS-13 matrix and the task brief.

## Verification

- `test/sandbox/config.test.ts` covers blank-to-required resolution, per-call precedence, RS-13 auto order, uncertified backend refusal, cc-native scope, `CQ_RUN_TOOL`, and launcher env scrubbing.
- `test/workflows/self-host-sandbox.test.ts` is the template render/boundary check: the worker job has no secret reference and the privileged job owns the token-bearing step.
- `npx vitest run test/sandbox/config.test.ts test/workflows/self-host-sandbox.test.ts test/workflows/self-host-concurrency.test.ts` — 3 files, 9 tests passed.
- `npx oxfmt --check src/sandbox/config.ts src/sandbox/index.ts test/sandbox/config.test.ts test/workflows/self-host-sandbox.test.ts` — passed.
- `npm run lint:fast -- src/sandbox/config.ts src/sandbox/index.ts test/sandbox/config.test.ts test/workflows/self-host-sandbox.test.ts` — passed.
- `npm run check:static` — passed; ratchet reports 0 errors against the 0-error baseline.
