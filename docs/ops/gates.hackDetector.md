# `gates.hackDetector`

Generated from the op registry by [`scripts/gen-op-docs.mjs`](../../scripts/gen-op-docs.mjs).
Do not edit by hand — run `npm run gen:op-docs`.

- **Family:** `gates`
- **CLI:** `cq gates.hackDetector [--<schema-key>=<value> ...] [--json]`; run `cq gates.hackDetector --help` for the input schema (a secondary interface over the SDK — see [`src/cli/README.md`](../../src/cli/README.md))

## Input schema

The registry entry's zod `inputSchema`, rendered as canonical JSON Schema
(draft 2020-12; object keys sorted for deterministic output):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "diff": {
      "type": "string"
    },
    "suppressionPatterns": {
      "items": {
        "additionalProperties": false,
        "properties": {
          "flags": {
            "type": "string"
          },
          "name": {
            "minLength": 1,
            "type": "string"
          },
          "pattern": {
            "minLength": 1,
            "type": "string"
          },
          "requiresReason": {
            "type": "boolean"
          }
        },
        "required": [
          "name",
          "pattern"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "tamper": {
      "additionalProperties": false,
      "properties": {
        "detectDeletedTests": {
          "type": "boolean"
        },
        "detectNewSkipOnly": {
          "type": "boolean"
        },
        "detectTautologies": {
          "type": "boolean"
        },
        "skipOnlyPattern": {
          "minLength": 1,
          "type": "string"
        },
        "testFilePatterns": {
          "items": {
            "minLength": 1,
            "type": "string"
          },
          "type": "array"
        }
      },
      "type": "object"
    }
  },
  "required": [
    "diff"
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
