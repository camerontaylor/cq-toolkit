# `analyze.agenticRemediation`

Generated from the op registry by [`scripts/gen-op-docs.mjs`](../../scripts/gen-op-docs.mjs).
Do not edit by hand — run `npm run gen:op-docs`.

- **Family:** `analyze`
- **CLI:** `cq analyze.agenticRemediation [--<schema-key>=<value> ...] [--json]`; run `cq analyze.agenticRemediation --help` for the input schema (a secondary interface over the SDK — see [`src/cli/README.md`](../../src/cli/README.md))

## Input schema

The registry entry's zod `inputSchema`, rendered as canonical JSON Schema
(draft 2020-12; object keys sorted for deterministic output):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "approved": {
      "type": "boolean"
    },
    "budget": {
      "additionalProperties": false,
      "properties": {
        "maxAttempts": {
          "type": "number"
        },
        "maxTokens": {
          "type": "number"
        },
        "maxUsd": {
          "minimum": 0,
          "type": "number"
        },
        "wallClockMs": {
          "type": "number"
        }
      },
      "type": "object"
    },
    "cluster": {
      "additionalProperties": false,
      "properties": {
        "confidence": {
          "enum": [
            "high",
            "medium",
            "low"
          ],
          "type": "string"
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
        "id": {
          "pattern": "^[0-9a-f]{8}$",
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
        "signature": {
          "maxLength": 500,
          "minLength": 1,
          "type": "string"
        },
        "size": {
          "maximum": 9007199254740991,
          "minimum": 1,
          "type": "integer"
        },
        "tool": {
          "maxLength": 500,
          "type": "string"
        }
      },
      "required": [
        "id",
        "signature",
        "tool",
        "ruleId",
        "confidence",
        "failures",
        "size"
      ],
      "type": "object"
    },
    "clusterId": {
      "minLength": 1,
      "type": "string"
    },
    "modelSpec": {
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
    "sandboxPolicy": {
      "additionalProperties": false,
      "properties": {
        "level": {
          "enum": [
            "none",
            "workspace-write",
            "read-only"
          ],
          "type": "string"
        }
      },
      "required": [
        "level"
      ],
      "type": "object"
    },
    "sessionRef": {
      "minLength": 1,
      "type": "string"
    },
    "toolPolicy": {
      "additionalProperties": false,
      "properties": {
        "allow": {
          "items": {
            "type": "string"
          },
          "type": "array"
        },
        "mode": {
          "enum": [
            "allowlist",
            "unrestricted",
            "none"
          ],
          "type": "string"
        }
      },
      "required": [
        "allow"
      ],
      "type": "object"
    }
  },
  "required": [
    "clusterId",
    "cluster",
    "modelSpec"
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
