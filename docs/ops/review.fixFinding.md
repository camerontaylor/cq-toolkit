# `review.fixFinding`

Generated from the op registry by [`scripts/gen-op-docs.mjs`](../../scripts/gen-op-docs.mjs).
Do not edit by hand — run `pnpm run gen:op-docs`.

- **Family:** `review`
- **CLI:** `cq review.fixFinding [--<schema-key>=<value> ...] [--json] [--fail-on-verdict]`; run `cq review.fixFinding --help` for the input schema (a secondary interface over the SDK — see [`src/cli/README.md`](../../src/cli/README.md))

## Input schema

The registry entry's zod `inputSchema`, rendered as canonical JSON Schema
(draft 2020-12; object keys sorted for deterministic output):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "binding": {
      "additionalProperties": false,
      "properties": {
        "findingSha256": {
          "pattern": "^[0-9a-f]{64}$",
          "type": "string"
        },
        "job": {
          "minLength": 1,
          "type": "string"
        },
        "repairBase": {
          "pattern": "^[0-9a-f]{40}$",
          "type": "string"
        },
        "sourceBlobSha": {
          "pattern": "^[0-9a-f]{40}$",
          "type": "string"
        },
        "sourceSha": {
          "pattern": "^[0-9a-f]{40}$",
          "type": "string"
        }
      },
      "required": [
        "job",
        "sourceSha",
        "sourceBlobSha",
        "findingSha256",
        "repairBase"
      ],
      "type": "object"
    },
    "budget": {
      "additionalProperties": false,
      "properties": {
        "maxAttempts": {
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991,
          "type": "integer"
        },
        "maxContextTokens": {
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991,
          "type": "integer"
        },
        "maxOutputTokens": {
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991,
          "type": "integer"
        },
        "maxTokens": {
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991,
          "type": "integer"
        },
        "maxUsd": {
          "exclusiveMinimum": 0,
          "type": "number"
        },
        "strictTokenBudget": {
          "additionalProperties": false,
          "properties": {
            "maxInputTokens": {
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991,
              "type": "integer"
            },
            "reserveOutputTokens": {
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991,
              "type": "integer"
            }
          },
          "required": [
            "maxInputTokens",
            "reserveOutputTokens"
          ],
          "type": "object"
        },
        "wallClockMs": {
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991,
          "type": "integer"
        }
      },
      "type": "object"
    },
    "driver": {
      "additionalProperties": false,
      "properties": {
        "model": {
          "minLength": 1,
          "type": "string"
        },
        "provider": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "model",
        "provider"
      ],
      "type": "object"
    },
    "harness": {
      "additionalProperties": false,
      "properties": {
        "logToolFailures": {
          "type": "boolean"
        },
        "promptBudget": {
          "additionalProperties": false,
          "properties": {
            "maxSystemPromptChars": {
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991,
              "type": "integer"
            },
            "maxToolDescriptionChars": {
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991,
              "type": "integer"
            },
            "maxTools": {
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991,
              "type": "integer"
            }
          },
          "required": [
            "maxSystemPromptChars",
            "maxTools",
            "maxToolDescriptionChars"
          ],
          "type": "object"
        },
        "tools": {
          "additionalProperties": false,
          "properties": {
            "bash": {
              "additionalProperties": false,
              "properties": {
                "commandPatterns": {
                  "items": {
                    "type": "string"
                  },
                  "type": "array"
                },
                "defaultCwd": {
                  "minLength": 1,
                  "type": "string"
                },
                "enabled": {
                  "type": "boolean"
                },
                "maxOutputChars": {
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991,
                  "type": "integer"
                },
                "timeoutMs": {
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991,
                  "type": "integer"
                }
              },
              "required": [
                "enabled",
                "commandPatterns"
              ],
              "type": "object"
            },
            "edit": {
              "additionalProperties": false,
              "properties": {
                "enabled": {
                  "type": "boolean"
                },
                "maxOutputChars": {
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991,
                  "type": "integer"
                },
                "pathPatterns": {
                  "items": {
                    "type": "string"
                  },
                  "type": "array"
                }
              },
              "required": [
                "enabled",
                "pathPatterns"
              ],
              "type": "object"
            },
            "read": {
              "additionalProperties": false,
              "properties": {
                "enabled": {
                  "type": "boolean"
                },
                "maxOutputChars": {
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991,
                  "type": "integer"
                },
                "pathPatterns": {
                  "items": {
                    "type": "string"
                  },
                  "type": "array"
                }
              },
              "required": [
                "enabled",
                "pathPatterns"
              ],
              "type": "object"
            },
            "run": {
              "additionalProperties": false,
              "properties": {
                "commandPatterns": {
                  "items": {
                    "type": "string"
                  },
                  "type": "array"
                },
                "defaultCwd": {
                  "minLength": 1,
                  "type": "string"
                },
                "enabled": {
                  "type": "boolean"
                },
                "maxOutputChars": {
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991,
                  "type": "integer"
                },
                "timeoutMs": {
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991,
                  "type": "integer"
                }
              },
              "required": [
                "enabled",
                "commandPatterns"
              ],
              "type": "object"
            },
            "write": {
              "additionalProperties": false,
              "properties": {
                "enabled": {
                  "type": "boolean"
                },
                "maxOutputChars": {
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991,
                  "type": "integer"
                },
                "pathPatterns": {
                  "items": {
                    "type": "string"
                  },
                  "type": "array"
                }
              },
              "required": [
                "enabled",
                "pathPatterns"
              ],
              "type": "object"
            }
          },
          "required": [
            "read",
            "edit"
          ],
          "type": "object"
        },
        "workspaceRoot": {
          "type": "string"
        }
      },
      "required": [
        "tools",
        "promptBudget"
      ],
      "type": "object"
    },
    "instructions": {
      "type": "string"
    },
    "item": {
      "anyOf": [
        {
          "additionalProperties": false,
          "properties": {
            "body": {
              "type": "string"
            },
            "comments": {
              "items": {
                "additionalProperties": false,
                "properties": {
                  "authorLogin": {
                    "type": [
                      "string",
                      "null"
                    ]
                  },
                  "authorType": {
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
              "maxItems": 100,
              "type": "array"
            },
            "id": {
              "minLength": 1,
              "type": "string"
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
              "anyOf": [
                {
                  "minLength": 1,
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ]
            }
          },
          "required": [
            "id",
            "path",
            "line",
            "body",
            "comments"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "finding": {
              "additionalProperties": false,
              "properties": {
                "acceptedRisk": {
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "evidence": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "items": {
                        "type": "string"
                      },
                      "type": "array"
                    }
                  ]
                },
                "evidenceV1": {
                  "additionalProperties": false,
                  "properties": {
                    "failureScenario": {
                      "minLength": 1,
                      "type": "string"
                    },
                    "primary": {
                      "additionalProperties": false,
                      "properties": {
                        "end": {
                          "exclusiveMinimum": 0,
                          "maximum": 9007199254740991,
                          "type": "integer"
                        },
                        "file": {
                          "minLength": 1,
                          "type": "string"
                        },
                        "quote": {
                          "minLength": 1,
                          "type": "string"
                        },
                        "side": {
                          "enum": [
                            "base",
                            "head"
                          ],
                          "type": "string"
                        },
                        "start": {
                          "exclusiveMinimum": 0,
                          "maximum": 9007199254740991,
                          "type": "integer"
                        }
                      },
                      "required": [
                        "file",
                        "side",
                        "start",
                        "end",
                        "quote"
                      ],
                      "type": "object"
                    },
                    "supporting": {
                      "items": {
                        "additionalProperties": false,
                        "properties": {
                          "end": {
                            "exclusiveMinimum": 0,
                            "maximum": 9007199254740991,
                            "type": "integer"
                          },
                          "file": {
                            "minLength": 1,
                            "type": "string"
                          },
                          "quote": {
                            "minLength": 1,
                            "type": "string"
                          },
                          "relevance": {
                            "minLength": 1,
                            "type": "string"
                          },
                          "side": {
                            "enum": [
                              "base",
                              "head"
                            ],
                            "type": "string"
                          },
                          "start": {
                            "exclusiveMinimum": 0,
                            "maximum": 9007199254740991,
                            "type": "integer"
                          }
                        },
                        "required": [
                          "file",
                          "side",
                          "start",
                          "end",
                          "quote",
                          "relevance"
                        ],
                        "type": "object"
                      },
                      "maxItems": 5,
                      "type": "array"
                    },
                    "validation": {
                      "additionalProperties": false,
                      "properties": {
                        "reasons": {
                          "items": {
                            "minLength": 1,
                            "type": "string"
                          },
                          "minItems": 1,
                          "type": "array"
                        },
                        "status": {
                          "const": "invalid",
                          "type": "string"
                        }
                      },
                      "required": [
                        "status",
                        "reasons"
                      ],
                      "type": "object"
                    },
                    "version": {
                      "const": 1,
                      "type": "number"
                    }
                  },
                  "required": [
                    "version",
                    "failureScenario",
                    "primary",
                    "supporting"
                  ],
                  "type": "object"
                },
                "file": {
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
                "id": {
                  "minLength": 1,
                  "type": "string"
                },
                "line": {
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991,
                  "type": "integer"
                },
                "observedAt": {
                  "format": "date-time",
                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$",
                  "type": "string"
                },
                "observedHead": {
                  "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$",
                  "type": "string"
                },
                "owner": {
                  "minLength": 1,
                  "type": "string"
                },
                "reason": {
                  "type": "string"
                },
                "reviewTrigger": {
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
                "rule": {
                  "type": "string"
                },
                "severity": {
                  "minLength": 1,
                  "type": "string"
                },
                "source": {
                  "minLength": 1,
                  "type": "string"
                },
                "status": {
                  "enum": [
                    "open",
                    "fixed",
                    "rejected",
                    "deferred"
                  ],
                  "type": "string"
                },
                "text": {
                  "type": "string"
                }
              },
              "required": [
                "id",
                "source",
                "severity",
                "text",
                "status"
              ],
              "type": "object"
            },
            "kind": {
              "const": "finding",
              "type": "string"
            }
          },
          "required": [
            "kind",
            "finding"
          ],
          "type": "object"
        }
      ]
    },
    "pr": {
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991,
      "type": "integer"
    },
    "promptOverride": {
      "minLength": 1,
      "type": "string"
    },
    "repo": {
      "minLength": 1,
      "type": "string"
    },
    "worktree": {
      "additionalProperties": false,
      "properties": {
        "branch": {
          "minLength": 1,
          "type": "string"
        },
        "path": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "path",
        "branch"
      ],
      "type": "object"
    }
  },
  "required": [
    "item",
    "worktree",
    "driver",
    "binding"
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
