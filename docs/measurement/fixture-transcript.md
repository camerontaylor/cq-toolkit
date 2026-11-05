# Offline fixture transcript (M11-fixture)

**This transcript is SYNTHETIC.** The committed fixture at
`test/fixtures/measurement/transcript.json` is generated evidence — fake
drivers (`fake/worker`, `fake/rescue`), fixed timestamps and seeded local
repositories. It is not a live dogfood run, and it claims **no completed
30-day collection**: the 30-day archive-complete window is a transport
concern ([archive install](archive-install.md)), not something a committed
fixture can assert.

`test/measurement-transcript.test.ts` replays the fixture offline through the
merged ADR-0008 vocabulary only — the composition observation writer/reader
(`openObservationWriter` / `readObservations`), the fixed stop-code table
(`STOP_CODE_CLASS`, `finishAttempt`) and the M10c/M10e panels
(`computeMeasurementPanels`, `computeOutcomePanels`). No live providers, no
network, no credentials.

## The two fake-driver composition transcripts (F and R)

These reproduce the illustrative transcripts of the measurement plan
(toolkit-research `measurement-plan.md`, "Fixture transcript to implement") in
the merged field names:

**fix.run fixture F** — planned units A (baseline 3), B (baseline 2, unit
later bailed), C (unknown: cancelled before its probe).

| Plan transcript line                                                                                                           | Merged vocabulary                                                                                                                          | Asserted result                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `A/t1 worker attempt 1: fake/worker tokens=120 wall=50ms stop=step-timeout class=infrastructure cause=TimeoutError scope=step` | `attempt-finished`: `stopCode: transport`, `class: infrastructure`, `error.type: TimeoutError` (certainty observed), `timeout.scope: step` | classifies as cause `timeout`                                                                                                                                         |
| `A/t1 rescue attempt 2: fake/rescue tokens=80 wall=30ms -> verified commit c1`                                                 | `attempt-finished` `stopCode: completed`; closure row `c1` (non-todo)                                                                      | `fixesPerRun.numerator = 1`                                                                                                                                           |
| `A/t2 resolved by c1`                                                                                                          | one closure row with `taskIds: [t1, t2]`                                                                                                   | one commit closing two tasks counts once                                                                                                                              |
| `failed retained commit f1 excluded; todo commit excluded`                                                                     | f1 never becomes a closure (fixed + validated is the closure rule); the todo commit is a closure with `todo: true`                         | `verifiedCommits = [c1]`                                                                                                                                              |
| `fixesPerRun=1; baselineFailures known=5 unknownUnits=1; ratio=unknown`                                                        | C's `count: null` with `unknownReason`                                                                                                     | `denominator = null` (subtotal 5 withheld); the fix panel is per-run only — there is no ratio to print, so a known-zero baseline cannot yield an infinite rate either |

**review.address fixture R** — blocking findings a, b, c reviewed at h1 over
`src/a.ts:1-20`; re-review at h2 over `src/a.ts:1-25`.

| Plan transcript line                                                                                                      | Merged vocabulary                                                       | Asserted result                                                                          |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `a: worker -> verified commit c2`                                                                                         | closure row `c2` linked to finding a                                    | review `fixesPerRun = 1/3`                                                               |
| `b: rejected owner=fixture reason=contradicted evidence=requirement:r1`                                                   | `finding-disposition` status `rejected`                                 | terminal: b leaves the open population                                                   |
| `c: deferred owner=fixture reason=needs-domain-input evidence=discussion:d1 trigger=domain-answer; remains open blocking` | `finding-disposition` status `deferred`, `reviewTrigger: domain-answer` | deferred stays open (`latestOpenBlocking = 1` of `initialOpenBlocking = 3`)              |
| `attempt on c: EAI_AGAIN class=infrastructure (not itself a deferral)`                                                    | `attempt-finished` `stopCode: dns`, `class: infrastructure`             | no attempt carries class `human`; deferrals exist only as deliberate disposition records |
| `independent acceptance: reviewer=fixture-critic head=h1 evidence=acceptance:a1`                                          | `head-acceptance`: independent PASS at h1                               | exactly h1 is eligible and mature                                                        |
| `re-review h2 coverage=src/a.ts:1-25; h1 acceptance not credited to h2`                                                   | `review-observed` round 2 at h2                                         | h2 is unknown (no acceptance at that head)                                               |
| `rounds/exposures=2`                                                                                                      | review rounds 1 and 2 observed                                          | two `review-observed` rounds                                                             |

## RP01 regression reconstruction (synthetic)

The `rp01Regression` block is a **synthetic reconstruction**: 129 synthetic
cause-bearing attempts — timeout 41, DNS 29, model 47, unknown 12 — expanded
deterministically from per-cause templates into one composition observation
stream. Classification is reconstructed **from journal lines alone** (the
stable stop code through the merged `STOP_CODE_CLASS` table, never prose,
never elapsed wall), with **no session archive**: none exists in the fixture
and the reader never consults one. The tests delete any persisted reports
before the classification assertion, so report mirroring is never load-bearing
for it. A torn final line classifies only the surviving prefix and marks the
stream incomplete; a complete-but-unparsable line is refused as corruption.

## Imported historical RP01 rows

The `rp01Historical` block records the historical import's counts — 21
probable timeouts, 9 probable outages (certainty `inferred`), 6 unrecoverable
rows (no cause evidence; certainty `unknown`) — as they were recorded. **New
instrumentation cannot recover old lost causes:** probable stays `inferred`,
unrecoverable stays `unknown`, and no row is ever upgraded to `observed`
certainty, however often the classification re-runs.

## Scope notes

- Idempotent repeated import (duplicate/conflict admission) and the
  failed-report-write → unavailable-artifact behavior are covered by the M10b
  reader tests; this fixture reuses their admission semantics.
- Known-zero baselines, per-run-only denominators and unknown-never-zero cost
  totals are covered by the M10c panel tests; the fixture exercises them
  through the same panel entry points.
- The transcript fixture is a committed reader artifact. It is never a runtime
  engine input, and nothing here adds a check, lock, approval or role.
