# fix.run escalation fixture transcript

Captured on triton from fresh repositories using the production spawned CLI, real git, a hermetic gitleaks executable through the production scanner composition, and only scripted driver transports. No provider credentials or network. Each fixture config selects worker/rescue roles; edit and feedback calls remain separate stateless invocations.

Fresh-run allocation starts with initialFixedFailures=0 and rescueBase (default 20). Only distinct verified fingerprint reductions earn floor(newFixes/rescuePerFixed), default one per ten. Unresolved baseline failures, feedback calls and duplicate sibling rows do not earn allocation. Reservations are synchronous across concurrent units; package and run caps both apply. Configured worker attempts default to two; broader regressions route directly to rescue. Failed rounds are inspectable engine-authored commits under <runPrefix>/failed/<kind>/<slug>/<task>/a<n>; their refs stay local unless --push-failed is explicit.

The fixture config uses workerAttempts=2, rescueBase=1, rescuePerFixed=10 and rescuePerPackageCap=1. Success/regression/concurrency fixtures start with only a.test.cjs failing; partial delivery starts with a and b failing. The partial worker fixes b while worker/rescue cannot fix a. The budget fixture sets run.maxTokens=5, and three settled calls honestly report six tokens. Publication remains opt-in; explicit parent cancellation prevents publication, while local budget stop can publish earlier verified commits.

Reproduce all captures with:

```sh
CQ_FIX_ESCALATION_TRANSCRIPT_DIR=/tmp/s4-transcript pnpm test:narrow --include-integration test/e2e/fix/fix-run.e2e.test.ts test/cli/registry.test.ts
```

These are selected report fields from each actual stdout JSON artifact. Temporary fixture paths are normalized to <fixture>; those fresh repositories are removed after assertions.

## rescue-success

Command: `node test/fixtures/fix-cli/entry.mjs fix.run --source=tests --repoRoot=<fixture>/repo --selector={"mode":"workspace-all"} --journalDir=<fixture>/journal --runPrefix=cq/escalation-fixture --concurrency=2 --json`

Observed process exit: `0`. Stderr: empty. Stdout fields selected from the actual JSON artifact:

```json
{
  "status": "ok",
  "value": {
    "verdict": "pass",
    "fixesPerRun": 1,
    "usage": {
      "input": 6,
      "output": 6,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "failed": [
      {
        "unit": "tests-1/scratch-repo",
        "task": "cases/a.test.cjs",
        "outcome": "unfixed",
        "gate": "related",
        "reason": "Error: validation refused task",
        "branch": "cq/escalation-fixture/failed/tests-1/scratch-repo/cases-a-test-cjs/a1",
        "sha": "152206fe076632685a447e0efde9cd3cb31166dd"
      },
      {
        "unit": "tests-1/scratch-repo",
        "task": "cases/a.test.cjs",
        "outcome": "unfixed",
        "gate": "related",
        "reason": "Error: validation refused task",
        "branch": "cq/escalation-fixture/failed/tests-1/scratch-repo/cases-a-test-cjs/a2",
        "sha": "6c54bea9e0f43e3e311d12b69390e2c6826ccec8"
      }
    ],
    "tasks": [
      {
        "task": "cases/a.test.cjs",
        "outcome": "fixed",
        "branch": "cq/escalation-fixture/tests-1/scratch-repo",
        "commits": [
          "343231719bd5c9ea9740cf001cb18ab11c2de506"
        ],
        "rounds": [
          {
            "tier": "worker",
            "attempt": 1,
            "outcome": "unfixed",
            "gate": "related",
            "failedAttempt": {
              "branch": "cq/escalation-fixture/failed/tests-1/scratch-repo/cases-a-test-cjs/a1",
              "sha": "152206fe076632685a447e0efde9cd3cb31166dd"
            }
          },
          {
            "tier": "worker",
            "attempt": 2,
            "outcome": "unfixed",
            "gate": "related",
            "failedAttempt": {
              "branch": "cq/escalation-fixture/failed/tests-1/scratch-repo/cases-a-test-cjs/a2",
              "sha": "6c54bea9e0f43e3e311d12b69390e2c6826ccec8"
            }
          },
          {
            "tier": "rescue",
            "attempt": 1
          }
        ]
      }
    ],
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
          "task": "tests-1:cases/a.test.cjs"
        },
        {
          "tier": "worker",
          "attempt": 2,
          "reason": "worker retry: Error: validation refused task",
          "package": "scratch-repo",
          "task": "tests-1:cases/a.test.cjs"
        },
        {
          "tier": "rescue",
          "attempt": 1,
          "reason": "rescue retry: Error: validation refused task",
          "package": "scratch-repo",
          "task": "tests-1:cases/a.test.cjs"
        }
      ]
    }
  }
}
```

