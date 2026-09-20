# `analyze.playbookRegister`

Generated from the op registry by [`scripts/gen-op-docs.mjs`](../../scripts/gen-op-docs.mjs).
Do not edit by hand — run `npm run gen:op-docs`.

- **Family:** `analyze`
- **CLI:** `cq analyze.playbookRegister --json` (a secondary interface over the SDK; see [`src/cli/README.md`](../../src/cli/README.md))

## Input schema

The registry entry's zod `inputSchema`, rendered as canonical JSON Schema
(draft 2020-12; object keys sorted for deterministic output):

```json
{
  "$defs": {
    "__schema0": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "number"
        },
        {
          "type": "boolean"
        },
        {
          "type": "null"
        },
        {
          "items": {
            "$ref": "#/$defs/__schema0"
          },
          "type": "array"
        },
        {
          "additionalProperties": {
            "$ref": "#/$defs/__schema0"
          },
          "propertyNames": {
            "type": "string"
          },
          "type": "object"
        }
      ]
    }
  },
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "playbook": {
      "additionalProperties": false,
      "properties": {
        "description": {
          "maxLength": 2000,
          "minLength": 1,
          "type": "string"
        },
        "id": {
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
          "type": "string"
        },
        "rule": {
          "additionalProperties": {
            "$ref": "#/$defs/__schema0"
          },
          "propertyNames": {
            "type": "string"
          },
          "type": "object"
        },
        "schemaVersion": {
          "const": 1,
          "type": "number"
        },
        "verifier": {
          "additionalProperties": false,
          "properties": {
            "command": {
              "additionalProperties": false,
              "properties": {
                "args": {
                  "items": {
                    "type": "string"
                  },
                  "type": "array"
                },
                "command": {
                  "minLength": 1,
                  "type": "string"
                },
                "cwd": {
                  "minLength": 1,
                  "type": "string"
                },
                "timeoutMs": {
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991,
                  "type": "integer"
                }
              },
              "required": [
                "command",
                "args"
              ],
              "type": "object"
            }
          },
          "required": [
            "command"
          ],
          "type": "object"
        }
      },
      "required": [
        "schemaVersion",
        "id",
        "description",
        "rule",
        "verifier"
      ],
      "type": "object"
    }
  },
  "required": [
    "playbook"
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
