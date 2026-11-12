# `review.submit`

Generated from the op registry by [`scripts/gen-op-docs.mjs`](../../scripts/gen-op-docs.mjs).
Do not edit by hand — run `pnpm run gen:op-docs`.

- **Family:** `review`
- **CLI:** `cq review.submit [--<schema-key>=<value> ...] [--json] [--fail-on-verdict]`; run `cq review.submit --help` for the input schema (a secondary interface over the SDK — see [`src/cli/README.md`](../../src/cli/README.md))

## Input schema

The registry entry's zod `inputSchema`, rendered as canonical JSON Schema
(draft 2020-12; object keys sorted for deterministic output):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "base": {
      "minLength": 1,
      "type": "string"
    },
    "branch": {
      "minLength": 1,
      "type": "string"
    },
    "cwd": {
      "default": ".",
      "type": "string"
    },
    "head": {
      "pattern": "^[0-9a-f]{40}$",
      "type": "string"
    },
    "notify": {
      "additionalProperties": false,
      "properties": {
        "paseo_agent_id": {
          "type": "string"
        },
        "paseo_host": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "paseo_agent_id",
        "paseo_host"
      ],
      "type": "object"
    },
    "observed": {
      "additionalProperties": false,
      "properties": {
        "ancestor": {
          "type": "boolean"
        },
        "commits_ahead": {
          "anyOf": [
            {
              "maximum": 9007199254740991,
              "minimum": 0,
              "type": "integer"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "ancestor"
      ],
      "type": "object"
    },
    "predecessor": {
      "minLength": 1,
      "pattern": "^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$",
      "type": "string"
    },
    "projection": {
      "default": "full-diff",
      "enum": [
        "full-diff",
        "working-tree-full-v1",
        "working-tree-uncommitted-v1"
      ],
      "type": "string"
    },
    "reachable": {
      "default": false,
      "type": "boolean"
    },
    "repeat": {
      "type": "boolean"
    },
    "repo": {
      "pattern": "^[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+$",
      "type": "string"
    },
    "requestId": {
      "pattern": "^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$",
      "type": "string"
    },
    "scanner": {
      "type": "string"
    },
    "supersedes": {
      "minLength": 1,
      "pattern": "^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$",
      "type": "string"
    },
    "target": {
      "minLength": 1,
      "type": "string"
    },
    "task": {
      "minLength": 1,
      "type": "string"
    },
    "waitMs": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "repo",
    "target"
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