## partial-human

Command: `node test/fixtures/fix-cli/entry.mjs fix.run --source=tests --repoRoot=<fixture>/repo --selector={"mode":"workspace-all"} --journalDir=<fixture>/journal --runPrefix=cq/escalation-fixture --concurrency=2 --json`

Observed process exit: `3`. Stderr: empty. Stdout fields selected from the actual JSON artifact:

```json
{
  "status": "needs-human",
  "value": {
    "verdict": "needs-human",
    "fixesPerRun": 1,
    "usage": {
      "input": 8,
      "output": 8,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "failed": [
      {
        "unit": "tests-1/scratch-repo",
        "task": "cases/a.test.cjs",
        "outcome": "unfixed",
        "gate": "related",
        "reason": "Error: validation refused task",
        "branch": "cq/escalation-fixture/failed/tests-1/scratch-repo/cases-a-test-cjs/a1",
        "sha": "b0347aae3fe884cd6d3d8c527f2688c60f05be8e"
      },
      {
        "unit": "tests-1/scratch-repo",
        "task": "cases/a.test.cjs",
        "outcome": "unfixed",
        "gate": "related",
        "reason": "Error: validation refused task",
        "branch": "cq/escalation-fixture/failed/tests-1/scratch-repo/cases-a-test-cjs/a2",
        "sha": "55645f36b558175c58819530759ab60fae60bd90"
      },
      {
        "unit": "tests-1/scratch-repo",
        "task": "cases/a.test.cjs",
        "outcome": "unfixed",
        "gate": "related",
        "reason": "Error: validation refused task",
        "branch": "cq/escalation-fixture/failed/tests-1/scratch-repo/cases-a-test-cjs/a3",
        "sha": "1c9b8aa09b1c54486b6040749e2ee07acb47e796"
      }
    ],
    "tasks": [
      {
        "task": "cases/a.test.cjs",
        "outcome": "escalated-to-human",
        "branch": "cq/escalation-fixture/tests-1/scratch-repo",
        "commits": [],
        "rounds": [
          {
            "tier": "worker",
            "attempt": 1,
            "outcome": "unfixed",
            "gate": "related",
            "failedAttempt": {
              "branch": "cq/escalation-fixture/failed/tests-1/scratch-repo/cases-a-test-cjs/a1",
              "sha": "b0347aae3fe884cd6d3d8c527f2688c60f05be8e"
            }
          },
          {
            "tier": "worker",
            "attempt": 2,
            "outcome": "unfixed",
            "gate": "related",
            "failedAttempt": {
              "branch": "cq/escalation-fixture/failed/tests-1/scratch-repo/cases-a-test-cjs/a2",
              "sha": "55645f36b558175c58819530759ab60fae60bd90"
            }
          },
          {
            "tier": "rescue",
            "attempt": 1,
            "outcome": "unfixed",
            "gate": "related",
            "failedAttempt": {
              "branch": "cq/escalation-fixture/failed/tests-1/scratch-repo/cases-a-test-cjs/a3",
              "sha": "1c9b8aa09b1c54486b6040749e2ee07acb47e796"
            }
          }
        ]
      },
      {
        "task": "cases/b.test.cjs",
        "outcome": "fixed",
        "branch": "cq/escalation-fixture/tests-1/scratch-repo",
        "commits": [
          "8e6bb33f2f6d1ae55bf7d04a4cb6b6c1842367ec"
        ],
        "rounds": [
          {
            "tier": "worker",
            "attempt": 1
          }
        ]
      }
    ],
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
          "task": "tests-1:cases/a.test.cjs"
        },
        {
          "tier": "worker",
          "attempt": 2,
          "reason": "worker retry: Error: validation refused task",
          "package": "scratch-repo",
          "task": "tests-1:cases/a.test.cjs"
        },
        {
          "tier": "rescue",
          "attempt": 1,
          "reason": "rescue retry: Error: validation refused task",
          "package": "scratch-repo",
          "task": "tests-1:cases/a.test.cjs"
        },
        {
          "tier": "human",
          "attempt": 0,
          "reason": "per-package rescue cap exhausted: Error: validation refused task",
          "package": "scratch-repo",
          "task": "tests-1:cases/a.test.cjs"
        },
        {
          "tier": "worker",
          "attempt": 1,
          "reason": "initial task",
          "package": "scratch-repo",
          "task": "tests-1:cases/b.test.cjs"
        }
      ]
    }
  }
}
```

