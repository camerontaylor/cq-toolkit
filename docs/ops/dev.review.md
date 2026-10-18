# `dev.review`

Generated from the op registry by [`scripts/gen-op-docs.mjs`](../../scripts/gen-op-docs.mjs).
Do not edit by hand — run `pnpm run gen:op-docs`.

- **Family:** `dev`
- **CLI:** `cq dev.review [--<schema-key>=<value> ...] [--json]`; run `cq dev.review --help` for the input schema (a secondary interface over the SDK — see [`src/cli/README.md`](../../src/cli/README.md))

## Input schema

The registry entry's zod `inputSchema`, rendered as canonical JSON Schema
(draft 2020-12; object keys sorted for deterministic output):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "anyOf": [
    {
      "additionalProperties": false,
      "properties": {
        "action": {
          "const": "cycle",
          "type": "string"
        },
        "base": {
          "pattern": "^[0-9a-fA-F]{7,64}$",
          "type": "string"
        },
        "repoRoot": {
          "minLength": 1,
          "type": "string"
        },
        "reviewer": {
          "pattern": "^(coderabbit|agent:[A-Za-z0-9][A-Za-z0-9._/@-]*)$",
          "type": "string"
        },
        "target": {
          "minLength": 1,
          "type": "string"
        },
        "uncommitted": {
          "type": "boolean"
        }
      },
      "required": [
        "repoRoot"
      ],
      "type": "object"
    },
    {
      "additionalProperties": false,
      "properties": {
        "action": {
          "enum": [
            "enroll",
            "status",
            "fallback"
          ],
          "type": "string"
        },
        "base": {
          "pattern": "^[0-9a-f]{40}$",
          "type": "string"
        },
        "cycle": {
          "maximum": 2,
          "minimum": 1,
          "type": "integer"
        },
        "head": {
          "pattern": "^[0-9a-f]{40}$",
          "type": "string"
        },
        "requestId": {
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$",
          "type": "string"
        },
        "target": {
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$",
          "type": "string"
        },
        "tree": {
          "pattern": "^[0-9a-f]{40}$",
          "type": "string"
        }
      },
      "required": [
        "action",
        "requestId",
        "base",
        "target",
        "cycle"
      ],
      "type": "object"
    }
  ]
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
