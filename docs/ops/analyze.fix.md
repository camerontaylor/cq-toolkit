# `analyze.fix`

Generated from the op registry by [`scripts/gen-op-docs.mjs`](../../scripts/gen-op-docs.mjs).
Do not edit by hand — run `pnpm run gen:op-docs`.

- **Family:** `analyze`
- **CLI:** `cq analyze.fix [--<schema-key>=<value> ...] [--json]`; run `cq analyze.fix --help` for the input schema (a secondary interface over the SDK — see [`src/cli/README.md`](../../src/cli/README.md))

## Input schema

The registry entry's zod `inputSchema`, rendered as canonical JSON Schema
(draft 2020-12; object keys sorted for deterministic output):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "apply": {
      "type": "boolean"
    },
    "checks": {
      "items": {
        "additionalProperties": false,
        "properties": {
          "adapter": {
            "enum": [
              "vitest-json",
              "eslint-json",
              "tsc-lines"
            ],
            "type": "string"
          },
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
                "type": "string"
              },
              "cwd": {
                "type": "string"
              },
              "timeoutMs": {
                "default": 600000,
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
          "adapter",
          "command"
        ],
        "type": "object"
      },
      "minItems": 1,
      "type": "array"
    },
    "clusterId": {
      "pattern": "^[0-9a-f]{8}$",
      "type": "string"
    },
    "configPath": {
      "minLength": 1,
      "type": "string"
    },
    "dir": {
      "minLength": 1,
      "type": "string"
    },
    "files": {
      "items": {
        "minLength": 1,
        "type": "string"
      },
      "type": "array"
    },
    "model": {
      "additionalProperties": false,
      "properties": {
        "model": {
          "type": "string"
        },
        "provider": {
          "type": "string"
        }
      },
      "required": [
        "model",
        "provider"
      ],
      "type": "object"
    },
    "out": {
      "minLength": 1,
      "type": "string"
    },
    "previewDigest": {
      "pattern": "^sha256:[0-9a-f]{64}$",
      "type": "string"
    },
    "rule": {
      "minLength": 1,
      "type": "string"
    },
    "sidecarPath": {
      "minLength": 1,
      "type": "string"
    },
    "signature": {
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
    "dir"
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