## budget-stop

Command: `node test/fixtures/fix-cli/entry.mjs fix.run --source=tests --repoRoot=<fixture>/repo --selector={"mode":"workspace-all"} --journalDir=<fixture>/journal --runPrefix=cq/escalation-fixture --concurrency=2 --json`

Observed process exit: `3`. Stderr: empty. Stdout fields selected from the actual JSON artifact:

```json
{
  "status": "needs-human",
  "value": {
    "verdict": "needs-human",
    "fixesPerRun": 0,
    "usage": {
      "input": 3,
      "output": 3,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "failed": [
      {
        "unit": "tests-1/scratch-repo",
        "task": "cases/a.test.cjs",
        "outcome": "unfixed",
        "gate": "related",
        "reason": "Error: validation refused task",
        "branch": "cq/escalation-fixture/failed/tests-1/scratch-repo/cases-a-test-cjs/a1",
        "sha": "2003448b5ab01aee8c10630f0c328cd8685d99fa"
      },
      {
        "unit": "tests-1/scratch-repo",
        "task": "cases/a.test.cjs",
        "outcome": "unfixed",
        "gate": "budget",
        "reason": "Error: token or wall budget exhausted",
        "branch": "cq/escalation-fixture/failed/tests-1/scratch-repo/cases-a-test-cjs/a2",
        "sha": "d626945866f81cb645315058a51f4e71fca27b8a"
      }
    ],
    "tasks": [
      {
        "task": "cases/a.test.cjs",
        "outcome": "unfixed",
        "branch": "cq/escalation-fixture/tests-1/scratch-repo",
        "commits": [],
        "rounds": [
          {
            "tier": "worker",
            "attempt": 1,
            "outcome": "unfixed",
            "gate": "related",
            "failedAttempt": {
              "branch": "cq/escalation-fixture/failed/tests-1/scratch-repo/cases-a-test-cjs/a1",
              "sha": "2003448b5ab01aee8c10630f0c328cd8685d99fa"
            }
          },
          {
            "tier": "worker",
            "attempt": 2,
            "outcome": "unfixed",
            "gate": "budget",
            "failedAttempt": {
              "branch": "cq/escalation-fixture/failed/tests-1/scratch-repo/cases-a-test-cjs/a2",
              "sha": "d626945866f81cb645315058a51f4e71fca27b8a"
            }
          }
        ]
      },
      {
        "task": "cases/b.test.cjs",
        "outcome": "unfixed",
        "branch": "cq/escalation-fixture/tests-1/scratch-repo",
        "commits": [],
        "rounds": []
      }
    ],
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
          "task": "tests-1:cases/a.test.cjs"
        },
        {
          "tier": "worker",
          "attempt": 2,
          "reason": "worker retry: Error: validation refused task",
          "package": "scratch-repo",
          "task": "tests-1:cases/a.test.cjs"
        }
      ]
    }
  }
}
```

