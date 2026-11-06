# `dev.disposition`

Generated from the op registry by [`scripts/gen-op-docs.mjs`](../../scripts/gen-op-docs.mjs).
Do not edit by hand — run `pnpm run gen:op-docs`.

- **Family:** `dev`
- **CLI:** `cq dev.disposition [--<schema-key>=<value> ...] [--json] [--fail-on-verdict]`; run `cq dev.disposition --help` for the input schema (a secondary interface over the SDK — see [`src/cli/README.md`](../../src/cli/README.md))

## Input schema

The registry entry's zod `inputSchema`, rendered as canonical JSON Schema
(draft 2020-12; object keys sorted for deterministic output):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "acceptedRisk": {
      "type": [
        "string",
        "null"
      ]
    },
    "action": {
      "enum": [
        "fixed",
        "rejected",
        "deferred"
      ],
      "type": "string"
    },
    "evidence": {
      "items": {
        "minLength": 1,
        "type": "string"
      },
      "type": "array"
    },
    "findingId": {
      "minLength": 1,
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
    "owner": {
      "pattern": "\\S",
      "type": "string"
    },
    "repoRoot": {
      "minLength": 1,
      "type": "string"
    },
    "reviewTrigger": {
      "anyOf": [
        {
          "pattern": "\\S",
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    },
    "why": {
      "pattern": "\\S",
      "type": "string"
    }
  },
  "required": [
    "repoRoot",
    "findingId",
    "action",
    "why",
    "owner",
    "evidence"
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
