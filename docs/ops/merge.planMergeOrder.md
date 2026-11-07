# `merge.planMergeOrder`

Generated from the op registry by [`scripts/gen-op-docs.mjs`](../../scripts/gen-op-docs.mjs).
Do not edit by hand — run `pnpm run gen:op-docs`.

- **Family:** `merge`
- **CLI:** `cq merge.planMergeOrder [--<schema-key>=<value> ...] [--json] [--fail-on-verdict]`; run `cq merge.planMergeOrder --help` for the input schema (a secondary interface over the SDK — see [`src/cli/README.md`](../../src/cli/README.md))

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
            "minLength": 1,
            "type": "string"
          },
          "classification": {
            "anyOf": [
              {
                "additionalProperties": false,
                "properties": {
                  "reason": {
                    "enum": [
                      "is_draft",
                      "merge_conflicts",
                      "merge_state_ambiguous",
                      "merge_state_blocked",
                      "review_data_truncated",
                      "last_commit_unknown",
                      "merge_objection_outstanding",
                      "no_acceptable_review",
                      "explicit_all_clear",
                      "settle_window_elapsed",
                      "settle_window_pending"
                    ],
                    "type": "string"
                  },
                  "unresolvedExternalThreads": {
                    "maximum": 9007199254740991,
                    "minimum": 0,
                    "type": "integer"
                  },
                  "verdict": {
                    "enum": [
                      "never",
                      "conflicting",
                      "awaiting",
                      "eligible"
                    ],
                    "type": "string"
                  }
                },
                "required": [
                  "verdict",
                  "reason",
                  "unresolvedExternalThreads"
                ],
                "type": "object"
              },
              {
                "type": "null"
              }
            ]
          },
          "headRefName": {
            "minLength": 1,
            "type": "string"
          },
          "headSha": {
            "pattern": "^[0-9a-f]{40}$",
            "type": "string"
          },
          "pr": {
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991,
            "type": "integer"
          },
          "state": {
            "enum": [
              "open",
              "closed"
            ],
            "type": "string"
          },
          "truncated": {
            "type": "boolean"
          }
        },
        "required": [
          "pr",
          "headRefName",
          "baseRefName",
          "state",
          "authorLogin",
          "classification",
          "truncated"
        ],
        "type": "object"
      },
      "type": "array"
    }
  },
  "required": [
    "baseBranch",
    "prs"
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