## regression-rescue

Command: `node test/fixtures/fix-cli/entry.mjs fix.run --source=tests --repoRoot=<fixture>/repo --selector={"mode":"workspace-all"} --journalDir=<fixture>/journal --runPrefix=cq/escalation-fixture --concurrency=2 --json`

Observed process exit: `0`. Stderr: empty. Stdout fields selected from the actual JSON artifact:

```json
{
  "status": "ok",
  "value": {
    "verdict": "pass",
    "fixesPerRun": 1,
    "usage": {
      "input": 4,
      "output": 4,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "failed": [
      {
        "unit": "tests-1/scratch-repo",
        "task": "cases/a.test.cjs",
        "outcome": "unfixed",
        "gate": "broader",
        "reason": "Error: validation refused task",
        "branch": "cq/escalation-fixture/failed/tests-1/scratch-repo/cases-a-test-cjs/a1",
        "sha": "b6d3f22bb5590e35edbca3bc924a0f4b4a44d586"
      }
    ],
    "tasks": [
      {
        "task": "cases/a.test.cjs",
        "outcome": "fixed",
        "branch": "cq/escalation-fixture/tests-1/scratch-repo",
        "commits": [
          "eb9445343228bee7355b8bc5a48c4bcf6e953fc8"
        ],
        "rounds": [
          {
            "tier": "worker",
            "attempt": 1,
            "outcome": "unfixed",
            "gate": "broader",
            "failedAttempt": {
              "branch": "cq/escalation-fixture/failed/tests-1/scratch-repo/cases-a-test-cjs/a1",
              "sha": "b6d3f22bb5590e35edbca3bc924a0f4b4a44d586"
            }
          },
          {
            "tier": "rescue",
            "attempt": 1
          }
        ]
      }
    ],
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
          "task": "tests-1:cases/a.test.cjs"
        },
        {
          "tier": "rescue",
          "attempt": 1,
          "reason": "broader regression; rescue: Error: validation refused task",
          "package": "scratch-repo",
          "task": "tests-1:cases/a.test.cjs"
        }
      ]
    }
  }
}
```

## concurrent-shared

Command: `node test/fixtures/fix-cli/entry.mjs fix.run --source=tests --repoRoot=<fixture>/repo --selector={"mode":"workspace-all"} --journalDir=<fixture>/journal --runPrefix=cq/escalation-fixture --concurrency=2 --json`

Observed process exit: `3`. Stderr: empty. Stdout fields selected from the actual JSON artifact:

