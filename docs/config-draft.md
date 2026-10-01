# Configuration draft (B10 / RS-15)

This draft describes the pure RS-15 Annex B registry and resolver. It is not
yet wired into CLI, runner, workflow templates, or journal provenance.

Configuration precedence is built-in conservative defaults, then the
project environment (optionally seeded by the installed `solo-maintainer`
profile), then explicit per-call values. Explicit environment keys override
profile values. Unset, empty, and whitespace-only values mean “this layer
sets nothing.” `CQ_PROFILE` accepts `conservative` or `solo-maintainer`.

Unknown `CQ_*` names fail resolution with a nearest-key hint when available.
A per-call value that relaxes a policy requires an opt-in naming that exact
key; there are no wildcard opt-ins. `optIn` accepts an exact id or
`<id>=<value>`, and a disagreeing typed value is rejected. Maps and served
aliases merge by entry. List duplicates and empty items fail; `none` is the
explicit empty-list value. Plan JSON, operation input, and workspace files
are not configuration sources.

The registry includes all static RS-15 Annex B keys and the dynamic
`CQ_PROVIDER_<ID>_<KEY>` family for bundled profiles. A custom provider id is
known only when its `PROFILE` value declares `custom:<absolute-path>`. Secret
keys are held as presence only, foreign credential names are held as
`set`, and `CQ_APPROVAL_KEY*` plus the reserved sandbox proxy key fail closed.
Call-only governance inputs are represented separately and have no env
mirror.

| Key                      | Built-in     | solo-maintainer | Per-call id          | Policy direction               |
| ------------------------ | ------------ | --------------- | -------------------- | ------------------------------ |
| `CQ_SANDBOX`             | `required`   | `off`           | `sandbox`            | `required` is tighter          |
| `CQ_SANDBOX_BACKEND`     | `auto`       | —               | `sandbox.backend`    | unordered; change needs opt-in |
| `CQ_SANDBOX_NETWORK`     | `model-only` | `allow`         | `sandbox.network`    | `model-only` is tighter        |
| `CQ_RUN_TOOL`            | `on`         | —               | `run.tool`           | `off` is tighter               |
| `CQ_RUN_ENV_PASSTHROUGH` | empty list   | —               | `run.envPassthrough` | unordered; change needs opt-in |

Blank list values fall through. The literal `none` explicitly clears a list;
with a selected profile, blank values fall through to the profile. The
`conservative` profile seeds only the built-in values. `solo-maintainer`
currently seeds merge acceptance, protected-path posture, sandbox, network,
and driver binding values shown in `policy/profiles/solo-maintainer.env`.

The caller must still enforce workspace containment for paths marked
`outsideWorkspace`, load profile files from the installed package, and attach
the returned record to journal provenance. This module does not read files or
process environment by itself.
