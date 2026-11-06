# `analyze.collectFailures`

Generated from the op registry by [`scripts/gen-op-docs.mjs`](../../scripts/gen-op-docs.mjs).
Do not edit by hand — run `pnpm run gen:op-docs`.

- **Family:** `analyze`
- **CLI:** `cq analyze.collectFailures [--<schema-key>=<value> ...] [--json] [--fail-on-verdict]`; run `cq analyze.collectFailures --help` for the input schema (a secondary interface over the SDK — see [`src/cli/README.md`](../../src/cli/README.md))

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
          "advisories": {
            "items": {
              "type": "string"
            },
            "type": "array"
          },
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
          "numPassed": {
            "maximum": 9007199254740991,
            "minimum": 0,
            "type": "integer"
          },
          "numPassedTests": {
            "maximum": 9007199254740991,
            "minimum": 0,
            "type": "integer"
          },
          "numPendingTests": {
            "maximum": 9007199254740991,
            "minimum": 0,
            "type": "integer"
          },
          "numSkippedTests": {
            "maximum": 9007199254740991,
            "minimum": 0,
            "type": "integer"
          },
          "numTodoTests": {
            "maximum": 9007199254740991,
            "minimum": 0,
            "type": "integer"
          },
          "numTotalTests": {
            "maximum": 9007199254740991,
            "minimum": 0,
            "type": "integer"
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
codes from them per invariant I1 ([`policy/DOCTRINE.md`](../../policy/DOCTRINE.md)):
`ok` → 0, `failed`/`indeterminate` → 1, `needs-human`/`budget-exhausted` → 3.
With `--fail-on-verdict`, an `ok` result whose `value` is an object carrying
a failing `verdict` (`'fail'` or `'regression'`) exits 1 instead of 0; exit 2 is
reserved for CLI-detected usage errors and never comes from a result.

- **`ok`** — the op succeeded; `value` carries the result (CLI exit 0 — or exit 1 with `--fail-on-verdict` when `value` is an object carrying a failing `verdict`: `'fail'` or `'regression'`).
- **`failed`** — the op ran and definitively failed; `error` says why (CLI exit 1).
- **`needs-human`** — the op stopped for a decision or input only a human can supply; `reason` records it (CLI exit 3).
- **`budget-exhausted`** — a budget bound was hit, so the op did not run or halted (CLI exit 3).
- **`indeterminate`** — no verdict could be produced (crash, timeout, lost worker); `detail` carries what is known — callers must assume neither success nor failure (CLI exit 1).
