# Regression specification: unset sandbox policy must not relax the run gate

This is a required follow-up test at the sandbox integration handoff. It is
deliberately a specification only: B10 does not own `src/sandbox/index.ts`
or the shared sandbox tests.

Given a process with no `CQ_SANDBOX` value and no explicit per-call opt-in,
`harnessRunGate()` must resolve the conservative `required` posture and must
not return `enabled: true` through the historical unset-env relaxation.
The absent certified launcher must still withhold `run`. The regression
must also preserve the explicit trusted `CQ_SANDBOX=off` case and prove that
an untrusted plan/op/workspace value cannot supply that relaxation.
