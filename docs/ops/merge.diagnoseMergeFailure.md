# `merge.diagnoseMergeFailure`

Generated from the op registry by [`scripts/gen-op-docs.mjs`](../../scripts/gen-op-docs.mjs).
Do not edit by hand — run `npm run gen:op-docs`.

- **Family:** `merge`
- **CLI:** `cq merge.diagnoseMergeFailure [--<schema-key>=<value> ...] [--json]`; run `cq merge.diagnoseMergeFailure --help` for the input schema (a secondary interface over the SDK — see [`src/cli/README.md`](../../src/cli/README.md))

## Input schema

The registry entry's zod `inputSchema`, rendered as canonical JSON Schema
(draft 2020-12; object keys sorted for deterministic output):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "report": {
      "additionalProperties": false,
      "properties": {
        "blocked": {
          "items": {
            "additionalProperties": false,
            "properties": {
              "pr": {
                "exclusiveMinimum": 0,
                "maximum": 9007199254740991,
                "type": "integer"
              },
              "reason": {
                "const": "blocked_by_ancestor",
                "type": "string"
              }
            },
            "required": [
              "pr",
              "reason"
            ],
            "type": "object"
          },
          "type": "array"
        },
        "failed": {
          "items": {
            "additionalProperties": false,
            "properties": {
              "error": {
                "type": "string"
              },
              "pr": {
                "exclusiveMinimum": 0,
                "maximum": 9007199254740991,
                "type": "integer"
              }
            },
            "required": [
              "pr",
              "error"
            ],
            "type": "object"
          },
          "type": "array"
        },
        "merged": {
          "items": {
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991,
            "type": "integer"
          },
          "type": "array"
        },
        "retargeted": {
          "items": {
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991,
            "type": "integer"
          },
          "type": "array"
        },
        "stale": {
          "items": {
            "additionalProperties": false,
            "properties": {
              "detail": {
                "type": "string"
              },
              "pr": {
                "exclusiveMinimum": 0,
                "maximum": 9007199254740991,
                "type": "integer"
              }
            },
            "required": [
              "pr",
              "detail"
            ],
            "type": "object"
          },
          "type": "array"
        }
      },
      "required": [
        "merged",
        "retargeted",
        "stale",
        "failed",
        "blocked"
      ],
      "type": "object"
    }
  },
  "required": [
    "report"
  ],
  "type": "object"
}
```

## Result taxonomy

Every op returns exactly one of the five frozen `OpResult` statuses
([`src/kernel/types.ts`](../../src/kernel/types.ts)); the CLI derives exit
codes from them per invariant I1 ([`policy/DOCTRINE.md`](../../policy/DOCTRINE.md)).

- **`ok`** — the op succeeded; `value` carries the result.
- **`failed`** — the op ran and definitively failed; `error` says why.
- **`needs-human`** — the op stopped for a decision or input only a human can supply; `reason` records it (CLI exit 3).
- **`budget-exhausted`** — a budget bound was hit, so the op did not run or halted (CLI exit 3).
- **`indeterminate`** — no verdict could be produced (crash, timeout, lost worker); `detail` carries what is known — callers must assume neither success nor failure.
