# `review.record`

Generated from the op registry by [`scripts/gen-op-docs.mjs`](../../scripts/gen-op-docs.mjs).
Do not edit by hand — run `pnpm run gen:op-docs`.

- **Family:** `review`
- **CLI:** `cq review.record [--<schema-key>=<value> ...] [--json] [--fail-on-verdict]`; run `cq review.record --help` for the input schema (a secondary interface over the SDK — see [`src/cli/README.md`](../../src/cli/README.md))

## Input schema

The registry entry's zod `inputSchema`, rendered as canonical JSON Schema
(draft 2020-12; object keys sorted for deterministic output):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "authenticatedSubmitter": {
      "maxLength": 200,
      "minLength": 1,
      "type": "string"
    },
    "base": {
      "pattern": "^[0-9a-f]{40}$",
      "type": "string"
    },
    "claimedScope": {
      "items": {
        "additionalProperties": false,
        "properties": {
          "blob": {
            "pattern": "^[0-9a-f]{40,64}$",
            "type": "string"
          },
          "intervals": {
            "items": {
              "items": false,
              "maxItems": 2,
              "minItems": 2,
              "prefixItems": [
                {
                  "maximum": 9007199254740991,
                  "minimum": 1,
                  "type": "integer"
                },
                {
                  "maximum": 9007199254740991,
                  "minimum": 1,
                  "type": "integer"
                }
              ],
              "type": "array"
            },
            "type": "array"
          },
          "path": {
            "minLength": 1,
            "type": "string"
          }
        },
        "required": [
          "path",
          "blob",
          "intervals"
        ],
        "type": "object"
      },
      "maxItems": 256,
      "type": "array"
    },
    "forgeEvidence": {
      "enum": [
        "off-forge-import",
        "github-review-comment"
      ],
      "type": "string"
    },
    "head": {
      "pattern": "^[0-9a-f]{40}$",
      "type": "string"
    },
    "headTree": {
      "pattern": "^[0-9a-f]{40}$",
      "type": "string"
    },
    "independence": {
      "maxLength": 500,
      "minLength": 1,
      "type": "string"
    },
    "producer": {
      "enum": [
        "manual",
        "agent"
      ],
      "type": "string"
    },
    "repo": {
      "pattern": "^[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+$",
      "type": "string"
    },
    "report": {
      "maxLength": 262144,
      "minLength": 1,
      "type": "string"
    },
    "reviewer": {
      "maxLength": 200,
      "minLength": 1,
      "type": "string"
    },
    "sourceId": {
      "maxLength": 200,
      "minLength": 1,
      "type": "string"
    },
    "supersedes": {
      "pattern": "^[0-9a-f]{64}$",
      "type": "string"
    },
    "target": {
      "maxLength": 200,
      "minLength": 1,
      "type": "string"
    },
    "verdict": {
      "enum": [
        "APPROVED",
        "CHANGES_REQUESTED",
        "COMMENTED"
      ],
      "type": "string"
    }
  },
  "required": [
    "producer",
    "sourceId",
    "report"
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
