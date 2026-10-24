# fix.run escalation fixture transcript

Captured on triton from fresh repositories using the production spawned CLI, real git, a hermetic gitleaks executable through the production scanner composition, and only a scripted driver transport. No provider credentials or network. Each fixture config selects worker/rescue roles; edit and feedback calls remain separate stateless invocations.

Fresh-run allocation starts with initialFixedFailures=0 and rescueBase (default 20). Only distinct verified fingerprint reductions earn floor(newFixes/rescuePerFixed), default one per ten. Unresolved baseline failures, feedback calls and duplicate sibling rows do not earn allocation. Reservations are synchronous across concurrent units; package and run caps both apply. Configured worker attempts default to two; broader regressions route directly to rescue.

The fixture config uses workerAttempts=2, rescueBase=1, rescuePerFixed=10 and rescuePerPackageCap=1. Success/regression/concurrency fixtures start with only a.test.cjs failing; partial delivery starts with a and b failing. The partial worker fixes b while worker/rescue cannot fix a. The budget fixture sets run.maxTokens=5, and three settled calls honestly report six tokens (token caps are landing gates, including concurrent in-flight calls). Publication remains opt-in; explicit parent cancellation prevents publication, while local budget stop can publish earlier verified commits.

Reproduce all captures with:

```sh
CQ_FIX_ESCALATION_TRANSCRIPT_DIR=/tmp/s4-transcript pnpm test:narrow --include-integration test/e2e/fix/fix-run.e2e.test.ts test/cli/registry.test.ts
```

The following are selected fields from each actual stdout JSON artifact. The op also writes the full report to its reported journal path. Temporary fixture paths are normalized to <fixture>; these fresh fixture directories are cleaned up after assertions. Unknown cost is absent rather than fabricated.

## rescue-success

Command: `node test/fixtures/fix-cli/entry.mjs fix.run --source=tests --repoRoot=<fixture>/repo --selector='{"mode":"workspace-all"}' --journalDir=<fixture>/journal --runPrefix=cq/escalation-fixture --concurrency=2 --json`

Observed process exit: `0`.

```json
{
  "status": "ok",
  "value": {
    "usage": {
      "input": 6,
      "output": 6,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "escalation": {
      "initialFixedFailures": 0,
      "rescuePool": 1,
      "perRunUsed": 1,
      "perPackageUsed": {
        "scratch-repo": 1
      },
      "events": [
        {
          "tier": "worker",
          "attempt": 1,
          "reason": "initial task",
          "package": "scratch-repo",
          "task": "tests-1:cases/a.test.cjs",
          "attempts": [
            {
              "tier": "worker",
              "attempt": 1,
              "invocation": "edit",
              "model": {
                "provider": "fixture",
                "model": "worker-fails"
              },
              "wallMs": 1,
              "reason": "initial task",
              "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0
              },
              "stopReason": "complete"
            },
            {
              "tier": "worker",
              "attempt": 1,
              "invocation": "feedback",
              "model": {
                "provider": "fixture",
                "model": "worker-fails"
              },
              "wallMs": 1,
              "reason": "related-check feedback",
              "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0
              },
              "stopReason": "complete"
            }
          ]
        },
        {
          "tier": "worker",
          "attempt": 2,
          "reason": "worker retry: Error: validation refused task",
          "package": "scratch-repo",
          "task": "tests-1:cases/a.test.cjs",
          "attempts": [
            {
              "tier": "worker",
              "attempt": 2,
              "invocation": "edit",
              "model": {
                "provider": "fixture",
                "model": "worker-fails"
              },
              "wallMs": 1,
              "reason": "worker retry: Error: validation refused task",
              "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0
              },
              "stopReason": "complete"
            },
            {
              "tier": "worker",
              "attempt": 2,
              "invocation": "feedback",
              "model": {
                "provider": "fixture",
                "model": "worker-fails"
              },
              "wallMs": 0,
              "reason": "related-check feedback",
              "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0
              },
              "stopReason": "complete"
            }
          ]
        },
        {
          "tier": "rescue",
          "attempt": 1,
          "reason": "rescue retry: Error: validation refused task",
          "package": "scratch-repo",
          "task": "tests-1:cases/a.test.cjs",
          "attempts": [
            {
              "tier": "rescue",
              "attempt": 1,
              "invocation": "edit",
              "model": {
                "provider": "fixture",
                "model": "rescue-fixes"
              },
              "wallMs": 1,
              "reason": "rescue retry: Error: validation refused task",
              "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0
              },
              "stopReason": "complete"
            },
            {
              "tier": "rescue",
              "attempt": 1,
              "invocation": "feedback",
              "model": {
                "provider": "fixture",
                "model": "rescue-fixes"
              },
              "wallMs": 0,
              "reason": "related-check feedback",
              "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0
              },
              "stopReason": "complete"
            }
          ]
        }
      ]
    },
    "tasks": [
      {
        "outcome": "fixed",
        "commits": [
          "cc14f043e4705be07a922cbeb6a70adbd95f36c0"
        ],
        "files": [
          "cases/a.test.cjs"
        ]
      }
    ]
  }
}
```

