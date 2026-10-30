# R4C CLI closure demonstration

Observed on triton, 2026-10-31. This is **production CLI dispatch and op execution
with a scripted fixer**, not a real model invocation. Git objects and packet
assembly are real. No network/provider calls were made.

Both invocations used:

```sh
node --experimental-transform-types --import /tmp/r4c-loader.mjs \
  test/fixtures/review-closure-cli/entry.mjs review.address \
  --source=local --repoRoot=<temporary-fixture> --verifyClosure \
  --rounds=1 --journalDir=<external-journal> --json
```

The temporary loader maps this checkout’s dist `.js` imports to source `.ts`
imports, excluding node_modules; no build ran. With built dist, omit the two
experimental/import options. Each temporary repository has branch feature/demo,
a committed a.ts, and origin/merge-queue pinned to the starting commit.

The scripted fixer replaces a.ts with `export const value = "GOOD";` and
commits it. The fixture refuses any attempt to persist a fixed disposition.
CLI exit code was **3** for each invocation. Selected fields from actual JSON:

## Surviving declaration

```json
{
  "status": "needs-human",
  "findingStatus": "open",
  "packet": {
    "finding": {
      "id": "demo",
      "source": "agent",
      "file": "a.ts",
      "severity": "major",
      "text": "Replace `BAD` in a.ts",
      "status": "fixed"
    },
    "task": "Replace `BAD` in a.ts",
    "patch": "diff --git a/a.ts b/a.ts\nindex d4a253e..56b558a 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-export const value = \"BAD\";\n+export const value = \"GOOD\";\n",
    "before": "export const value = \"BAD\";\n",
    "after": "export const value = \"GOOD\";\n",
    "dependencies": [],
    "relevantDependenciesComplete": false,
    "metadata": {
      "revision": {
        "head": "ee43eeb56a2f4df03cdf2c3478e14be695b8492e",
        "parent": "8236493dac60f09979b1cae78cc41dec35fc9e13"
      }
    }
  },
  "verification": {
    "verdict": "unresolved",
    "reason": "deleted-trigger-survives",
    "checks": [
      {
        "check": "packet-complete",
        "outcome": "pass",
        "detail": "packet fields present; 0 dependencies captured"
      },
      {
        "check": "revision-pinned",
        "outcome": "pass",
        "detail": "revision pinned at ee43eeb56a2f4df03cdf2c3478e14be695b8492e"
      },
      {
        "check": "patch-coherent",
        "outcome": "pass",
        "detail": "patch coherent: +1/-1 on a.ts"
      },
      {
        "check": "trigger-removed",
        "outcome": "fail",
        "detail": "removed declaration re-declared in after content: value",
        "reason": "deleted-trigger-survives"
      }
    ],
    "revision": {
      "head": "ee43eeb56a2f4df03cdf2c3478e14be695b8492e",
      "parent": "8236493dac60f09979b1cae78cc41dec35fc9e13"
    }
  }
}
```

## Unattested dependencies

```json
{
  "status": "needs-human",
  "findingStatus": "open",
  "packet": {
    "finding": {
      "id": "demo",
      "source": "agent",
      "file": "a.ts",
      "severity": "major",
      "text": "Replace `BAD` in a.ts",
      "status": "fixed"
    },
    "task": "Replace `BAD` in a.ts",
    "patch": "diff --git a/a.ts b/a.ts\nindex 9b00c6c..56b558a 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-throw new Error(\"BAD\");\n+export const value = \"GOOD\";\n",
    "before": "throw new Error(\"BAD\");\n",
    "after": "export const value = \"GOOD\";\n",
    "dependencies": [],
    "relevantDependenciesComplete": false,
    "metadata": {
      "revision": {
        "head": "f5e5f494aa6511f0f26e622f376498f098afbaab",
        "parent": "914ee4e71a01429a6aa25a7a14b70ad87905a5f8"
      }
    }
  },
  "verification": {
    "verdict": "uncertain",
    "reason": "omitted-consumer-or-dependency",
    "checks": [
      {
        "check": "packet-complete",
        "outcome": "pass",
        "detail": "packet fields present; 0 dependencies captured"
      },
      {
        "check": "revision-pinned",
        "outcome": "pass",
        "detail": "revision pinned at f5e5f494aa6511f0f26e622f376498f098afbaab"
      },
      {
        "check": "patch-coherent",
        "outcome": "pass",
        "detail": "patch coherent: +1/-1 on a.ts"
      },
      {
        "check": "trigger-removed",
        "outcome": "pass",
        "detail": "no survival of 1 quoted spans, 0 removed declarations"
      },
      {
        "check": "dependencies-covered",
        "outcome": "unavailable",
        "detail": "relevant consumer/dependency completeness is not attested for the changed surface",
        "reason": "omitted-consumer-or-dependency"
      }
    ],
    "revision": {
      "head": "f5e5f494aa6511f0f26e622f376498f098afbaab",
      "parent": "914ee4e71a01429a6aa25a7a14b70ad87905a5f8"
    }
  }
}
```

The first invocation reached trigger removal and found declaration `value`
re-declared in the after snapshot. The second removed `throw new Error("BAD");`
and reached dependency coverage. Neither finding closed. The second packet
explicitly records an empty dependency list and false completeness attestation.
