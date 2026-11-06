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
  → harm, missed and population panels. Its `acceptances` input comes from a
  separate composition step, `importAcceptance`
  ([scripts/measurement-acceptance.mjs](../scripts/measurement-acceptance.mjs),
  recipe: [docs/measurement/import-acceptance.md](measurement/import-acceptance.md)):
  the caller merges the importer's `unknown` entries into the outcome bucket
  (`unknown: [...outcome.unknown, ...imported.unknown]`) before rendering, so
  they are never dropped. Its rows are self-declared reader artifacts — never
  an authority for the engine, the merge bar or any check.
- `readMeasurementInputs` ([scripts/measurement-inputs.mjs](../scripts/measurement-inputs.mjs))
  → reader totals and the unknown bucket.

The window is a **caller-declared label**: the renderer does not verify that
the supplied panels fall inside it — the caller composes the three computers
over that window and passes their outputs together with it.

## Rendering rules

- Deterministic: identical inputs render byte-identical JSON and Markdown;
  artifact references render sorted and deduplicated, and no clock is read.
- Unknown is never zero: null counts, unexamined CI and absent coverage render
  as `unknown` with the panel's availability state and reason; a non-known
  numeric total (for example zero attempts under `unavailable`) renders
  `unknown`, never its stored number, and `partial` keeps a labelled subtotal.
- Per-run figures only: no cross-run success ratio and no causal score exists
  anywhere in the readout; the fix panel is one row per run.
- Every panel section states the observation window, and each cost/reader
  figure carries its availability beside it. Corrupt panel shapes are refused
  at render time, never rendered as fabricated figures; untrusted text renders
  inert (line breaks collapse, pipes escape), and identical unknown rows
  across the reader and outcome buckets render once.

## CLI

```
node scripts/measurement-rollup.mjs --input <readout-input.json> [--out <dir>]
```

`readout-input.json` carries the `renderMeasurementReport` input; the CLI
writes `measurement-readout.json` and `measurement-readout.md` into `--out`
(default `.`), touching those explicit local paths only — no providers, no
network, no engine state.
