# `review.fixItem`

Generated from the op registry by [`scripts/gen-op-docs.mjs`](../../scripts/gen-op-docs.mjs).
Do not edit by hand — run `npm run gen:op-docs`.

- **Family:** `review`
- **CLI:** `cq review.fixItem [--<schema-key>=<value> ...] [--json]`; run `cq review.fixItem --help` for the input schema (a secondary interface over the SDK — see [`src/cli/README.md`](../../src/cli/README.md))

## Input schema

The registry entry's zod `inputSchema`, rendered as canonical JSON Schema
(draft 2020-12; object keys sorted for deterministic output):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "budget": {
      "additionalProperties": false,
      "properties": {
        "maxAttempts": {
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991,
          "type": "integer"
        },
        "maxTokens": {
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991,
          "type": "integer"
        },
        "maxUsd": {
          "exclusiveMinimum": 0,
          "type": "number"
        },
        "wallClockMs": {
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991,
          "type": "integer"
        }
      },
      "type": "object"
    },
    "driver": {
      "additionalProperties": false,
      "properties": {
        "model": {
          "minLength": 1,
          "type": "string"
        },
        "provider": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "model",
        "provider"
      ],
      "type": "object"
    },
    "harness": {
      "additionalProperties": false,
      "properties": {
        "promptBudget": {
          "additionalProperties": false,
          "properties": {
            "maxSystemPromptChars": {
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991,
              "type": "integer"
            },
            "maxToolDescriptionChars": {
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991,
              "type": "integer"
            },
            "maxTools": {
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991,
              "type": "integer"
            }
          },
          "required": [
            "maxSystemPromptChars",
            "maxTools",
            "maxToolDescriptionChars"
          ],
          "type": "object"
        },
        "tools": {
          "additionalProperties": false,
          "properties": {
            "edit": {
              "additionalProperties": false,
              "properties": {
                "enabled": {
                  "type": "boolean"
                },
                "maxOutputChars": {
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991,
                  "type": "integer"
                },
                "pathPatterns": {
                  "items": {
                    "type": "string"
                  },
                  "type": "array"
                }
              },
              "required": [
                "enabled",
                "pathPatterns"
              ],
              "type": "object"
            },
            "read": {
              "additionalProperties": false,
              "properties": {
                "enabled": {
                  "type": "boolean"
                },
                "maxOutputChars": {
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991,
                  "type": "integer"
                },
                "pathPatterns": {
                  "items": {
                    "type": "string"
                  },
                  "type": "array"
                }
              },
              "required": [
                "enabled",
                "pathPatterns"
              ],
              "type": "object"
            },
            "run": {
              "additionalProperties": false,
              "properties": {
                "commandPatterns": {
                  "items": {
                    "type": "string"
                  },
                  "type": "array"
                },
                "enabled": {
                  "type": "boolean"
                },
                "maxOutputChars": {
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991,
                  "type": "integer"
                },
                "timeoutMs": {
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991,
                  "type": "integer"
                }
              },
              "required": [
                "enabled",
                "commandPatterns"
              ],
              "type": "object"
            }
          },
          "required": [
            "read",
            "edit",
            "run"
          ],
          "type": "object"
        },
        "workspaceRoot": {
          "type": "string"
        }
      },
      "required": [
        "tools",
        "promptBudget"
      ],
      "type": "object"
    },
    "item": {
      "additionalProperties": false,
      "properties": {
        "body": {
          "type": "string"
        },
        "comments": {
          "items": {
            "additionalProperties": false,
            "properties": {
              "authorLogin": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "body": {
                "type": "string"
              },
              "createdAt": {
                "anyOf": [
                  {
                    "minLength": 1,
                    "type": "string"
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "required": [
              "authorLogin",
              "body",
              "createdAt"
            ],
            "type": "object"
          },
          "maxItems": 100,
          "type": "array"
        },
        "id": {
          "minLength": 1,
          "type": "string"
        },
        "line": {
          "anyOf": [
            {
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer"
            },
            {
              "type": "null"
            }
          ]
        },
        "path": {
          "anyOf": [
            {
              "minLength": 1,
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "id",
        "path",
        "line",
        "body",
        "comments"
      ],
      "type": "object"
    },
    "pr": {
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991,
      "type": "integer"
    },
    "promptOverride": {
      "minLength": 1,
      "type": "string"
    },
    "repo": {
      "minLength": 1,
      "type": "string"
    },
    "worktree": {
      "additionalProperties": false,
      "properties": {
        "branch": {
          "minLength": 1,
          "type": "string"
        },
        "path": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "path",
        "branch"
      ],
      "type": "object"
    }
  },
  "required": [
    "pr",
    "item",
    "worktree",
    "driver"
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
