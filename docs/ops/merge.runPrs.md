# `merge.runPrs`

Generated from the op registry by [`scripts/gen-op-docs.mjs`](../../scripts/gen-op-docs.mjs).
Do not edit by hand — run `npm run gen:op-docs`.

- **Family:** `merge`
- **CLI:** `cq merge.runPrs --json` (a secondary interface over the SDK; see [`src/cli/README.md`](../../src/cli/README.md))

## Input schema

The registry entry's zod `inputSchema`, rendered as canonical JSON Schema
(draft 2020-12; object keys sorted for deterministic output):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "baseBranch": {
      "minLength": 1,
      "type": "string"
    },
    "maxRetries": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
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
    "nowMs": {
      "type": "number"
    },
    "protectedBranch": {
      "minLength": 1,
      "type": "string"
    },
    "prs": {
      "items": {
        "additionalProperties": false,
        "properties": {
          "authorLogin": {
            "type": [
              "string",
              "null"
            ]
          },
          "baseRefName": {
            "allOf": [
              {
                "pattern": "^[A-Za-z0-9._][A-Za-z0-9._/-]*$"
              },
              {
                "pattern": "^(?!.*\\.\\.).*$"
              }
            ],
            "maxLength": 250,
            "type": "string"
          },
          "draft": {
            "type": "boolean"
          },
          "headRefName": {
            "allOf": [
              {
                "pattern": "^[A-Za-z0-9._][A-Za-z0-9._/-]*$"
              },
              {
                "pattern": "^(?!.*\\.\\.).*$"
              }
            ],
            "maxLength": 250,
            "type": "string"
          },
          "headSha": {
            "pattern": "^[0-9a-f]{40}$",
            "type": "string"
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
          "state": {
            "enum": [
              "open",
              "closed"
            ],
            "type": "string"
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
          "lastCommitAt",
          "headRefName",
          "baseRefName",
          "state"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "repoRoot": {
      "minLength": 1,
      "type": "string"
    },
    "resolveConcurrency": {
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "sessionsDir": {
      "minLength": 1,
      "type": "string"
    },
    "wallClockMs": {
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "baseBranch",
    "repoRoot",
    "prs"
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
