# fix.run tests fixture transcript

Captured by the fresh-fixture scripted-driver acceptance test. Real git, offline checks, no provider calls.

Equivalent CLI input: `cq fix.run --source=tests --selector='{"mode":"workspace-all"}' --json` with fixture repoRoot and journalDir. The SDK factory injects the scripted agent; the production registry uses the configured driver factory.

```json
{
  "status": "ok",
  "report": {
    "source": "tests",
    "runPrefix": "cq/fixture",
    "reportPath": "<fixture>/journal/fix-run-report-e0324b80-ab3b-4790-bdc3-35354c121559.json",
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
            "wallMs": 60,
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
            "wallMs": 57,
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
          "21aa8371a55adb79bede99b542cbcf3e1da80a62"
        ],
        "validation": {
          "verdict": "pass",
          "gates": [
            {
              "gate": "related",
              "verdict": "pass",
              "wallMs": 182
            },
            {
              "gate": "broader",
              "verdict": "pass",
              "wallMs": 403
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
            "wallMs": 4,
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
            "wallMs": 8,
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
          "3058b4e684cadf5c6e1c5b95ffa315e5c2917853"
        ],
        "validation": {
          "verdict": "pass",
          "gates": [
            {
              "gate": "related",
              "verdict": "pass",
              "wallMs": 302
            },
            {
              "gate": "broader",
              "verdict": "pass",
              "wallMs": 232
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
    "wallMs": 4232
  }
}
```
