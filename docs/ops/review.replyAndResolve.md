# `review.replyAndResolve`

Generated from the op registry by [`scripts/gen-op-docs.mjs`](../../scripts/gen-op-docs.mjs).
Do not edit by hand — run `npm run gen:op-docs`.

- **Family:** `review`
- **CLI:** `cq review.replyAndResolve [--<schema-key>=<value> ...] [--json]`; run `cq review.replyAndResolve --help` for the input schema (a secondary interface over the SDK — see [`src/cli/README.md`](../../src/cli/README.md))

## Input schema

The registry entry's zod `inputSchema`, rendered as canonical JSON Schema
(draft 2020-12; object keys sorted for deterministic output):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "actions": {
      "items": {
        "oneOf": [
          {
            "additionalProperties": false,
            "properties": {
              "actionId": {
                "minLength": 1,
                "type": "string"
              },
              "body": {
                "minLength": 1,
                "type": "string"
              },
              "kind": {
                "const": "review_reply",
                "type": "string"
              },
              "threadRootRestId": {
                "exclusiveMinimum": 0,
                "maximum": 9007199254740991,
                "type": "integer"
              }
            },
            "required": [
              "kind",
              "actionId",
              "threadRootRestId",
              "body"
            ],
            "type": "object"
          },
          {
            "additionalProperties": false,
            "properties": {
              "actionId": {
                "minLength": 1,
                "type": "string"
              },
              "body": {
                "minLength": 1,
                "type": "string"
              },
              "kind": {
                "const": "issue_comment",
                "type": "string"
              }
            },
            "required": [
              "kind",
              "actionId",
              "body"
            ],
            "type": "object"
          },
          {
            "additionalProperties": false,
            "properties": {
              "actionId": {
                "minLength": 1,
                "type": "string"
              },
              "kind": {
                "const": "resolve_thread",
                "type": "string"
              },
              "threadId": {
                "minLength": 1,
                "type": "string"
              }
            },
            "required": [
              "kind",
              "actionId",
              "threadId"
            ],
            "type": "object"
          }
        ]
      },
      "type": "array"
    },
    "dispatchLogPath": {
      "minLength": 1,
      "type": "string"
    },
    "nowMs": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "owner": {
      "minLength": 1,
      "type": "string"
    },
    "pr": {
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991,
      "type": "integer"
    },
    "pushArgs": {
      "items": {
        "minLength": 1,
        "type": "string"
      },
      "minItems": 1,
      "type": "array"
    },
    "repo": {
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "owner",
    "repo",
    "pr",
    "actions",
    "nowMs",
    "dispatchLogPath"
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
