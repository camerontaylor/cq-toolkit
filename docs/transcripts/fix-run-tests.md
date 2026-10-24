# fix.run tests fixture transcript

Fresh repository, scripted driver, real git and offline checks. The fixture entry injects only the driver through the CLI ops-root seam; production CLI parsing, fix.run schema, fix engine and validation run unchanged.

Command: `node test/fixtures/fix-cli/entry.mjs fix.run --source=tests --repoRoot=<fixture>/repo --selector='{"mode":"workspace-all"}' --journalDir=<fixture>/journal --runPrefix=cq/fixture --json`

Observed process exit: `0`. Stderr: empty. Stdout (one JSON artifact; fixture paths redacted):

```json
{
  "status": "ok",
  "value": {
    "source": "tests",
    "runPrefix": "cq/fixture",
    "reportPath": "<fixture>/journal/fix-run-report-936c638f-0441-47ee-8f06-2bc64c4d50d6.json",
    "verdict": "pass",
    "units": [
      {
        "jobId": "sweep-scratch-repo-tests-1",
        "result": {
          "status": "ok",
          "value": {
            "package": "scratch-repo",
            "fixer": "tests-1",
            "worktree": {
              "path": "<fixture>/journal/worktrees/tests-1/scratch-repo",
              "branch": "cq/fixture/tests-1/scratch-repo",
              "requestedBase": "HEAD",
              "reused": false,
              "clearedBaselineCaches": [],
              "refusedBaselineCaches": []
            },
            "mode": "fix",
            "baseline": {
              "verdict": "failing",
              "attempts": 1,
              "failureSet": {
                "tool": "vitest",
                "failures": [
                  {
                    "file": "cases/a.test.cjs",
                    "line": null,
                    "column": null,
                    "ruleId": null,
                    "message": "cases/a.test.cjs",
                    "severity": "error"
                  },
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
            "final": {
              "verdict": "clean",
              "attempts": 1,
              "failureSet": {
                "tool": "vitest",
                "failures": [],
                "exitCode": 0,
                "numTotalTests": 2
              }
            },
            "prBranch": "cq/fixture/tests-1/scratch-repo",
            "committed": true,
            "committedSha": "534822fef737129cc9cc62d1d35a68ebf7684a72",
            "pushed": false,
            "tasks": [
              {
                "task": {
                  "id": "cases/a.test.cjs",
                  "files": [
                    "cases/a.test.cjs"
                  ],
                  "failures": [
                    {
                      "file": "cases/a.test.cjs",
                      "line": null,
                      "column": null,
                      "ruleId": null,
                      "message": "cases/a.test.cjs",
                      "severity": "error"
                    }
                  ]
                },
                "attempts": [
                  {
                    "tier": "worker",
                    "attempt": 1,
                    "invocation": "edit",
                    "model": {
                      "provider": "fixture",
                      "model": "scripted"
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
                      "model": "scripted"
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
                ],
                "outcome": "fixed",
                "branch": "cq/fixture/tests-1/scratch-repo",
                "commits": [
                  "e918bda2696493fec530b36a2c20c62ebf53aa4b"
                ],
                "validation": {
                  "verdict": "pass",
                  "gates": [
                    {
                      "gate": "related",
                      "verdict": "pass",
                      "wallMs": 40
                    },
                    {
                      "gate": "broader",
                      "verdict": "pass",
                      "wallMs": 59
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
                      "wallMs": 1
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
                }
              },
              {
                "task": {
                  "id": "cases/b.test.cjs",
                  "files": [
                    "cases/b.test.cjs"
                  ],
                  "failures": [
                    {
                      "file": "cases/b.test.cjs",
                      "line": null,
                      "column": null,
                      "ruleId": null,
                      "message": "cases/b.test.cjs",
                      "severity": "error"
                    }
                  ]
                },
                "attempts": [
                  {
                    "tier": "worker",
                    "attempt": 1,
                    "invocation": "edit",
                    "model": {
                      "provider": "fixture",
                      "model": "scripted"
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
                      "model": "scripted"
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
                ],
                "outcome": "fixed",
                "branch": "cq/fixture/tests-1/scratch-repo",
                "commits": [
                  "534822fef737129cc9cc62d1d35a68ebf7684a72"
                ],
                "validation": {
                  "verdict": "pass",
                  "gates": [
                    {
                      "gate": "related",
                      "verdict": "pass",
                      "wallMs": 42
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
                      "wallMs": 0
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
            ],
            "budgetStopped": false
          }
        },
        "report": {
          "package": "scratch-repo",
          "fixer": "tests-1",
          "worktree": {
            "path": "<fixture>/journal/worktrees/tests-1/scratch-repo",
            "branch": "cq/fixture/tests-1/scratch-repo",
            "requestedBase": "HEAD",
            "reused": false,
            "clearedBaselineCaches": [],
            "refusedBaselineCaches": []
          },
          "mode": "fix",
          "baseline": {
            "verdict": "failing",
            "attempts": 1,
            "failureSet": {
              "tool": "vitest",
              "failures": [
                {
                  "file": "cases/a.test.cjs",
                  "line": null,
                  "column": null,
                  "ruleId": null,
                  "message": "cases/a.test.cjs",
                  "severity": "error"
                },
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
          "final": {
            "verdict": "clean",
            "attempts": 1,
            "failureSet": {
              "tool": "vitest",
              "failures": [],
              "exitCode": 0,
              "numTotalTests": 2
            }
          },
          "prBranch": "cq/fixture/tests-1/scratch-repo",
          "committed": true,
          "committedSha": "534822fef737129cc9cc62d1d35a68ebf7684a72",
          "pushed": false,
          "tasks": [
            {
              "task": {
                "id": "cases/a.test.cjs",
                "files": [
                  "cases/a.test.cjs"
                ],
                "failures": [
                  {
                    "file": "cases/a.test.cjs",
                    "line": null,
                    "column": null,
                    "ruleId": null,
                    "message": "cases/a.test.cjs",
                    "severity": "error"
                  }
                ]
              },
              "attempts": [
                {
                  "tier": "worker",
                  "attempt": 1,
                  "invocation": "edit",
                  "model": {
                    "provider": "fixture",
                    "model": "scripted"
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
                    "model": "scripted"
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
              ],
              "outcome": "fixed",
              "branch": "cq/fixture/tests-1/scratch-repo",
              "commits": [
                "e918bda2696493fec530b36a2c20c62ebf53aa4b"
              ],
              "validation": {
                "verdict": "pass",
                "gates": [
                  {
                    "gate": "related",
                    "verdict": "pass",
                    "wallMs": 40
                  },
                  {
                    "gate": "broader",
                    "verdict": "pass",
                    "wallMs": 59
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
                    "wallMs": 1
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
              }
            },
            {
              "task": {
                "id": "cases/b.test.cjs",
                "files": [
                  "cases/b.test.cjs"
                ],
                "failures": [
                  {
                    "file": "cases/b.test.cjs",
                    "line": null,
                    "column": null,
                    "ruleId": null,
                    "message": "cases/b.test.cjs",
                    "severity": "error"
                  }
                ]
              },
              "attempts": [
                {
                  "tier": "worker",
                  "attempt": 1,
                  "invocation": "edit",
                  "model": {
                    "provider": "fixture",
                    "model": "scripted"
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
                    "model": "scripted"
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
              ],
              "outcome": "fixed",
              "branch": "cq/fixture/tests-1/scratch-repo",
              "commits": [
                "534822fef737129cc9cc62d1d35a68ebf7684a72"
              ],
              "validation": {
                "verdict": "pass",
                "gates": [
                  {
                    "gate": "related",
                    "verdict": "pass",
                    "wallMs": 42
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
                    "wallMs": 0
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
          ],
          "budgetStopped": false
        }
      }
    ],
    "tasks": [
      {
        "task": {
          "id": "cases/a.test.cjs",
          "files": [
            "cases/a.test.cjs"
          ],
          "failures": [
            {
              "file": "cases/a.test.cjs",
              "line": null,
              "column": null,
              "ruleId": null,
              "message": "cases/a.test.cjs",
              "severity": "error"
            }
          ]
        },
        "attempts": [
          {
            "tier": "worker",
            "attempt": 1,
            "invocation": "edit",
            "model": {
              "provider": "fixture",
              "model": "scripted"
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
              "model": "scripted"
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
        ],
        "outcome": "fixed",
        "branch": "cq/fixture/tests-1/scratch-repo",
        "commits": [
          "e918bda2696493fec530b36a2c20c62ebf53aa4b"
        ],
        "validation": {
          "verdict": "pass",
          "gates": [
            {
              "gate": "related",
              "verdict": "pass",
              "wallMs": 40
            },
            {
              "gate": "broader",
              "verdict": "pass",
              "wallMs": 59
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
              "wallMs": 1
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
        }
      },
      {
        "task": {
          "id": "cases/b.test.cjs",
          "files": [
            "cases/b.test.cjs"
          ],
          "failures": [
            {
              "file": "cases/b.test.cjs",
              "line": null,
              "column": null,
              "ruleId": null,
              "message": "cases/b.test.cjs",
              "severity": "error"
            }
          ]
        },
        "attempts": [
          {
            "tier": "worker",
            "attempt": 1,
            "invocation": "edit",
            "model": {
              "provider": "fixture",
              "model": "scripted"
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
              "model": "scripted"
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
        ],
        "outcome": "fixed",
        "branch": "cq/fixture/tests-1/scratch-repo",
        "commits": [
          "534822fef737129cc9cc62d1d35a68ebf7684a72"
        ],
        "validation": {
          "verdict": "pass",
          "gates": [
            {
              "gate": "related",
              "verdict": "pass",
              "wallMs": 42
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
              "wallMs": 0
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
    ],
    "fixesPerRun": 2,
    "usage": {
      "input": 4,
      "output": 4,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "wallMs": 2629,
    "run": {
      "runId": "fix-run--mvlqka7c--59c310c7",
      "stoppedEarly": false,
      "counts": {
        "queued": 0,
        "running": 0,
        "blocked": 0,
        "done": 2,
        "failed": 0,
        "budget-exhausted": 0
      },
      "jobs": [
        {
          "jobId": "sweep-plan",
          "op": "sweep.planSweep",
          "result": {
            "status": "ok",
            "value": {
              "jobs": [
                {
                  "id": "sweep-scratch-repo-tests-1",
                  "op": "sweep.unit",
                  "input": {
                    "package": "scratch-repo",
                    "fixer": "tests-1",
                    "files": []
                  },
                  "dependsOn": []
                }
              ],
              "units": [
                {
                  "package": "scratch-repo",
                  "fixer": "tests-1",
                  "files": []
                }
              ],
              "suppressed": [],
              "needsHuman": []
            }
          }
        },
        {
          "jobId": "sweep-scratch-repo-tests-1",
          "op": "sweep.unit",
          "result": {
            "status": "ok",
            "value": {
              "package": "scratch-repo",
              "fixer": "tests-1",
              "worktree": {
                "path": "<fixture>/journal/worktrees/tests-1/scratch-repo",
                "branch": "cq/fixture/tests-1/scratch-repo",
                "requestedBase": "HEAD",
                "reused": false,
                "clearedBaselineCaches": [],
                "refusedBaselineCaches": []
              },
              "mode": "fix",
              "baseline": {
                "verdict": "failing",
                "attempts": 1,
                "failureSet": {
                  "tool": "vitest",
                  "failures": [
                    {
                      "file": "cases/a.test.cjs",
                      "line": null,
                      "column": null,
                      "ruleId": null,
                      "message": "cases/a.test.cjs",
                      "severity": "error"
                    },
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
              "final": {
                "verdict": "clean",
                "attempts": 1,
                "failureSet": {
                  "tool": "vitest",
                  "failures": [],
                  "exitCode": 0,
                  "numTotalTests": 2
                }
              },
              "prBranch": "cq/fixture/tests-1/scratch-repo",
              "committed": true,
              "committedSha": "534822fef737129cc9cc62d1d35a68ebf7684a72",
              "pushed": false,
              "tasks": [
                {
                  "task": {
                    "id": "cases/a.test.cjs",
                    "files": [
                      "cases/a.test.cjs"
                    ],
                    "failures": [
                      {
                        "file": "cases/a.test.cjs",
                        "line": null,
                        "column": null,
                        "ruleId": null,
                        "message": "cases/a.test.cjs",
                        "severity": "error"
                      }
                    ]
                  },
                  "attempts": [
                    {
                      "tier": "worker",
                      "attempt": 1,
                      "invocation": "edit",
                      "model": {
                        "provider": "fixture",
                        "model": "scripted"
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
                        "model": "scripted"
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
                  ],
                  "outcome": "fixed",
                  "branch": "cq/fixture/tests-1/scratch-repo",
                  "commits": [
                    "e918bda2696493fec530b36a2c20c62ebf53aa4b"
                  ],
                  "validation": {
                    "verdict": "pass",
                    "gates": [
                      {
                        "gate": "related",
                        "verdict": "pass",
                        "wallMs": 40
                      },
                      {
                        "gate": "broader",
                        "verdict": "pass",
                        "wallMs": 59
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
                        "wallMs": 1
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
                  }
                },
                {
                  "task": {
                    "id": "cases/b.test.cjs",
                    "files": [
                      "cases/b.test.cjs"
                    ],
                    "failures": [
                      {
                        "file": "cases/b.test.cjs",
                        "line": null,
                        "column": null,
                        "ruleId": null,
                        "message": "cases/b.test.cjs",
                        "severity": "error"
                      }
                    ]
                  },
                  "attempts": [
                    {
                      "tier": "worker",
                      "attempt": 1,
                      "invocation": "edit",
                      "model": {
                        "provider": "fixture",
                        "model": "scripted"
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
                        "model": "scripted"
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
                  ],
                  "outcome": "fixed",
                  "branch": "cq/fixture/tests-1/scratch-repo",
                  "commits": [
                    "534822fef737129cc9cc62d1d35a68ebf7684a72"
                  ],
                  "validation": {
                    "verdict": "pass",
                    "gates": [
                      {
                        "gate": "related",
                        "verdict": "pass",
                        "wallMs": 42
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
                        "wallMs": 0
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
              ],
              "budgetStopped": false
            }
          },
          "usage": {
            "input": 4,
            "output": 4,
            "cacheRead": 0,
            "cacheWrite": 0
          }
        }
      ],
      "usage": {
        "input": 4,
        "output": 4,
        "cacheRead": 0,
        "cacheWrite": 0
      }
    }
  }
}
```
