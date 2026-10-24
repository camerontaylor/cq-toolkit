# fix.run tests fixture transcript

Captured by the fresh-fixture scripted-driver acceptance test. Real git, offline checks, no provider calls.

Equivalent CLI input: `cq fix.run --source=tests --selector='{"mode":"workspace-all"}' --json` with fixture repoRoot and journalDir. The SDK factory injects the scripted agent; the production registry uses the configured driver factory.

```json
{
  "status": "ok",
  "value": {
    "source": "tests",
    "runPrefix": "cq/fixture",
    "reportPath": "<fixture>/journal/fix-run-report-e20f78d6-ff2a-40bd-b5db-20e81b3d9fea.json",
    "verdict": "pass",
    "units": [
      {
        "jobId": "sweep-scratch-repo-tests-1",
        "result": {
          "status": "ok"
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
          "305356dd3c5cede6a3e71cd4f28c4b025e5ab6e7"
        ],
        "validation": {
          "verdict": "pass",
          "gates": [
            {
              "gate": "related",
              "verdict": "pass",
              "wallMs": 45
            },
            {
              "gate": "broader",
              "verdict": "pass",
              "wallMs": 54
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
          "76725c5394938bc6814962467f87834a7d945ee0"
        ],
        "validation": {
          "verdict": "pass",
          "gates": [
            {
              "gate": "related",
              "verdict": "pass",
              "wallMs": 46
            },
            {
              "gate": "broader",
              "verdict": "pass",
              "wallMs": 61
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
              "wallMs": 1
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
    "wallMs": 2681
  }
}
```
