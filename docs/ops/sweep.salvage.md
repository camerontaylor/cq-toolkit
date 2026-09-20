# `sweep.salvage`

Generated from the op registry by [`scripts/gen-op-docs.mjs`](../../scripts/gen-op-docs.mjs).
Do not edit by hand — run `npm run gen:op-docs`.

- **Family:** `sweep`
- **CLI:** `cq sweep.salvage [--<schema-key>=<value> ...] [--json]`; run `cq sweep.salvage --help` for the input schema (a secondary interface over the SDK — see [`src/cli/README.md`](../../src/cli/README.md))

## Input schema

The registry entry's zod `inputSchema`, rendered as canonical JSON Schema
(draft 2020-12; object keys sorted for deterministic output):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "discardDirty": {
      "type": "boolean"
    },
    "entries": {
      "items": {
        "additionalProperties": false,
        "properties": {
          "branch": {
            "minLength": 1,
            "type": "string"
          },
          "journal": {
            "additionalProperties": false,
            "properties": {
              "allTerminal": {
                "type": "boolean"
              },
              "lastStep": {
                "minLength": 1,
                "type": "string"
              },
              "stepsTotal": {
                "maximum": 9007199254740991,
                "minimum": 0,
                "type": "integer"
              }
            },
            "type": "object"
          },
          "path": {
            "minLength": 1,
            "type": "string"
          },
          "runPrefix": {
            "minLength": 1,
            "type": "string"
          }
        },
        "required": [
          "path"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "repoRoot": {
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "repoRoot",
    "entries"
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
