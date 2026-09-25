# `sweep.unit`

Generated from the op registry by [`scripts/gen-op-docs.mjs`](../../scripts/gen-op-docs.mjs).
Do not edit by hand — run `npm run gen:op-docs`.

- **Family:** `sweep`
- **CLI:** `cq sweep.unit [--<schema-key>=<value> ...] [--json]`; run `cq sweep.unit --help` for the input schema (a secondary interface over the SDK — see [`src/cli/README.md`](../../src/cli/README.md))

## Input schema

The registry entry's zod `inputSchema`, rendered as canonical JSON Schema
(draft 2020-12; object keys sorted for deterministic output):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "base": {
      "minLength": 1,
      "type": "string"
    },
    "check": {
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
        "timeoutMs": {
          "maximum": 9007199254740991,
          "minimum": 1,
          "type": "integer"
        }
      },
      "required": [
        "adapter",
        "command",
        "args"
      ],
      "type": "object"
    },
    "driver": {
      "additionalProperties": false,
      "properties": {
        "binary": {
          "anyOf": [
            {
              "minLength": 1,
              "type": "string"
            },
            {
              "items": {
                "minLength": 1,
                "type": "string"
              },
              "minItems": 1,
              "type": "array"
            }
          ]
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
        "model": {
          "minLength": 1,
          "type": "string"
        },
        "provider": {
          "minLength": 1,
          "type": "string"
        },
        "routingTable": {
          "additionalProperties": false,
          "properties": {
            "endpoints": {
              "additionalProperties": {
                "additionalProperties": false,
                "properties": {
                  "baseUrlDefault": {
                    "minLength": 1,
                    "type": "string"
                  },
                  "baseUrlEnv": {
                    "minLength": 1,
                    "type": "string"
                  },
                  "keyEnv": {
                    "minLength": 1,
                    "type": "string"
                  },
                  "models": {
                    "items": {
                      "minLength": 1,
                      "type": "string"
                    },
                    "minItems": 1,
                    "type": "array"
                  },
                  "notes": {
                    "minLength": 1,
                    "type": "string"
                  }
                },
                "required": [
                  "baseUrlEnv",
                  "baseUrlDefault",
                  "keyEnv",
                  "models",
                  "notes"
                ],
                "type": "object"
              },
              "propertyNames": {
                "type": "string"
              },
              "type": "object"
            }
          },
          "required": [
            "endpoints"
          ],
          "type": "object"
        },
        "sessionsDir": {
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
        "binary",
        "provider",
        "model"
      ],
      "type": "object"
    },
    "files": {
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "fixer": {
      "minLength": 1,
      "type": "string"
    },
    "gitTimeoutMs": {
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "kind": {
      "minLength": 1,
      "type": "string"
    },
    "mode": {
      "enum": [
        "fix",
        "prep"
      ],
      "type": "string"
    },
    "mutex": {
      "additionalProperties": false,
      "properties": {
        "lockPath": {
          "minLength": 1,
          "type": "string"
        },
        "retries": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "retryBaseMs": {
          "maximum": 9007199254740991,
          "minimum": 1,
          "type": "integer"
        },
        "staleMs": {
          "maximum": 9007199254740991,
          "minimum": 2000,
          "type": "integer"
        }
      },
      "required": [
        "lockPath"
      ],
      "type": "object"
    },
    "package": {
      "minLength": 1,
      "type": "string"
    },
    "promptTemplate": {
      "minLength": 1,
      "type": "string"
    },
    "proposeOnly": {
      "type": "boolean"
    },
    "push": {
      "type": "boolean"
    },
    "repoRoot": {
      "minLength": 1,
      "type": "string"
    },
    "runPrefix": {
      "minLength": 1,
      "type": "string"
    },
    "runStateDir": {
      "minLength": 1,
      "type": "string"
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
    "slug": {
      "minLength": 1,
      "type": "string"
    },
    "stagePathAllowlist": {
      "additionalProperties": false,
      "properties": {
        "patterns": {
          "items": {
            "minLength": 1,
            "type": "string"
          },
          "minItems": 1,
          "type": "array"
        }
      },
      "required": [
        "patterns"
      ],
      "type": "object"
    },
    "worktreesDir": {
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "repoRoot",
    "worktreesDir",
    "runPrefix",
    "base",
    "package",
    "fixer",
    "files"
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
