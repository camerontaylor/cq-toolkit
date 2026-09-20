# `ratchet.captureBaseline`

Generated from the op registry by [`scripts/gen-op-docs.mjs`](../../scripts/gen-op-docs.mjs).
Do not edit by hand — run `npm run gen:op-docs`.

- **Family:** `ratchet`
- **CLI:** `cq ratchet.captureBaseline --json` (a secondary interface over the SDK; see [`src/cli/README.md`](../../src/cli/README.md))

## Input schema

The registry entry's zod `inputSchema`, rendered as canonical JSON Schema
(draft 2020-12; object keys sorted for deterministic output):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "capturedAt": {
      "type": "string"
    },
    "metric": {
      "minLength": 1,
      "type": "string"
    },
    "source": {
      "oneOf": [
        {
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
            "kind": {
              "const": "command",
              "type": "string"
            },
            "parse": {
              "enum": [
                "text",
                "json",
                "tsc-text",
                "coverage-json"
              ],
              "type": "string"
            },
            "timeoutMs": {
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991,
              "type": "integer"
            }
          },
          "required": [
            "kind",
            "command",
            "args",
            "parse"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "kind": {
              "const": "file",
              "type": "string"
            },
            "parse": {
              "enum": [
                "text",
                "json",
                "coverage-json"
              ],
              "type": "string"
            },
            "path": {
              "minLength": 1,
              "type": "string"
            }
          },
          "required": [
            "kind",
            "path",
            "parse"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "kind": {
              "const": "raw",
              "type": "string"
            },
            "raw": {}
          },
          "required": [
            "kind",
            "raw"
          ],
          "type": "object"
        }
      ]
    },
    "target": {
      "minLength": 1,
      "type": "string"
    },
    "ws": {
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "ws",
    "target",
    "metric",
    "source"
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
