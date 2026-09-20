# `merge.classifyPrs`

Generated from the op registry by [`scripts/gen-op-docs.mjs`](../../scripts/gen-op-docs.mjs).
Do not edit by hand — run `npm run gen:op-docs`.

- **Family:** `merge`
- **CLI:** `cq merge.classifyPrs [--<schema-key>=<value> ...] [--json]`; run `cq merge.classifyPrs --help` for the input schema (a secondary interface over the SDK — see [`src/cli/README.md`](../../src/cli/README.md))

## Input schema

The registry entry's zod `inputSchema`, rendered as canonical JSON Schema
(draft 2020-12; object keys sorted for deterministic output):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "candidate": {
      "additionalProperties": false,
      "properties": {
        "authorLogin": {
          "type": [
            "string",
            "null"
          ]
        },
        "draft": {
          "type": "boolean"
        },
        "issueComments": {
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
                "type": [
                  "string",
                  "null"
                ]
              },
              "id": {
                "maximum": 9007199254740991,
                "minimum": -9007199254740991,
                "type": "integer"
              },
              "inReplyToId": {
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
              "nodeId": {
                "type": [
                  "string",
                  "null"
                ]
              }
            },
            "required": [
              "id",
              "nodeId",
              "authorLogin",
              "body",
              "createdAt",
              "inReplyToId"
            ],
            "type": "object"
          },
          "type": "array"
        },
        "lastCommitAt": {
          "type": [
            "string",
            "null"
          ]
        },
        "mergeState": {
          "enum": [
            "DIRTY",
            "BEHIND",
            "CLEAN",
            "UNKNOWN",
            "HAS_HOOKS",
            "BLOCKED"
          ],
          "type": "string"
        },
        "pr": {
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991,
          "type": "integer"
        },
        "reviews": {
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
              "id": {
                "type": "string"
              },
              "state": {
                "anyOf": [
                  {
                    "enum": [
                      "APPROVED",
                      "CHANGES_REQUESTED",
                      "COMMENTED",
                      "DISMISSED"
                    ],
                    "type": "string"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "submittedAt": {
                "type": [
                  "string",
                  "null"
                ]
              }
            },
            "required": [
              "id",
              "authorLogin",
              "state",
              "body",
              "submittedAt"
            ],
            "type": "object"
          },
          "type": "array"
        },
        "threads": {
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
                "type": [
                  "string",
                  "null"
                ]
              },
              "id": {
                "type": "string"
              },
              "isOutdated": {
                "type": "boolean"
              },
              "isResolved": {
                "type": "boolean"
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
                "type": [
                  "string",
                  "null"
                ]
              },
              "replies": {
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
                      "type": [
                        "string",
                        "null"
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
                "type": "array"
              },
              "rootDatabaseId": {
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
              }
            },
            "required": [
              "id",
              "rootDatabaseId",
              "path",
              "line",
              "isResolved",
              "isOutdated",
              "authorLogin",
              "createdAt",
              "body",
              "replies"
            ],
            "type": "object"
          },
          "type": "array"
        },
        "truncated": {
          "type": "boolean"
        }
      },
      "required": [
        "pr",
        "authorLogin",
        "draft",
        "mergeState",
        "truncated",
        "threads",
        "reviews",
        "issueComments",
        "lastCommitAt"
      ],
      "type": "object"
    },
    "nowMs": {
      "type": "number"
    }
  },
  "required": [
    "candidate",
    "nowMs"
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
