# `review.run`

Generated from the op registry by [`scripts/gen-op-docs.mjs`](../../scripts/gen-op-docs.mjs).
Do not edit by hand — run `pnpm run gen:op-docs`.

- **Family:** `review`
- **CLI:** `cq review.run [--<schema-key>=<value> ...] [--json] [--fail-on-verdict]`; run `cq review.run --help` for the input schema (a secondary interface over the SDK — see [`src/cli/README.md`](../../src/cli/README.md))

## Input schema

The registry entry's zod `inputSchema`, rendered as canonical JSON Schema
(draft 2020-12; object keys sorted for deterministic output):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "areas": {
      "type": "boolean"
    },
    "base": {
      "pattern": "^[0-9a-fA-F]{7,64}$",
      "type": "string"
    },
    "maxTokens": {
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991,
      "type": "integer"
    },
    "prepareEvidence": {
      "type": "boolean"
    },
    "priorFindings": {
      "items": {
        "additionalProperties": false,
        "properties": {
          "acceptedRisk": {
            "type": [
              "string",
              "null"
            ]
          },
          "evidence": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "items": {
                  "type": "string"
                },
                "type": "array"
              }
            ]
          },
          "evidenceV1": {
            "additionalProperties": false,
            "properties": {
              "failureScenario": {
                "minLength": 1,
                "type": "string"
              },
              "primary": {
                "additionalProperties": false,
                "properties": {
                  "end": {
                    "exclusiveMinimum": 0,
                    "maximum": 9007199254740991,
                    "type": "integer"
                  },
                  "file": {
                    "minLength": 1,
                    "type": "string"
                  },
                  "quote": {
                    "minLength": 1,
                    "type": "string"
                  },
                  "side": {
                    "enum": [
                      "base",
                      "head"
                    ],
                    "type": "string"
                  },
                  "start": {
                    "exclusiveMinimum": 0,
                    "maximum": 9007199254740991,
                    "type": "integer"
                  }
                },
                "required": [
                  "file",
                  "side",
                  "start",
                  "end",
                  "quote"
                ],
                "type": "object"
              },
              "supporting": {
                "items": {
                  "additionalProperties": false,
                  "properties": {
                    "end": {
                      "exclusiveMinimum": 0,
                      "maximum": 9007199254740991,
                      "type": "integer"
                    },
                    "file": {
                      "minLength": 1,
                      "type": "string"
                    },
                    "quote": {
                      "minLength": 1,
                      "type": "string"
                    },
                    "relevance": {
                      "minLength": 1,
                      "type": "string"
                    },
                    "side": {
                      "enum": [
                        "base",
                        "head"
                      ],
                      "type": "string"
                    },
                    "start": {
                      "exclusiveMinimum": 0,
                      "maximum": 9007199254740991,
                      "type": "integer"
                    }
                  },
                  "required": [
                    "file",
                    "side",
                    "start",
                    "end",
                    "quote",
                    "relevance"
                  ],
                  "type": "object"
                },
                "maxItems": 5,
                "type": "array"
              },
              "validation": {
                "additionalProperties": false,
                "properties": {
                  "reasons": {
                    "items": {
                      "minLength": 1,
                      "type": "string"
                    },
                    "minItems": 1,
                    "type": "array"
                  },
                  "status": {
                    "const": "invalid",
                    "type": "string"
                  }
                },
                "required": [
                  "status",
                  "reasons"
                ],
                "type": "object"
              },
              "version": {
                "const": 1,
                "type": "number"
              }
            },
            "required": [
              "version",
              "failureScenario",
              "primary",
              "supporting"
            ],
            "type": "object"
          },
          "file": {
            "type": "string"
          },
          "fingerprint": {
            "additionalProperties": false,
            "properties": {
              "checkId": {
                "minLength": 1,
                "type": "string"
              },
              "path": {
                "type": "string"
              },
              "rule": {
                "anyOf": [
                  {
                    "minLength": 1,
                    "type": "string"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "spanContentHash": {
                "anyOf": [
                  {
                    "pattern": "^sha256:[0-9a-f]{64}$",
                    "type": "string"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "version": {
                "const": 1,
                "type": "number"
              }
            },
            "required": [
              "version",
              "checkId",
              "rule",
              "path",
              "spanContentHash"
            ],
            "type": "object"
          },
          "id": {
            "minLength": 1,
            "type": "string"
          },
          "line": {
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991,
            "type": "integer"
          },
          "observedAt": {
            "format": "date-time",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$",
            "type": "string"
          },
          "observedHead": {
            "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$",
            "type": "string"
          },
          "owner": {
            "minLength": 1,
            "type": "string"
          },
          "reason": {
            "type": "string"
          },
          "reviewTrigger": {
            "anyOf": [
              {
                "minLength": 1,
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "rule": {
            "type": "string"
          },
          "severity": {
            "minLength": 1,
            "type": "string"
          },
          "source": {
            "minLength": 1,
            "type": "string"
          },
          "status": {
            "enum": [
              "open",
              "fixed",
              "rejected",
              "deferred"
            ],
            "type": "string"
          },
          "text": {
            "type": "string"
          }
        },
        "required": [
          "id",
          "source",
          "severity",
          "text",
          "status"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "repoRoot": {
      "minLength": 1,
      "type": "string"
    },
    "reviewers": {
      "items": {
        "enum": [
          "agent",
          "coderabbit"
        ],
        "type": "string"
      },
      "minItems": 1,
      "type": "array"
    },
    "target": {
      "minLength": 1,
      "type": "string"
    },
    "uncommitted": {
      "type": "boolean"
    },
    "wallMs": {
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "repoRoot"
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
