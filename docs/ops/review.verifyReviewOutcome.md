# `review.verifyReviewOutcome`

Generated from the op registry by [`scripts/gen-op-docs.mjs`](../../scripts/gen-op-docs.mjs).
Do not edit by hand — run `npm run gen:op-docs`.

- **Family:** `review`
- **CLI:** `cq review.verifyReviewOutcome [--<schema-key>=<value> ...] [--json]`; run `cq review.verifyReviewOutcome --help` for the input schema (a secondary interface over the SDK — see [`src/cli/README.md`](../../src/cli/README.md))

## Input schema

The registry entry's zod `inputSchema`, rendered as canonical JSON Schema
(draft 2020-12; object keys sorted for deterministic output):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "after": {
      "additionalProperties": false,
      "properties": {
        "at": {
          "maximum": 9007199254740991,
          "minimum": -9007199254740991,
          "type": "integer"
        },
        "headSha": {
          "minLength": 1,
          "type": "string"
        },
        "issueComments": {
          "items": {
            "additionalProperties": false,
            "properties": {
              "author": {
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
              "id": {
                "maximum": 9007199254740991,
                "minimum": -9007199254740991,
                "type": "integer"
              }
            },
            "required": [
              "id",
              "author"
            ],
            "type": "object"
          },
          "type": "array"
        },
        "resolvedThreadIds": {
          "items": {
            "minLength": 1,
            "type": "string"
          },
          "type": "array"
        },
        "reviewComments": {
          "items": {
            "additionalProperties": false,
            "properties": {
              "author": {
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
              "id": {
                "maximum": 9007199254740991,
                "minimum": -9007199254740991,
                "type": "integer"
              }
            },
            "required": [
              "id",
              "author"
            ],
            "type": "object"
          },
          "type": "array"
        }
      },
      "required": [
        "at",
        "headSha",
        "reviewComments",
        "issueComments",
        "resolvedThreadIds"
      ],
      "type": "object"
    },
    "before": {
      "additionalProperties": false,
      "properties": {
        "at": {
          "maximum": 9007199254740991,
          "minimum": -9007199254740991,
          "type": "integer"
        },
        "headSha": {
          "minLength": 1,
          "type": "string"
        },
        "issueComments": {
          "items": {
            "additionalProperties": false,
            "properties": {
              "author": {
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
              "id": {
                "maximum": 9007199254740991,
                "minimum": -9007199254740991,
                "type": "integer"
              }
            },
            "required": [
              "id",
              "author"
            ],
            "type": "object"
          },
          "type": "array"
        },
        "resolvedThreadIds": {
          "items": {
            "minLength": 1,
            "type": "string"
          },
          "type": "array"
        },
        "reviewComments": {
          "items": {
            "additionalProperties": false,
            "properties": {
              "author": {
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
              "id": {
                "maximum": 9007199254740991,
                "minimum": -9007199254740991,
                "type": "integer"
              }
            },
            "required": [
              "id",
              "author"
            ],
            "type": "object"
          },
          "type": "array"
        }
      },
      "required": [
        "at",
        "headSha",
        "reviewComments",
        "issueComments",
        "resolvedThreadIds"
      ],
      "type": "object"
    },
    "responderLogin": {
      "type": [
        "string",
        "null"
      ]
    }
  },
  "required": [
    "before",
    "after",
    "responderLogin"
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
