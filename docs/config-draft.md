# Configuration draft (B10 / RS-15)

This draft describes the initial pure resolver slice. It is not yet wired into
CLI, runner, workflow templates, or journal provenance.

Configuration precedence is built-in conservative defaults, then the
project environment (optionally seeded by the installed `solo-maintainer`
profile), then explicit per-call values. Explicit environment keys override
profile values. Unset, empty, and whitespace-only values mean “this layer
sets nothing.” `CQ_PROFILE` accepts `conservative` or `solo-maintainer`.

Unknown `CQ_*` names fail resolution. A per-call value that relaxes a policy
requires an opt-in naming that exact key; there are no wildcard opt-ins.
Plan JSON, operation input, and workspace files are not configuration
sources. Secret handling, the complete RS-15 key registry, generated workflow
mapping, and journal output remain integration work.

| Key | Built-in | solo-maintainer | Per-call id | Policy direction |
|---|---|---|---|---|
| `CQ_SANDBOX` | `required` | `off` | `sandbox` | `required` is tighter |
| `CQ_SANDBOX_BACKEND` | `auto` | — | `sandbox.backend` | unordered; change needs opt-in |
| `CQ_SANDBOX_NETWORK` | `model-only` | `allow` | `sandbox.network` | `model-only` is tighter |
| `CQ_RUN_TOOL` | `on` | — | `run.tool` | `off` is tighter |
| `CQ_RUN_ENV_PASSTHROUGH` | empty list | — | `run.envPassthrough` | unordered; change needs opt-in |

Blank list values fall through. The literal `none` explicitly clears a list;
empty items are invalid.