## partial-human

Command: `node test/fixtures/fix-cli/entry.mjs fix.run --source=tests --repoRoot=<fixture>/repo --selector='{"mode":"workspace-all"}' --journalDir=<fixture>/journal --runPrefix=cq/escalation-fixture --concurrency=2 --json`

Observed process exit: `3`.

```json
{
  "status": "needs-human",
  "report": {
    "usage": {
      "input": 8,
      "output": 8,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "escalation": {
      "initialFixedFailures": 0,
      "rescuePool": 1,
      "perRunUsed": 1,
      "perPackageUsed": {
        "scratch-repo": 1
      },
      "events": [
        {
          "tier": "worker",
          "attempt": 1,
          "reason": "initial task",
          "package": "scratch-repo",
          "task": "tests-1:cases/a.test.cjs",
          "attempts": [
            {
              "tier": "worker",
              "attempt": 1,
              "invocation": "edit",
              "model": {
                "provider": "fixture",
                "model": "worker-fixes-b"
              },
              "wallMs": 1,
              "reason": "initial task",
              "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0
              },
              "stopReason": "complete"
            },
            {
              "tier": "worker",
              "attempt": 1,
              "invocation": "feedback",
              "model": {
                "provider": "fixture",
                "model": "worker-fixes-b"
              },
              "wallMs": 1,
              "reason": "related-check feedback",
              "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0
              },
              "stopReason": "complete"
            }
          ]
        },
        {
          "tier": "worker",
          "attempt": 2,
          "reason": "worker retry: Error: validation refused task",
          "package": "scratch-repo",
          "task": "tests-1:cases/a.test.cjs",
          "attempts": [
            {
              "tier": "worker",
              "attempt": 2,
              "invocation": "edit",
              "model": {
                "provider": "fixture",
                "model": "worker-fixes-b"
              },
              "wallMs": 0,
              "reason": "worker retry: Error: validation refused task",
              "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0
              },
              "stopReason": "complete"
            },
            {
              "tier": "worker",
              "attempt": 2,
              "invocation": "feedback",
              "model": {
                "provider": "fixture",
                "model": "worker-fixes-b"
              },
              "wallMs": 0,
              "reason": "related-check feedback",
              "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0
              },
              "stopReason": "complete"
            }
          ]
        },
        {
          "tier": "rescue",
          "attempt": 1,
          "reason": "rescue retry: Error: validation refused task",
          "package": "scratch-repo",
          "task": "tests-1:cases/a.test.cjs",
          "attempts": [
            {
              "tier": "rescue",
              "attempt": 1,
              "invocation": "edit",
              "model": {
                "provider": "fixture",
                "model": "rescue-fails"
              },
              "wallMs": 0,
              "reason": "rescue retry: Error: validation refused task",
              "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0
              },
              "stopReason": "complete"
            },
            {
              "tier": "rescue",
              "attempt": 1,
              "invocation": "feedback",
              "model": {
                "provider": "fixture",
                "model": "rescue-fails"
              },
              "wallMs": 0,
              "reason": "related-check feedback",
              "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0
              },
              "stopReason": "complete"
            }
          ]
        },
        {
          "tier": "human",
          "attempt": 0,
          "reason": "per-package rescue cap exhausted: Error: validation refused task",
          "package": "scratch-repo",
          "task": "tests-1:cases/a.test.cjs",
          "attempts": []
        },
        {
          "tier": "worker",
          "attempt": 1,
          "reason": "initial task",
          "package": "scratch-repo",
          "task": "tests-1:cases/b.test.cjs",
          "attempts": [
            {
              "tier": "worker",
              "attempt": 1,
              "invocation": "edit",
              "model": {
                "provider": "fixture",
                "model": "worker-fixes-b"
              },
              "wallMs": 0,
              "reason": "initial task",
              "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0
              },
              "stopReason": "complete"
            },
            {
              "tier": "worker",
              "attempt": 1,
              "invocation": "feedback",
              "model": {
                "provider": "fixture",
                "model": "worker-fixes-b"
              },
              "wallMs": 0,
              "reason": "related-check feedback",
              "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0
              },
              "stopReason": "complete"
            }
          ]
        }
      ]
    },
    "tasks": [
      {
        "outcome": "escalated-to-human",
        "commits": [],
        "reason": "per-package rescue cap exhausted: Error: validation refused task",
        "files": [
          "cases/a.test.cjs"
        ]
      },
      {
        "outcome": "fixed",
        "commits": [
          "3ff64fc12d81bd002dd6b0c002c9b2794ccd2520"
        ],
        "files": [
          "cases/b.test.cjs"
        ]
      }
    ]
  }
}
```

