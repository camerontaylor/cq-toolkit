# `merge.executeMerges`

Generated from the op registry by [`scripts/gen-op-docs.mjs`](../../scripts/gen-op-docs.mjs).
Do not edit by hand — run `npm run gen:op-docs`.

- **Family:** `merge`
- **CLI:** `cq merge.executeMerges --json` (a secondary interface over the SDK; see [`src/cli/README.md`](../../src/cli/README.md))

## Input schema

The registry entry's zod `inputSchema`, rendered as canonical JSON Schema
(draft 2020-12; object keys sorted for deterministic output):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "maxRetries": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "plan": {
      "additionalProperties": false,
      "properties": {
        "baseBranch": {
          "minLength": 1,
          "type": "string"
        },
        "needsHuman": {
          "items": {
            "additionalProperties": false,
            "properties": {
              "pr": {
                "exclusiveMinimum": 0,
                "maximum": 9007199254740991,
                "type": "integer"
              },
              "reason": {
                "enum": [
                  "duplicate_pr",
                  "review_data_truncated",
                  "unclassified",
                  "not_eligible",
                  "unresolved_base",
                  "stack_cycle",
                  "stack_base_needs_human"
                ],
                "type": "string"
              }
            },
            "required": [
              "pr",
              "reason"
            ],
            "type": "object"
          },
          "type": "array"
        },
        "order": {
          "items": {
            "additionalProperties": false,
            "properties": {
              "action": {
                "enum": [
                  "merge",
                  "retarget-self"
                ],
                "type": "string"
              },
              "basePr": {
                "anyOf": [
                  {
                    "exclusiveMinimum": 0,
                    "maximum": 9007199254740991,
                    "type": "integer"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "baseRefName": {
                "minLength": 1,
                "type": "string"
              },
              "depth": {
                "maximum": 9007199254740991,
                "minimum": 0,
                "type": "integer"
              },
              "headSha": {
                "pattern": "^[0-9a-f]{40}$",
                "type": "string"
              },
              "pr": {
                "exclusiveMinimum": 0,
                "maximum": 9007199254740991,
                "type": "integer"
              }
            },
            "required": [
              "pr",
              "action",
              "basePr",
              "depth"
            ],
            "type": "object"
          },
          "type": "array"
        }
      },
      "required": [
        "order",
        "needsHuman",
        "baseBranch"
      ],
      "type": "object"
    },
    "protectedBranch": {
      "minLength": 1,
      "type": "string"
    },
    "repoRoot": {
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "plan",
    "repoRoot"
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
