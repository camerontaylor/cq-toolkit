# A1 status fixtures (`fixtures/a1-status/`)

Differential fixtures for the TypeScript A1 read-only status/summary port
(`src/policy/crq/statusSummary.ts`, `clientHealth.ts`, `usageSlots.ts`).

`fixtures/group-p/` remains the shared foundation and is **not** edited here.
Its `summary`, `status-helpers` and `usage` families are replayed by
`test/policy/crq/statusSummary.test.ts`; this directory carries the cases A1
needs beyond them: receipt-bound `merged_current` with real receipt ids, the
`test_status_summary.py` edges, and `client_health.snapshot`.

## Oracle and provenance

`emit.py` is the only writer (test tooling; `crq` never imports it). It calls
the real `status_summary`, `review_receipt` and `client_health` modules and
records the exact returned value, or the exception class for a refusal.

```sh
cd apps/crq-python
python3 fixtures/a1-status/emit.py --write   # regenerate every file
python3 fixtures/a1-status/emit.py --check   # fail when a checked-in file is stale
python3 fixtures/a1-status/emit.py --stdout  # print the documents
```

Receipt ids are produced by `review_receipt.write_receipt`, so the TypeScript
reader verifies the same digest over the same canonical bytes. The fixture
stores the receipt document; the test derives bytes with
`receiptJsonBytes`. Encoded with `indent=2`, `ensure_ascii=True` and one
trailing newline; fixed timestamps only, so the bytes are host-independent.

## Families

| file | sources | covers |
|---|---|---|
| `summarize.json` | `status_summary.summarize` | local-review aging and the config window, invalid age tolerance, foreign open PR rank, operator-priority ordering, 24 h completion grouping and the 10-row preview, `starts_cap` (`3` kept, `3.0`/`3e0` fallback, 2^53 and 2^53+1 kept exactly, large negative and float fallbacks, `0`, `true`, `"8"`, missing, remaining-only), generation `true` equality, open cycles, re-harvested runs, review_finished timestamp refusals, 60-minute window boundaries, global in-flight, configured repos before their first item |
| `merged-current.json` | `status_summary.merged_current` | verified no-current-code / partial-scope / terminal / unsupported, deleted and excluded-path counts, receipt-less and tampered receipts, missing receipt, retained reuse lineage (verified, missing parent, cycle, capture-target mismatch), empty path list, sorted and bounded captured targets (+34 case), discovery passthrough |
| `client-health.json` | `client_health.snapshot` | completed age (frozen clock), missing/empty completed_at, invalid and non-string refusals, non-object health and item refusals, pending/blocked counts |

## #1420 additive fields

`pending_items[].label` and `pending_items[].repair_origin` are a
TypeScript-only, additive decision (owner ruling 2026-11-10, issue #1420).
Python is not patched and the summary schema stays 2. The test compares every
Python field exactly after deleting only those two keys, and covers the
additive behaviour in TypeScript-only cases (verdict path + reason, `+N`,
title/body fallback, commit-subject hook, cycle label, `<= 120` UTF-16 units,
no split surrogate, one line). Labels are sourced only from existing
queue/repair text, never from transcripts.

## Int/float boundary

`parse_usage` parses its input with the lossless reader, so `1` and `1.0`
follow Python's `type(value) is int`. A byte-reading caller validates the queue
with `parseCrqState`, then uses
`stateValueWithNumbers(state, [['usage', 'limit']])`; the helper splices the
exact `JsonNumber` from the retained document into a selectively cloned plain
value. `3` stays an int and is kept, while `3.0`, `3.00`, `3e0`, `30e-1` and
`0.3e1` stay floats and fall back to the configured cap. `pythonIntValue`
refuses floats, booleans, numeric strings and unsafe integers.

The A1 fixture loader parses `summarize.json` losslessly and does the same
splice, so the oracle `3.0` case runs through the serialized queue shape; the
end-to-end test also covers the other float lexemes and the missing-usage
fallback. A plain `JSON.parse` result cannot preserve the distinction, and
`toPlainJson` alone erases it.

A Python int that a JavaScript number cannot hold exactly stays a
`JsonNumber` in `starts_cap` (`SummaryInteger` is `number | JsonNumber`). For
example 2^53 and 2^53+1 both keep the exact `JsonNumber` (the JSON writer
refuses unsafe plain numbers), 2^53-1 stays a number, a large negative int
falls back, and a float with the same value falls back. The summary is not a
`JSON.stringify` wire value: a future writer must serialise it with
`pythonJson`/`receiptJsonText`, which emits `JsonNumber` as its exact digits.
The oracle test compares the canonical `starts_cap` bytes for these cases, not
the rounded materialisation.
