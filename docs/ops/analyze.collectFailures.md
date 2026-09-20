# `analyze.collectFailures`

Generated from the op registry by [`scripts/gen-op-docs.mjs`](../../scripts/gen-op-docs.mjs).
Do not edit by hand — run `npm run gen:op-docs`.

- **Family:** `analyze`
- **CLI:** `cq analyze.collectFailures --json` (a secondary interface over the SDK; see [`src/cli/README.md`](../../src/cli/README.md))

## Input schema

The registry entry's zod `inputSchema`, rendered as canonical JSON Schema
(draft 2020-12; object keys sorted for deterministic output):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "sets": {
      "items": {
        "additionalProperties": false,
        "properties": {
          "exitCode": {
            "type": [
              "number",
              "null"
            ]
          },
          "failures": {
            "items": {
              "additionalProperties": false,
              "properties": {
                "column": {
                  "type": [
                    "number",
                    "null"
                  ]
                },
                "file": {
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "line": {
                  "type": [
                    "number",
                    "null"
                  ]
                },
                "message": {
                  "type": "string"
                },
                "ruleId": {
                  "anyOf": [
                    {
                      "maxLength": 500,
                      "type": "string"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "severity": {
                  "enum": [
                    "error",
                    "warning"
                  ],
                  "type": "string"
                }
              },
              "required": [
                "file",
                "line",
                "column",
                "ruleId",
                "message",
                "severity"
              ],
              "type": "object"
            },
            "type": "array"
          },
          "tool": {
            "maxLength": 500,
            "type": "string"
          }
        },
        "required": [
          "tool",
          "failures",
          "exitCode"
        ],
        "type": "object"
      },
      "type": "array"
    }
  },
  "required": [
    "sets"
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