## budget-stop

Command: `node test/fixtures/fix-cli/entry.mjs fix.run --source=tests --repoRoot=<fixture>/repo --selector='{"mode":"workspace-all"}' --journalDir=<fixture>/journal --runPrefix=cq/escalation-fixture --concurrency=2 --json`

Observed process exit: `3`.

```json
{
  "status": "needs-human",
  "report": {
    "usage": {
      "input": 3,
      "output": 3,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "escalation": {
      "initialFixedFailures": 0,
      "rescuePool": 1,
      "perRunUsed": 0,
      "perPackageUsed": {},
      "events": [
        {
          "tier": "worker",
          "attempt": 1,
          "reason": "initial task",
          "package": "scratch-repo",
          "task": "tests-1:cases/a.test.cjs",
          "attempts": [
            {
              "tier": "worker",
              "attempt": 1,
              "invocation": "edit",
              "model": {
                "provider": "fixture",
                "model": "worker-fails"
              },
              "wallMs": 1,
              "reason": "initial task",
              "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0
              },
              "stopReason": "complete"
            },
            {
              "tier": "worker",
              "attempt": 1,
              "invocation": "feedback",
              "model": {
                "provider": "fixture",
                "model": "worker-fails"
              },
              "wallMs": 1,
              "reason": "related-check feedback",
              "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0
              },
              "stopReason": "complete"
            }
          ]
        },
        {
          "tier": "worker",
          "attempt": 2,
          "reason": "worker retry: Error: validation refused task",
          "package": "scratch-repo",
          "task": "tests-1:cases/a.test.cjs",
          "attempts": [
            {
              "tier": "worker",
              "attempt": 2,
              "invocation": "edit",
              "model": {
                "provider": "fixture",
                "model": "worker-fails"
              },
              "wallMs": 1,
              "reason": "worker retry: Error: validation refused task",
              "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0
              },
              "stopReason": "complete"
            }
          ]
        }
      ]
    },
    "tasks": [
      {
        "outcome": "unfixed",
        "commits": [],
        "reason": "Error: token or wall budget exhausted",
        "files": [
          "cases/a.test.cjs"
        ]
      },
      {
        "outcome": "unfixed",
        "commits": [],
        "reason": "token or wall budget exhausted",
        "files": [
          "cases/b.test.cjs"
        ]
      }
    ]
  }
}
```

## regression-rescue

Command: `node test/fixtures/fix-cli/entry.mjs fix.run --source=tests --repoRoot=<fixture>/repo --selector='{"mode":"workspace-all"}' --journalDir=<fixture>/journal --runPrefix=cq/escalation-fixture --concurrency=2 --json`

Observed process exit: `0`.

