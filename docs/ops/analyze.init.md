# `analyze.init`

Generated from the op registry by [`scripts/gen-op-docs.mjs`](../../scripts/gen-op-docs.mjs).
Do not edit by hand — run `pnpm run gen:op-docs`.

- **Family:** `analyze`
- **CLI:** `cq analyze.init [--<schema-key>=<value> ...] [--json]`; run `cq analyze.init --help` for the input schema (a secondary interface over the SDK — see [`src/cli/README.md`](../../src/cli/README.md))

## Input schema

The registry entry's zod `inputSchema`, rendered as canonical JSON Schema
(draft 2020-12; object keys sorted for deterministic output):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "budgets": {
      "additionalProperties": false,
      "properties": {
        "run": {
          "additionalProperties": false,
          "properties": {
            "maxTokens": {
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991,
              "type": "integer"
            },
            "wallMs": {
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991,
              "type": "integer"
            }
          },
          "type": "object"
        },
        "step": {
          "additionalProperties": false,
          "properties": {
            "wallMs": {
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991,
              "type": "integer"
            }
          },
          "type": "object"
        },
        "unit": {
          "additionalProperties": false,
          "properties": {
            "wallMs": {
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991,
              "type": "integer"
            }
          },
          "type": "object"
        }
      },
      "type": "object"
    },
    "dir": {
      "minLength": 1,
      "type": "string"
    },
    "escalation": {
      "additionalProperties": false,
      "properties": {
        "rescueBase": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "rescuePerFixed": {
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991,
          "type": "integer"
        },
        "rescuePerPackageCap": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "workerAttempts": {
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991,
          "type": "integer"
        }
      },
      "type": "object"
    },
    "force": {
      "type": "boolean"
    },
    "migrate": {
      "type": "boolean"
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
      "minItems": 1,
      "type": "array"
    },
    "review": {
      "additionalProperties": false,
      "properties": {
        "addressConcurrency": {
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991,
          "type": "integer"
        },
        "agentSeverityMap": {
          "additionalProperties": false,
          "properties": {
            "high": {
              "enum": [
                "critical",
                "major",
                "minor",
                "trivial",
                "info",
                "none"
              ],
              "type": "string"
            },
            "low": {
              "enum": [
                "critical",
                "major",
                "minor",
                "trivial",
                "info",
                "none"
              ],
              "type": "string"
            },
            "medium": {
              "enum": [
                "critical",
                "major",
                "minor",
                "trivial",
                "info",
                "none"
              ],
              "type": "string"
            }
          },
          "type": "object"
        },
        "blockingSeverities": {
          "items": {
            "enum": [
              "critical",
              "major",
              "minor",
              "trivial",
              "info",
              "none"
            ],
            "type": "string"
          },
          "type": "array"
        },
        "bulk": {
          "additionalProperties": false,
          "properties": {
            "concurrency": {
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991,
              "type": "integer"
            },
            "query": {
              "minLength": 1,
              "type": "string"
            }
          },
          "type": "object"
        },
        "denylistPatternsFile": {
          "minLength": 1,
          "type": "string"
        },
        "exclude": {
          "items": {
            "additionalProperties": false,
            "properties": {
              "assuredBy": {
                "minLength": 1,
                "type": "string"
              },
              "pattern": {
                "minLength": 1,
                "type": "string"
              }
            },
            "required": [
              "pattern"
            ],
            "type": "object"
          },
          "type": "array"
        },
        "reReview": {
          "additionalProperties": false,
          "properties": {
            "includePriorFindings": {
              "type": "boolean"
            }
          },
          "type": "object"
        },
        "reviewers": {
          "items": {
            "enum": [
              "coderabbit",
              "agent"
            ],
            "type": "string"
          },
          "minItems": 1,
          "type": "array"
        },
        "rounds": {
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991,
          "type": "integer"
        },
        "session": {
          "additionalProperties": false,
          "properties": {
            "maxInputChars": {
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991,
              "type": "integer"
            },
            "maxSteps": {
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991,
              "type": "integer"
            }
          },
          "type": "object"
        },
        "size": {
          "additionalProperties": false,
          "properties": {
            "medium": {
              "additionalProperties": false,
              "properties": {
                "maxChangedLines": {
                  "maximum": 9007199254740991,
                  "minimum": 0,
                  "type": "integer"
                },
                "maxFiles": {
                  "maximum": 9007199254740991,
                  "minimum": 0,
                  "type": "integer"
                }
              },
              "type": "object"
            },
            "small": {
              "additionalProperties": false,
              "properties": {
                "maxChangedLines": {
                  "maximum": 9007199254740991,
                  "minimum": 0,
                  "type": "integer"
                },
                "maxFiles": {
                  "maximum": 9007199254740991,
                  "minimum": 0,
                  "type": "integer"
                }
              },
              "type": "object"
            }
          },
          "type": "object"
        }
      },
      "type": "object"
    },
    "roles": {
      "additionalProperties": false,
      "properties": {
        "rescue": {
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
            "provider",
            "model"
          ],
          "type": "object"
        },
        "reviewer": {
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
            "provider",
            "model"
          ],
          "type": "object"
        },
        "worker": {
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
            "provider",
            "model"
          ],
          "type": "object"
        }
      },
      "type": "object"
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
