# RS-10 tamper corpus

The manifest is paired with executable verdicts in `test/ops/gates/tamper-corpus.test.ts`.
Every fixture's paths run through the production staged-path classifier, test
static attacks run through `hackDetector`, and totals rows run through
`regressionGate`. The ten Git-plumbing rows exercise text-only/rename plumbing;
a separate real-git test combines hostile binary, `-diff`, textconv, external
diff, no-prefix, and mnemonic-prefix settings. Fixtures are minimal valid
unified diffs and are not independently executed by the package test command.