```json
{
  "status": "ok",
  "value": {
    "usage": {
      "input": 4,
      "output": 4,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "escalation": {
      "initialFixedFailures": 0,
      "rescuePool": 1,
      "perRunUsed": 1,
      "perPackageUsed": {
        "scratch-repo": 1
      },
      "events": [
        {
          "tier": "worker",
          "attempt": 1,
          "reason": "initial task",
          "package": "scratch-repo",
          "task": "tests-1:cases/a.test.cjs",
          "attempts": [
            {
              "tier": "worker",
              "attempt": 1,
              "invocation": "edit",
              "model": {
                "provider": "fixture",
                "model": "worker-regression"
              },
              "wallMs": 2,
              "reason": "initial task",
              "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0
              },
              "stopReason": "complete"
            },
            {
              "tier": "worker",
              "attempt": 1,
              "invocation": "feedback",
              "model": {
                "provider": "fixture",
                "model": "worker-regression"
              },
              "wallMs": 1,
              "reason": "related-check feedback",
              "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0
              },
              "stopReason": "complete"
            }
          ]
        },
        {
          "tier": "rescue",
          "attempt": 1,
          "reason": "broader regression; rescue: Error: validation refused task",
          "package": "scratch-repo",
          "task": "tests-1:cases/a.test.cjs",
          "attempts": [
            {
              "tier": "rescue",
              "attempt": 1,
              "invocation": "edit",
              "model": {
                "provider": "fixture",
                "model": "rescue-fixes"
              },
              "wallMs": 1,
              "reason": "broader regression; rescue: Error: validation refused task",
              "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0
              },
              "stopReason": "complete"
            },
            {
              "tier": "rescue",
              "attempt": 1,
              "invocation": "feedback",
              "model": {
                "provider": "fixture",
                "model": "rescue-fixes"
              },
              "wallMs": 1,
              "reason": "related-check feedback",
              "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0
              },
              "stopReason": "complete"
            }
          ]
        }
      ]
    },
    "tasks": [
      {
        "outcome": "fixed",
        "commits": [
          "55bfa1c2c262b3b179ac6fe36254b2ff83663009"
        ],
        "files": [
          "cases/a.test.cjs"
        ],
        "rounds": [
          {
            "tier": "worker",
            "attempt": 1,
            "reason": "Error: validation refused task",
            "validation": {
              "verdict": "fail",
              "gates": [
                {
                  "gate": "related",
                  "verdict": "pass",
                  "wallMs": 49
                },
                {
                  "gate": "broader",
                  "verdict": "fail",
                  "wallMs": 70,
                  "detail": "novel failures or test-total regression"
                }
              ],
              "final": {
                "tool": "vitest",
                "failures": [
                  {
                    "file": "cases/b.test.cjs",
                    "line": null,
                    "column": null,
                    "ruleId": null,
                    "message": "cases/b.test.cjs",
                    "severity": "error"
                  }
                ],
                "exitCode": 1,
                "numTotalTests": 2
              }
            },
            "preservedEdits": {
              "ref": "refs/cq/fix-run/cq/escalation-fixture/tests-1/scratch-repo/cda92e42-0b21-44e1-8762-db899c9b5a51",
              "sha": "9b771c5542be0ad32291fc6a57468360cc6c8fb6"
            }
          },
          {
            "tier": "rescue",
            "attempt": 1,
            "reason": "broader regression; rescue: Error: validation refused task",
            "validation": {
              "verdict": "pass",
              "gates": [
                {
                  "gate": "related",
                  "verdict": "pass",
                  "wallMs": 53
                },
                {
                  "gate": "broader",
                  "verdict": "pass",
                  "wallMs": 60
                },
                {
                  "gate": "paths",
                  "verdict": "pass",
                  "wallMs": 0
                },
                {
                  "gate": "tamper",
                  "verdict": "pass",
                  "wallMs": 2
                },
                {
                  "gate": "commit",
                  "verdict": "pass",
                  "wallMs": 0
                }
              ],
              "final": {
                "tool": "vitest",
                "failures": [],
                "exitCode": 0,
                "numTotalTests": 2
              }
            }
          }
        ]
      }
    ]
  }
}
```

## concurrent-shared

Command: `node test/fixtures/fix-cli/entry.mjs fix.run --source=tests --repoRoot=<fixture>/repo --selector='{"mode":"workspace-all"}' --journalDir=<fixture>/journal --runPrefix=cq/escalation-fixture --concurrency=2 --json`

Observed process exit: `3`.

