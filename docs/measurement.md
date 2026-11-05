# Monthly measurement readout

The local monthly readout renders the offline measurement panels
([ADR-0008](adr/0008-journal-v3-report-v2.md)) for one explicit UTC
`[start,end)` window of exactly 30 days. It is a committed reader artifact,
never a runtime engine input, and attribution in it is observational — it
establishes no causal review value.

## Composition

`renderMeasurementReport` in [scripts/measurement-rollup.mjs](../scripts/measurement-rollup.mjs)
renders already-computed panels and recomputes nothing:

- `computeMeasurementPanels` ([scripts/measurement-metrics.mjs](../scripts/measurement-metrics.mjs))
  → fix and cost panels. Pass the reader's `totals.availability` as
  `evidenceAvailability`, or every cost total degrades to partial.
- `computeOutcomePanels` ([scripts/measurement-outcomes.mjs](../scripts/measurement-outcomes.mjs))
  → harm, missed and population panels.
- `readMeasurementInputs` ([scripts/measurement-inputs.mjs](../scripts/measurement-inputs.mjs))
  → reader totals and the unknown bucket.

## Rendering rules

- Deterministic: identical inputs render byte-identical JSON and Markdown;
  artifact references render sorted and deduplicated, and no clock is read.
- Unknown is never zero: null counts, unexamined CI and absent coverage render
  as `unknown` with the panel's availability state and reason.
- Per-run figures only: no cross-run success ratio and no causal score exists
  anywhere in the readout; the fix panel is one row per run.
- Every panel section states the observation window, and each cost/reader
  figure carries its availability beside it. Corrupt panel shapes are refused
  at render time, never rendered as fabricated figures.

## CLI

```
node scripts/measurement-rollup.mjs --input <readout-input.json> [--out <dir>]
```

`readout-input.json` carries the `renderMeasurementReport` input; the CLI
writes `measurement-readout.json` and `measurement-readout.md` into `--out`
(default `.`), touching those explicit local paths only — no providers, no
network, no engine state.
