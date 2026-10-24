# fix.run static fixture transcript

Fresh repository; real installed TypeScript compiler, scripted driver, real git, hermetic gitleaks executable through production scanner composition. No project denylist, provider credentials, or network. The fixture entry injects only the driver; production CLI parsing and fix engine run unchanged.

Checks select adapter aliases (`tsc`, `eslint`, `vitest`), as one alias or a JSON array; unknown or unavailable aliases refuse. Static ESLint requires explicit `checks[].relatedArgs` replacement argv with standalone `{files}`; `eslint .` must replace the broad target, never append files. Missing scope refuses before worker dispatch. Tsc keeps the full configured project check; final related/broader validation shares one fresh base-owned staged-tree probe, while feedback remains mandatory.

Command: `node test/fixtures/fix-cli/entry.mjs fix.run --source=static --checks=tsc --repoRoot=<fixture>/repo --selector='{"mode":"workspace-all"}' --journalDir=<fixture>/journal --runPrefix=cq/static-fixture --json`

Observed process exit: `0`. Stderr: empty. Stdout (one JSON artifact; fixture paths redacted):

```json
{
  "status": "ok",
  "value": {
    "source": "static",
    "runPrefix": "cq/static-fixture",
    "reportPath": "<fixture>/journal/fix-run-report-3486e15c-d087-48d3-9383-d8c4e5987647.json",
    "verdict": "pass",
    "units": [
      {
        "jobId": "sweep-scratch-repo-static-1",
        "result": {
          "status": "ok",
          "value": {
            "package": "scratch-repo",
            "fixer": "static-1",
            "worktree": {
              "path": "<fixture>/journal/worktrees/static-1/scratch-repo",
              "branch": "cq/static-fixture/static-1/scratch-repo",
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
                "tool": "tsc",
                "failures": [
                  {
                    "file": "src/a.ts",
                    "line": 1,
                    "column": 14,
                    "ruleId": "TS2322",
                    "message": "Type 'number' is not assignable to type 'string'.",
                    "severity": "error"
                  },
                  {
                    "file": "src/a.ts",
                    "line": 2,
                    "column": 26,
                    "ruleId": "TS2339",
                    "message": "Property 'missing' does not exist on type 'string'.",
                    "severity": "error"
                  },
                  {
                    "file": "src/b.ts",
                    "line": 1,
                    "column": 14,
                    "ruleId": "TS2322",
                    "message": "Type 'number' is not assignable to type 'string'.",
                    "severity": "error"
                  }
                ],
                "exitCode": 1
              }
            },
            "final": {
              "verdict": "clean",
              "attempts": 1,
              "failureSet": {
                "tool": "tsc",
                "failures": [],
                "exitCode": 0
              }
            },
            "prBranch": "cq/static-fixture/static-1/scratch-repo",
            "committed": true,
            "committedSha": "f662ca9c1012d93cf5d298a0cfbe71e4233d41c0",
            "pushed": false,
            "tasks": [
              {
                "task": {
                  "id": "a685192a",
                  "signature": "[\"tsc\",\"src/a.ts\",\"TS2322\"]",
                  "files": [
                    "src/a.ts"
                  ],
                  "failures": [
                    {
                      "file": "src/a.ts",
                      "line": 1,
                      "column": 14,
                      "ruleId": "TS2322",
                      "message": "Type 'number' is not assignable to type 'string'.",
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
                "branch": "cq/static-fixture/static-1/scratch-repo",
                "commits": [
                  "7be46f0937886d3da133c1a937d23d72d41850c9"
                ],
                "validation": {
                  "verdict": "pass",
                  "gates": [
                    {
                      "gate": "related",
                      "verdict": "pass",
                      "wallMs": 380
                    },
                    {
                      "gate": "broader",
                      "verdict": "pass",
                      "wallMs": 0,
                      "detail": "reused full related check from the base-owned staged tree"
                    },
                    {
                      "gate": "paths",
                      "verdict": "pass",
                      "wallMs": 0
                    },
                    {
                      "gate": "tamper",
                      "verdict": "pass",
                      "wallMs": 1
                    },
                    {
                      "gate": "commit",
                      "verdict": "pass",
                      "wallMs": 1
                    }
                  ],
                  "final": {
                    "tool": "tsc",
                    "failures": [
                      {
                        "file": "src/a.ts",
                        "line": 2,
                        "column": 26,
                        "ruleId": "TS2339",
                        "message": "Property 'missing' does not exist on type 'string'.",
                        "severity": "error"
                      },
                      {
                        "file": "src/b.ts",
                        "line": 1,
                        "column": 14,
                        "ruleId": "TS2322",
                        "message": "Type 'number' is not assignable to type 'string'.",
                        "severity": "error"
                      }
                    ],
                    "exitCode": 1
                  }
                }
              },
              {
                "task": {
                  "id": "f71910e2",
                  "signature": "[\"tsc\",\"src/a.ts\",\"TS2339\"]",
                  "files": [
                    "src/a.ts"
                  ],
                  "failures": [
                    {
                      "file": "src/a.ts",
                      "line": 2,
                      "column": 26,
                      "ruleId": "TS2339",
                      "message": "Property 'missing' does not exist on type 'string'.",
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
                "branch": "cq/static-fixture/static-1/scratch-repo",
                "commits": [
                  "35fb2ad8af0a721dfb36781a6b68d7e9ec758b1c"
                ],
                "validation": {
                  "verdict": "pass",
                  "gates": [
                    {
                      "gate": "related",
                      "verdict": "pass",
                      "wallMs": 339
                    },
                    {
                      "gate": "broader",
                      "verdict": "pass",
                      "wallMs": 0,
                      "detail": "reused full related check from the base-owned staged tree"
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
                    "tool": "tsc",
                    "failures": [
                      {
                        "file": "src/b.ts",
                        "line": 1,
                        "column": 14,
                        "ruleId": "TS2322",
                        "message": "Type 'number' is not assignable to type 'string'.",
                        "severity": "error"
                      }
                    ],
                    "exitCode": 1
                  }
                }
              },
              {
                "task": {
                  "id": "87024b8b",
                  "signature": "[\"tsc\",\"src/b.ts\",\"TS2322\"]",
                  "files": [
                    "src/b.ts"
                  ],
                  "failures": [
                    {
                      "file": "src/b.ts",
                      "line": 1,
                      "column": 14,
                      "ruleId": "TS2322",
                      "message": "Type 'number' is not assignable to type 'string'.",
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
                "branch": "cq/static-fixture/static-1/scratch-repo",
                "commits": [
                  "f662ca9c1012d93cf5d298a0cfbe71e4233d41c0"
                ],
                "validation": {
                  "verdict": "pass",
                  "gates": [
                    {
                      "gate": "related",
                      "verdict": "pass",
                      "wallMs": 350
                    },
                    {
                      "gate": "broader",
                      "verdict": "pass",
                      "wallMs": 0,
                      "detail": "reused full related check from the base-owned staged tree"
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
                    "tool": "tsc",
                    "failures": [],
                    "exitCode": 0
                  }
                }
              }
            ],
            "budgetStopped": false
          }
        },
        "report": {
          "package": "scratch-repo",
          "fixer": "static-1",
          "worktree": {
            "path": "<fixture>/journal/worktrees/static-1/scratch-repo",
            "branch": "cq/static-fixture/static-1/scratch-repo",
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
              "tool": "tsc",
              "failures": [
                {
                  "file": "src/a.ts",
                  "line": 1,
                  "column": 14,
                  "ruleId": "TS2322",
                  "message": "Type 'number' is not assignable to type 'string'.",
                  "severity": "error"
                },
                {
                  "file": "src/a.ts",
                  "line": 2,
                  "column": 26,
                  "ruleId": "TS2339",
                  "message": "Property 'missing' does not exist on type 'string'.",
                  "severity": "error"
                },
                {
                  "file": "src/b.ts",
                  "line": 1,
                  "column": 14,
                  "ruleId": "TS2322",
                  "message": "Type 'number' is not assignable to type 'string'.",
                  "severity": "error"
                }
              ],
              "exitCode": 1
            }
          },
          "final": {
            "verdict": "clean",
            "attempts": 1,
            "failureSet": {
              "tool": "tsc",
              "failures": [],
              "exitCode": 0
            }
          },
          "prBranch": "cq/static-fixture/static-1/scratch-repo",
          "committed": true,
          "committedSha": "f662ca9c1012d93cf5d298a0cfbe71e4233d41c0",
          "pushed": false,
          "tasks": [
            {
              "task": {
                "id": "a685192a",
                "signature": "[\"tsc\",\"src/a.ts\",\"TS2322\"]",
                "files": [
                  "src/a.ts"
                ],
                "failures": [
                  {
                    "file": "src/a.ts",
                    "line": 1,
                    "column": 14,
                    "ruleId": "TS2322",
                    "message": "Type 'number' is not assignable to type 'string'.",
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
              "branch": "cq/static-fixture/static-1/scratch-repo",
              "commits": [
                "7be46f0937886d3da133c1a937d23d72d41850c9"
              ],
              "validation": {
                "verdict": "pass",
                "gates": [
                  {
                    "gate": "related",
                    "verdict": "pass",
                    "wallMs": 380
                  },
                  {
                    "gate": "broader",
                    "verdict": "pass",
                    "wallMs": 0,
                    "detail": "reused full related check from the base-owned staged tree"
                  },
                  {
                    "gate": "paths",
                    "verdict": "pass",
                    "wallMs": 0
                  },
                  {
                    "gate": "tamper",
                    "verdict": "pass",
                    "wallMs": 1
                  },
                  {
                    "gate": "commit",
                    "verdict": "pass",
                    "wallMs": 1
                  }
                ],
                "final": {
                  "tool": "tsc",
                  "failures": [
                    {
                      "file": "src/a.ts",
                      "line": 2,
                      "column": 26,
                      "ruleId": "TS2339",
                      "message": "Property 'missing' does not exist on type 'string'.",
                      "severity": "error"
                    },
                    {
                      "file": "src/b.ts",
                      "line": 1,
                      "column": 14,
                      "ruleId": "TS2322",
                      "message": "Type 'number' is not assignable to type 'string'.",
                      "severity": "error"
                    }
                  ],
                  "exitCode": 1
                }
              }
            },
            {
              "task": {
                "id": "f71910e2",
                "signature": "[\"tsc\",\"src/a.ts\",\"TS2339\"]",
                "files": [
                  "src/a.ts"
                ],
                "failures": [
                  {
                    "file": "src/a.ts",
                    "line": 2,
                    "column": 26,
                    "ruleId": "TS2339",
                    "message": "Property 'missing' does not exist on type 'string'.",
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
              "branch": "cq/static-fixture/static-1/scratch-repo",
              "commits": [
                "35fb2ad8af0a721dfb36781a6b68d7e9ec758b1c"
              ],
              "validation": {
                "verdict": "pass",
                "gates": [
                  {
                    "gate": "related",
                    "verdict": "pass",
                    "wallMs": 339
                  },
                  {
                    "gate": "broader",
                    "verdict": "pass",
                    "wallMs": 0,
                    "detail": "reused full related check from the base-owned staged tree"
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
                  "tool": "tsc",
                  "failures": [
                    {
                      "file": "src/b.ts",
                      "line": 1,
                      "column": 14,
                      "ruleId": "TS2322",
                      "message": "Type 'number' is not assignable to type 'string'.",
                      "severity": "error"
                    }
                  ],
                  "exitCode": 1
                }
              }
            },
            {
              "task": {
                "id": "87024b8b",
                "signature": "[\"tsc\",\"src/b.ts\",\"TS2322\"]",
                "files": [
                  "src/b.ts"
                ],
                "failures": [
                  {
                    "file": "src/b.ts",
                    "line": 1,
                    "column": 14,
                    "ruleId": "TS2322",
                    "message": "Type 'number' is not assignable to type 'string'.",
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
              "branch": "cq/static-fixture/static-1/scratch-repo",
              "commits": [
                "f662ca9c1012d93cf5d298a0cfbe71e4233d41c0"
              ],
              "validation": {
                "verdict": "pass",
                "gates": [
                  {
                    "gate": "related",
                    "verdict": "pass",
                    "wallMs": 350
                  },
                  {
                    "gate": "broader",
                    "verdict": "pass",
                    "wallMs": 0,
                    "detail": "reused full related check from the base-owned staged tree"
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
                  "tool": "tsc",
                  "failures": [],
                  "exitCode": 0
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
          "id": "a685192a",
          "signature": "[\"tsc\",\"src/a.ts\",\"TS2322\"]",
          "files": [
            "src/a.ts"
          ],
          "failures": [
            {
              "file": "src/a.ts",
              "line": 1,
              "column": 14,
              "ruleId": "TS2322",
              "message": "Type 'number' is not assignable to type 'string'.",
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
        "branch": "cq/static-fixture/static-1/scratch-repo",
        "commits": [
          "7be46f0937886d3da133c1a937d23d72d41850c9"
        ],
        "validation": {
          "verdict": "pass",
          "gates": [
            {
              "gate": "related",
              "verdict": "pass",
              "wallMs": 380
            },
            {
              "gate": "broader",
              "verdict": "pass",
              "wallMs": 0,
              "detail": "reused full related check from the base-owned staged tree"
            },
            {
              "gate": "paths",
              "verdict": "pass",
              "wallMs": 0
            },
            {
              "gate": "tamper",
              "verdict": "pass",
              "wallMs": 1
            },
            {
              "gate": "commit",
              "verdict": "pass",
              "wallMs": 1
            }
          ],
          "final": {
            "tool": "tsc",
            "failures": [
              {
                "file": "src/a.ts",
                "line": 2,
                "column": 26,
                "ruleId": "TS2339",
                "message": "Property 'missing' does not exist on type 'string'.",
                "severity": "error"
              },
              {
                "file": "src/b.ts",
                "line": 1,
                "column": 14,
                "ruleId": "TS2322",
                "message": "Type 'number' is not assignable to type 'string'.",
                "severity": "error"
              }
            ],
            "exitCode": 1
          }
        }
      },
      {
        "task": {
          "id": "f71910e2",
          "signature": "[\"tsc\",\"src/a.ts\",\"TS2339\"]",
          "files": [
            "src/a.ts"
          ],
          "failures": [
            {
              "file": "src/a.ts",
              "line": 2,
              "column": 26,
              "ruleId": "TS2339",
              "message": "Property 'missing' does not exist on type 'string'.",
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
        "branch": "cq/static-fixture/static-1/scratch-repo",
        "commits": [
          "35fb2ad8af0a721dfb36781a6b68d7e9ec758b1c"
        ],
        "validation": {
          "verdict": "pass",
          "gates": [
            {
              "gate": "related",
              "verdict": "pass",
              "wallMs": 339
            },
            {
              "gate": "broader",
              "verdict": "pass",
              "wallMs": 0,
              "detail": "reused full related check from the base-owned staged tree"
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
            "tool": "tsc",
            "failures": [
              {
                "file": "src/b.ts",
                "line": 1,
                "column": 14,
                "ruleId": "TS2322",
                "message": "Type 'number' is not assignable to type 'string'.",
                "severity": "error"
              }
            ],
            "exitCode": 1
          }
        }
      },
      {
        "task": {
          "id": "87024b8b",
          "signature": "[\"tsc\",\"src/b.ts\",\"TS2322\"]",
          "files": [
            "src/b.ts"
          ],
          "failures": [
            {
              "file": "src/b.ts",
              "line": 1,
              "column": 14,
              "ruleId": "TS2322",
              "message": "Type 'number' is not assignable to type 'string'.",
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
        "branch": "cq/static-fixture/static-1/scratch-repo",
        "commits": [
          "f662ca9c1012d93cf5d298a0cfbe71e4233d41c0"
        ],
        "validation": {
          "verdict": "pass",
          "gates": [
            {
              "gate": "related",
              "verdict": "pass",
              "wallMs": 350
            },
            {
              "gate": "broader",
              "verdict": "pass",
              "wallMs": 0,
              "detail": "reused full related check from the base-owned staged tree"
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
            "tool": "tsc",
            "failures": [],
            "exitCode": 0
          }
        }
      }
    ],
    "fixesPerRun": 3,
    "usage": {
      "input": 6,
      "output": 6,
      "cacheRead": 0,
      "cacheWrite": 0
    },
    "wallMs": 3130,
    "run": {
      "runId": "fix-run--mvls4ja5--5e9bb758",
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
                  "id": "sweep-scratch-repo-static-1",
                  "op": "sweep.unit",
                  "input": {
                    "package": "scratch-repo",
                    "fixer": "static-1",
                    "files": []
                  },
                  "dependsOn": []
                }
              ],
              "units": [
                {
                  "package": "scratch-repo",
                  "fixer": "static-1",
                  "files": []
                }
              ],
              "suppressed": [],
              "needsHuman": []
            }
          }
        },
        {
          "jobId": "sweep-scratch-repo-static-1",
          "op": "sweep.unit",
          "result": {
            "status": "ok",
            "value": {
              "package": "scratch-repo",
              "fixer": "static-1",
              "worktree": {
                "path": "<fixture>/journal/worktrees/static-1/scratch-repo",
                "branch": "cq/static-fixture/static-1/scratch-repo",
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
                  "tool": "tsc",
                  "failures": [
                    {
                      "file": "src/a.ts",
                      "line": 1,
                      "column": 14,
                      "ruleId": "TS2322",
                      "message": "Type 'number' is not assignable to type 'string'.",
                      "severity": "error"
                    },
                    {
                      "file": "src/a.ts",
                      "line": 2,
                      "column": 26,
                      "ruleId": "TS2339",
                      "message": "Property 'missing' does not exist on type 'string'.",
                      "severity": "error"
                    },
                    {
                      "file": "src/b.ts",
                      "line": 1,
                      "column": 14,
                      "ruleId": "TS2322",
                      "message": "Type 'number' is not assignable to type 'string'.",
                      "severity": "error"
                    }
                  ],
                  "exitCode": 1
                }
              },
              "final": {
                "verdict": "clean",
                "attempts": 1,
                "failureSet": {
                  "tool": "tsc",
                  "failures": [],
                  "exitCode": 0
                }
              },
              "prBranch": "cq/static-fixture/static-1/scratch-repo",
              "committed": true,
              "committedSha": "f662ca9c1012d93cf5d298a0cfbe71e4233d41c0",
              "pushed": false,
              "tasks": [
                {
                  "task": {
                    "id": "a685192a",
                    "signature": "[\"tsc\",\"src/a.ts\",\"TS2322\"]",
                    "files": [
                      "src/a.ts"
                    ],
                    "failures": [
                      {
                        "file": "src/a.ts",
                        "line": 1,
                        "column": 14,
                        "ruleId": "TS2322",
                        "message": "Type 'number' is not assignable to type 'string'.",
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
                  "branch": "cq/static-fixture/static-1/scratch-repo",
                  "commits": [
                    "7be46f0937886d3da133c1a937d23d72d41850c9"
                  ],
                  "validation": {
                    "verdict": "pass",
                    "gates": [
                      {
                        "gate": "related",
                        "verdict": "pass",
                        "wallMs": 380
                      },
                      {
                        "gate": "broader",
                        "verdict": "pass",
                        "wallMs": 0,
                        "detail": "reused full related check from the base-owned staged tree"
                      },
                      {
                        "gate": "paths",
                        "verdict": "pass",
                        "wallMs": 0
                      },
                      {
                        "gate": "tamper",
                        "verdict": "pass",
                        "wallMs": 1
                      },
                      {
                        "gate": "commit",
                        "verdict": "pass",
                        "wallMs": 1
                      }
                    ],
                    "final": {
                      "tool": "tsc",
                      "failures": [
                        {
                          "file": "src/a.ts",
                          "line": 2,
                          "column": 26,
                          "ruleId": "TS2339",
                          "message": "Property 'missing' does not exist on type 'string'.",
                          "severity": "error"
                        },
                        {
                          "file": "src/b.ts",
                          "line": 1,
                          "column": 14,
                          "ruleId": "TS2322",
                          "message": "Type 'number' is not assignable to type 'string'.",
                          "severity": "error"
                        }
                      ],
                      "exitCode": 1
                    }
                  }
                },
                {
                  "task": {
                    "id": "f71910e2",
                    "signature": "[\"tsc\",\"src/a.ts\",\"TS2339\"]",
                    "files": [
                      "src/a.ts"
                    ],
                    "failures": [
                      {
                        "file": "src/a.ts",
                        "line": 2,
                        "column": 26,
                        "ruleId": "TS2339",
                        "message": "Property 'missing' does not exist on type 'string'.",
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
                  "branch": "cq/static-fixture/static-1/scratch-repo",
                  "commits": [
                    "35fb2ad8af0a721dfb36781a6b68d7e9ec758b1c"
                  ],
                  "validation": {
                    "verdict": "pass",
                    "gates": [
                      {
                        "gate": "related",
                        "verdict": "pass",
                        "wallMs": 339
                      },
                      {
                        "gate": "broader",
                        "verdict": "pass",
                        "wallMs": 0,
                        "detail": "reused full related check from the base-owned staged tree"
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
                      "tool": "tsc",
                      "failures": [
                        {
                          "file": "src/b.ts",
                          "line": 1,
                          "column": 14,
                          "ruleId": "TS2322",
                          "message": "Type 'number' is not assignable to type 'string'.",
                          "severity": "error"
                        }
                      ],
                      "exitCode": 1
                    }
                  }
                },
                {
                  "task": {
                    "id": "87024b8b",
                    "signature": "[\"tsc\",\"src/b.ts\",\"TS2322\"]",
                    "files": [
                      "src/b.ts"
                    ],
                    "failures": [
                      {
                        "file": "src/b.ts",
                        "line": 1,
                        "column": 14,
                        "ruleId": "TS2322",
                        "message": "Type 'number' is not assignable to type 'string'.",
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
                  "branch": "cq/static-fixture/static-1/scratch-repo",
                  "commits": [
                    "f662ca9c1012d93cf5d298a0cfbe71e4233d41c0"
                  ],
                  "validation": {
                    "verdict": "pass",
                    "gates": [
                      {
                        "gate": "related",
                        "verdict": "pass",
                        "wallMs": 350
                      },
                      {
                        "gate": "broader",
                        "verdict": "pass",
                        "wallMs": 0,
                        "detail": "reused full related check from the base-owned staged tree"
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
                      "tool": "tsc",
                      "failures": [],
                      "exitCode": 0
                    }
                  }
                }
              ],
              "budgetStopped": false
            }
          },
          "usage": {
            "input": 6,
            "output": 6,
            "cacheRead": 0,
            "cacheWrite": 0
          }
        }
      ],
      "usage": {
        "input": 6,
        "output": 6,
        "cacheRead": 0,
        "cacheWrite": 0
      }
    }
  }
}
```