```json
{
  "status": "needs-human",
  "report": {
    "usage": {
      "input": 10,
      "output": 10,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "escalation": {
      "initialFixedFailures": 0,
      "rescuePool": 1,
      "perRunUsed": 1,
      "perPackageUsed": {
        "scratch-repo": 1
      },
      "events": [
        {
          "tier": "worker",
          "attempt": 1,
          "reason": "initial task",
          "package": "scratch-repo",
          "task": "tests-1:cases/a.test.cjs",
          "attempts": [
            {
              "tier": "worker",
              "attempt": 1,
              "invocation": "edit",
              "model": {
                "provider": "fixture",
                "model": "worker-fails"
              },
              "wallMs": 1,
              "reason": "initial task",
              "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0
              },
              "stopReason": "complete"
            },
            {
              "tier": "worker",
              "attempt": 1,
              "invocation": "feedback",
              "model": {
                "provider": "fixture",
                "model": "worker-fails"
              },
              "wallMs": 1,
              "reason": "related-check feedback",
              "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0
              },
              "stopReason": "complete"
            }
          ]
        },
        {
          "tier": "worker",
          "attempt": 1,
          "reason": "initial task",
          "package": "scratch-repo",
          "task": "tests-2:cases/a.test.cjs",
          "attempts": [
            {
              "tier": "worker",
              "attempt": 1,
              "invocation": "edit",
              "model": {
                "provider": "fixture",
                "model": "worker-fails"
              },
              "wallMs": 2,
              "reason": "initial task",
              "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0
              },
              "stopReason": "complete"
            },
            {
              "tier": "worker",
              "attempt": 1,
              "invocation": "feedback",
              "model": {
                "provider": "fixture",
                "model": "worker-fails"
              },
              "wallMs": 0,
              "reason": "related-check feedback",
              "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0
              },
              "stopReason": "complete"
            }
          ]
        },
        {
          "tier": "worker",
          "attempt": 2,
          "reason": "worker retry: Error: validation refused task",
          "package": "scratch-repo",
          "task": "tests-1:cases/a.test.cjs",
          "attempts": [
            {
              "tier": "worker",
              "attempt": 2,
              "invocation": "edit",
              "model": {
                "provider": "fixture",
                "model": "worker-fails"
              },
              "wallMs": 0,
              "reason": "worker retry: Error: validation refused task",
              "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0
              },
              "stopReason": "complete"
            },
            {
              "tier": "worker",
              "attempt": 2,
              "invocation": "feedback",
              "model": {
                "provider": "fixture",
                "model": "worker-fails"
              },
              "wallMs": 0,
              "reason": "related-check feedback",
              "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0
              },
              "stopReason": "complete"
            }
          ]
        },
        {
          "tier": "worker",
          "attempt": 2,
          "reason": "worker retry: Error: validation refused task",
          "package": "scratch-repo",
          "task": "tests-2:cases/a.test.cjs",
          "attempts": [
            {
              "tier": "worker",
              "attempt": 2,
              "invocation": "edit",
              "model": {
                "provider": "fixture",
                "model": "worker-fails"
              },
              "wallMs": 0,
              "reason": "worker retry: Error: validation refused task",
              "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0
              },
              "stopReason": "complete"
            },
            {
              "tier": "worker",
              "attempt": 2,
              "invocation": "feedback",
              "model": {
                "provider": "fixture",
                "model": "worker-fails"
              },
              "wallMs": 1,
              "reason": "related-check feedback",
              "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0
              },
              "stopReason": "complete"
            }
          ]
        },
        {
          "tier": "rescue",
          "attempt": 1,
          "reason": "rescue retry: Error: validation refused task",
          "package": "scratch-repo",
          "task": "tests-1:cases/a.test.cjs",
          "attempts": [
            {
              "tier": "rescue",
              "attempt": 1,
              "invocation": "edit",
              "model": {
                "provider": "fixture",
                "model": "rescue-fixes"
              },
              "wallMs": 1,
              "reason": "rescue retry: Error: validation refused task",
              "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0
              },
              "stopReason": "complete"
            },
            {
              "tier": "rescue",
              "attempt": 1,
              "invocation": "feedback",
              "model": {
                "provider": "fixture",
                "model": "rescue-fixes"
              },
              "wallMs": 0,
              "reason": "related-check feedback",
              "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0
              },
              "stopReason": "complete"
            }
          ]
        },
        {
          "tier": "human",
          "attempt": 0,
          "reason": "per-package rescue cap exhausted: Error: validation refused task",
          "package": "scratch-repo",
          "task": "tests-2:cases/a.test.cjs",
          "attempts": []
        }
      ]
    },
    "tasks": [
      {
        "outcome": "fixed",
        "commits": [
          "dd012a8f8cc0de2fdc5aa9278f400357f1c9d576"
        ],
        "files": [
          "cases/a.test.cjs"
        ]
      },
      {
        "outcome": "escalated-to-human",
        "commits": [],
        "reason": "per-package rescue cap exhausted: Error: validation refused task",
        "files": [
          "cases/a.test.cjs"
        ]
      }
    ]
  }
}
```
