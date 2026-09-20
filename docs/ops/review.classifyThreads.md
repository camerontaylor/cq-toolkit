# `review.classifyThreads`

Generated from the op registry by [`scripts/gen-op-docs.mjs`](../../scripts/gen-op-docs.mjs).
Do not edit by hand — run `npm run gen:op-docs`.

- **Family:** `review`
- **CLI:** `cq review.classifyThreads [--<schema-key>=<value> ...] [--json]`; run `cq review.classifyThreads --help` for the input schema (a secondary interface over the SDK — see [`src/cli/README.md`](../../src/cli/README.md))

## Input schema

The registry entry's zod `inputSchema`, rendered as canonical JSON Schema
(draft 2020-12; object keys sorted for deterministic output):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "config": {
      "additionalProperties": false,
      "properties": {
        "blockOnOutdatedThreads": {
          "type": "boolean"
        },
        "responderIs": {
          "const": "pr-author",
          "type": "string"
        },
        "skipApprovalReviews": {
          "type": "boolean"
        },
        "skipDismissedReviews": {
          "type": "boolean"
        },
        "skipPatterns": {
          "items": {
            "additionalProperties": false,
            "properties": {
              "flags": {
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
        "skipResponderAuthoredThreads": {
          "type": "boolean"
        },
        "treatNullCreatedAtAs": {
          "enum": [
            "nowMs",
            "epochMs"
          ],
          "type": "string"
        }
      },
      "required": [
        "skipPatterns",
        "responderIs",
        "treatNullCreatedAtAs",
        "blockOnOutdatedThreads",
        "skipResponderAuthoredThreads",
        "skipDismissedReviews",
        "skipApprovalReviews"
      ],
      "type": "object"
    },
    "nowMs": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "state": {
      "additionalProperties": false,
      "properties": {
        "authorLogin": {
          "type": [
            "string",
            "null"
          ]
        },
        "headRefName": {
          "type": [
            "string",
            "null"
          ]
        },
        "headRefOid": {
          "type": [
            "string",
            "null"
          ]
        },
        "pr": {
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991,
          "type": "integer"
        },
        "repo": {
          "additionalProperties": false,
          "properties": {
            "name": {
              "minLength": 1,
              "type": "string"
            },
            "owner": {
              "minLength": 1,
              "type": "string"
            }
          },
          "required": [
            "owner",
            "name"
          ],
          "type": "object"
        },
        "restIssueComments": {
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
        "restReviewComments": {
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
                "minLength": 1,
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
                "minLength": 1,
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
        },
        "truncatedBecause": {
          "items": {
            "minLength": 1,
            "type": "string"
          },
          "type": "array"
        }
      },
      "required": [
        "repo",
        "pr",
        "authorLogin",
        "headRefName",
        "headRefOid",
        "threads",
        "reviews",
        "restReviewComments",
        "restIssueComments",
        "truncated",
        "truncatedBecause"
      ],
      "type": "object"
    }
  },
  "required": [
    "state",
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
