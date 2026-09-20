# `review.planReviewBatch`

Generated from the op registry by [`scripts/gen-op-docs.mjs`](../../scripts/gen-op-docs.mjs).
Do not edit by hand — run `npm run gen:op-docs`.

- **Family:** `review`
- **CLI:** `cq review.planReviewBatch --json` (a secondary interface over the SDK; see [`src/cli/README.md`](../../src/cli/README.md))

## Input schema

The registry entry's zod `inputSchema`, rendered as canonical JSON Schema
(draft 2020-12; object keys sorted for deterministic output):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "classification": {
      "additionalProperties": false,
      "properties": {
        "items": {
          "items": {
            "additionalProperties": false,
            "properties": {
              "id": {
                "minLength": 1,
                "type": "string"
              },
              "kind": {
                "enum": [
                  "thread",
                  "review",
                  "comment"
                ],
                "type": "string"
              },
              "path": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "reason": {
                "minLength": 1,
                "type": "string"
              },
              "verdict": {
                "enum": [
                  "actionable",
                  "responded",
                  "resolved",
                  "blocked",
                  "skip"
                ],
                "type": "string"
              }
            },
            "required": [
              "kind",
              "id",
              "verdict",
              "path",
              "reason"
            ],
            "type": "object"
          },
          "type": "array"
        },
        "truncated": {
          "type": "boolean"
        },
        "truncatedBecause": {
          "items": {
            "minLength": 1,
            "type": "string"
          },
          "type": "array"
        }
      },
      "required": [
        "items",
        "truncated",
        "truncatedBecause"
      ],
      "type": "object"
    },
    "config": {
      "additionalProperties": false,
      "properties": {
        "maxItemsPerSharedBatch": {
          "maximum": 9007199254740991,
          "minimum": -9007199254740991,
          "type": "integer"
        },
        "sharedGroupBy": {
          "enum": [
            "file",
            "none"
          ],
          "type": "string"
        },
        "worktreeMode": {
          "enum": [
            "isolated",
            "shared"
          ],
          "type": "string"
        }
      },
      "required": [
        "worktreeMode",
        "sharedGroupBy",
        "maxItemsPerSharedBatch"
      ],
      "type": "object"
    }
  },
  "required": [
    "classification"
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
