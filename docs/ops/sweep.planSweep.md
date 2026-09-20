# `sweep.planSweep`

Generated from the op registry by [`scripts/gen-op-docs.mjs`](../../scripts/gen-op-docs.mjs).
Do not edit by hand — run `npm run gen:op-docs`.

- **Family:** `sweep`
- **CLI:** `cq sweep.planSweep --json` (a secondary interface over the SDK; see [`src/cli/README.md`](../../src/cli/README.md))

## Input schema

The registry entry's zod `inputSchema`, rendered as canonical JSON Schema
(draft 2020-12; object keys sorted for deterministic output):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "baselineSignatures": {
      "items": {
        "additionalProperties": false,
        "properties": {
          "package": {
            "minLength": 1,
            "type": "string"
          },
          "signature": {
            "maxLength": 500,
            "minLength": 1,
            "type": "string"
          }
        },
        "required": [
          "package",
          "signature"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "fixers": {
      "items": {
        "minLength": 1,
        "type": "string"
      },
      "minItems": 1,
      "type": "array"
    },
    "ledger": {
      "additionalProperties": false,
      "properties": {
        "root": {
          "minLength": 1,
          "type": "string"
        },
        "storePath": {
          "minLength": 1,
          "type": "string"
        },
        "thresholds": {
          "additionalProperties": false,
          "properties": {
            "escalateAt": {
              "maximum": 9007199254740991,
              "minimum": 2,
              "type": "integer"
            },
            "suppressAt": {
              "maximum": 9007199254740991,
              "minimum": 1,
              "type": "integer"
            }
          },
          "type": "object"
        }
      },
      "required": [
        "root",
        "storePath"
      ],
      "type": "object"
    },
    "packageFiles": {
      "additionalProperties": {
        "items": {
          "minLength": 1,
          "type": "string"
        },
        "type": "array"
      },
      "propertyNames": {
        "type": "string"
      },
      "type": "object"
    },
    "packages": {
      "items": {
        "additionalProperties": false,
        "properties": {
          "name": {
            "minLength": 1,
            "type": "string"
          },
          "path": {
            "minLength": 1,
            "type": "string"
          }
        },
        "required": [
          "name",
          "path"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "repoRoot": {
      "minLength": 1,
      "type": "string"
    },
    "selector": {
      "oneOf": [
        {
          "additionalProperties": false,
          "properties": {
            "mode": {
              "const": "workspace-all",
              "type": "string"
            }
          },
          "required": [
            "mode"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "base": {
              "minLength": 1,
              "type": "string"
            },
            "mode": {
              "const": "changed-vs-base",
              "type": "string"
            }
          },
          "required": [
            "mode",
            "base"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "mode": {
              "const": "explicit",
              "type": "string"
            },
            "packages": {
              "items": {
                "minLength": 1,
                "type": "string"
              },
              "minItems": 1,
              "type": "array"
            }
          },
          "required": [
            "mode",
            "packages"
          ],
          "type": "object"
        }
      ]
    }
  },
  "required": [
    "repoRoot",
    "packages",
    "selector",
    "fixers"
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
