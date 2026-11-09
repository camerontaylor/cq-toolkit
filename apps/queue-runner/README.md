# CRQ TypeScript runner

The runner entry point is `src/queue-runner/crq.ts`, built as
`dist/queue-runner/crq.js` and exposed as `crq`. Commands currently refuse
execution until their Python equivalents are ported. No heartbeat is emitted.

The runner's planning seam records intended mutations under `shadow/<tick>.json`
in dry-run mode. Planners must not perform mutations themselves; live execution
is deliberately unavailable in the skeleton. Later ports must supply the state
root and a unique tick identifier and preserve the shared locking contract.