```json
{
  "status": "needs-human",
  "value": {
    "verdict": "needs-human",
    "fixesPerRun": 1,
    "usage": {
      "input": 10,
      "output": 10,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "failed": [
      {
        "unit": "tests-1/scratch-repo",
        "task": "cases/a.test.cjs",
        "outcome": "unfixed",
        "gate": "related",
        "reason": "Error: validation refused task",
        "branch": "cq/escalation-fixture/failed/tests-1/scratch-repo/cases-a-test-cjs/a1",
        "sha": "33eccfdeabf35241bce243a4f5004f63935acf56"
      },
      {
        "unit": "tests-1/scratch-repo",
        "task": "cases/a.test.cjs",
        "outcome": "unfixed",
        "gate": "related",
        "reason": "Error: validation refused task",
        "branch": "cq/escalation-fixture/failed/tests-1/scratch-repo/cases-a-test-cjs/a2",
        "sha": "d3c33f9b378aa6bbdeaa6519283ee03509ca7587"
      },
      {
        "unit": "tests-2/scratch-repo",
        "task": "cases/a.test.cjs",
        "outcome": "unfixed",
        "gate": "related",
        "reason": "Error: validation refused task",
        "branch": "cq/escalation-fixture/failed/tests-2/scratch-repo/cases-a-test-cjs/a1",
        "sha": "95afef7ff3f525d98b9c85fdc6e30cd3db4acf7a"
      },
      {
        "unit": "tests-2/scratch-repo",
        "task": "cases/a.test.cjs",
        "outcome": "unfixed",
        "gate": "related",
        "reason": "Error: validation refused task",
        "branch": "cq/escalation-fixture/failed/tests-2/scratch-repo/cases-a-test-cjs/a2",
        "sha": "a6a6eb01e0a88050655c6f5bc937de6b35b0e58f"
      }
    ],
    "tasks": [
      {
        "task": "cases/a.test.cjs",
        "outcome": "fixed",
        "branch": "cq/escalation-fixture/tests-1/scratch-repo",
        "commits": [
          "6873f404d04e4b2919281a05b13b04b311514ee5"
        ],
        "rounds": [
          {
            "tier": "worker",
            "attempt": 1,
            "outcome": "unfixed",
            "gate": "related",
            "failedAttempt": {
              "branch": "cq/escalation-fixture/failed/tests-1/scratch-repo/cases-a-test-cjs/a1",
              "sha": "33eccfdeabf35241bce243a4f5004f63935acf56"
            }
          },
          {
            "tier": "worker",
            "attempt": 2,
            "outcome": "unfixed",
            "gate": "related",
            "failedAttempt": {
              "branch": "cq/escalation-fixture/failed/tests-1/scratch-repo/cases-a-test-cjs/a2",
              "sha": "d3c33f9b378aa6bbdeaa6519283ee03509ca7587"
            }
          },
          {
            "tier": "rescue",
            "attempt": 1
          }
        ]
      },
      {
        "task": "cases/a.test.cjs",
        "outcome": "escalated-to-human",
        "branch": "cq/escalation-fixture/tests-2/scratch-repo",
        "commits": [],
        "rounds": [
          {
            "tier": "worker",
            "attempt": 1,
            "outcome": "unfixed",
            "gate": "related",
            "failedAttempt": {
              "branch": "cq/escalation-fixture/failed/tests-2/scratch-repo/cases-a-test-cjs/a1",
              "sha": "95afef7ff3f525d98b9c85fdc6e30cd3db4acf7a"
            }
          },
          {
            "tier": "worker",
            "attempt": 2,
            "outcome": "unfixed",
            "gate": "related",
            "failedAttempt": {
              "branch": "cq/escalation-fixture/failed/tests-2/scratch-repo/cases-a-test-cjs/a2",
              "sha": "a6a6eb01e0a88050655c6f5bc937de6b35b0e58f"
            }
          }
        ]
      }
    ],
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
          "task": "tests-1:cases/a.test.cjs"
        },
        {
          "tier": "worker",
          "attempt": 1,
          "reason": "initial task",
          "package": "scratch-repo",
          "task": "tests-2:cases/a.test.cjs"
        },
        {
          "tier": "worker",
          "attempt": 2,
          "reason": "worker retry: Error: validation refused task",
          "package": "scratch-repo",
          "task": "tests-1:cases/a.test.cjs"
        },
        {
          "tier": "worker",
          "attempt": 2,
          "reason": "worker retry: Error: validation refused task",
          "package": "scratch-repo",
          "task": "tests-2:cases/a.test.cjs"
        },
        {
          "tier": "rescue",
          "attempt": 1,
          "reason": "rescue retry: Error: validation refused task",
          "package": "scratch-repo",
          "task": "tests-1:cases/a.test.cjs"
        },
        {
          "tier": "human",
          "attempt": 0,
          "reason": "per-package rescue cap exhausted: Error: validation refused task",
          "package": "scratch-repo",
          "task": "tests-2:cases/a.test.cjs"
        }
      ]
    }
  }
}
```
