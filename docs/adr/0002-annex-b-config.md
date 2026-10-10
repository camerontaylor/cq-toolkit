# ADR-0002 Annex B — Configuration keys

- **Status:** accepted (G1, 2026-09-26)
- **Date:** 2026-09-25
- **Amends / Related:** [ADR-0002](0002-worker-driver-seam-v2.md), [ADR-0003](0003-governed-runner.md), the
  [approval-token annex](0003-approval-token.md), the [journal annex](0003-journal-migration.md),
  [ADR-0004](0004-policy-check-trust-boundaries.md)

Post-acceptance notes N3, N4 and N15 in the [ADR index](README.md#post-acceptance-notes) narrow parts of this record.

This annex fills ADR-0002's Annex B. It also defines the configuration keys ADR-0003 refers to. Neither ADR's main
text changes.

**Decision:**

- **Namespace.** One strict namespace, `CQ_<DOMAIN>_<KEY>`: a closed set of domains plus one dynamic family,
  `CQ_PROVIDER_<ID>_<KEY>`. Each key is mechanically mirrored as a per-call id, `<domain>.<camelKey>`.
- **Precedence.** P7's three layers, **built-in → project env → per-call**, with the last one winning. The
  project-env layer may be seeded by a bundled profile (`CQ_PROFILE`); explicit `CQ_*` vars beat the profile.
  Blank means "this layer sets nothing", so with `CQ_PROFILE` blank every key resolves to its conservative value. A
  per-call value less conservative than the resolved value is refused unless its key is named in `optIn`. Config
  and opt-ins are **never** read from plan JSON, op input or workspace files.
- **Secrets.** A key is secret exactly when its name ends in one of the toolkit's existing secret suffixes
  ([src/driver/error-text.ts](../../src/driver/error-text.ts)). Secrets come from the env layer only, never from a
  profile, `vars.*`, argv, or a journal value. In CI they come from `secrets.*` of default-branch-only environments.

  > Narrowed: secrets are env-only; see post-acceptance note N4 in the [ADR index](README.md#post-acceptance-notes).

- **Non-secrets.** Every other key is non-secret: it comes from `vars.*` via a generated default-branch `env:`
  block, and is journalled with its value and layer.

---

## B.1 Scope — what gets a key

Every tunable the toolkit has gets exactly one disposition: **ENV**, **ENV-only**, **CALL**, **SDK**, **STRUCT**,
**FOREIGN** or **RENAME**. The rule that decides between ENV and SDK:

> A tunable gets a `CQ_*` key iff (a) a _project_ — not a call site — plausibly wants a different value, and
> (b) its value is plain data with a checkable conservative direction or no policy meaning.

So these stay **SDK** (code/SDK construction only; journalled as a marker in `sdk` when overridden, §B.7):

- measurement-derived constants (`DEFAULT_ABORT_GRACE_MS`, test-pinned to [DD-1](../dd-1-abort-spike.md), in
  [src/kernel/governor.config.ts](../../src/kernel/governor.config.ts));
- regex and decision-table data (merge `allClearPattern`/`skipPatterns`: an env regex is a ReDoS vector and an
  acceptance bypass). **Exception, today:** review `skipPatterns` is reachable from plan data through the
  `review.classifyThreads` op input ([src/ops/review/registry.ts](../../src/ops/review/registry.ts)). It is CALL,
  not SDK, and not a config key. It carries a P1 note: a plan-supplied pattern can suppress human feedback;
- callbacks (`pricing`, `jobKey`, `usdOf`, `sdkLoader`, `spawn`);
- pricing tables (a lower price is a silent undercount with no checkable direction, which would break the budget
  bound);
- protocol constants and prompt/size bounds.

And these are **STRUCT** (no key at any layer, P8): SHA binding, the trust-set filter, write-token separation,
env scrub at spawn, base-ref provenance, fork/draft/protected-head exclusion, the subprocess argv shape, session
store modes, protected-path matchers, and **the exclusion of automation identities from the trust set** (D2; §B.8.2).

**Surfaces that never carry config or opt-ins (normative).**

- Plan JSON, op input, and any file in the workspace under review are never sources of configuration or opt-ins.
  `optIn`, `attended` and `releaseQuarantine` are `Governance`/entry-point parameters (ADR-0003 §2.1), never plan
  data.
- **An op-input field that mirrors a registry key** is validated against the resolved value. On a key with no
  per-call layer (✗ in §B.8) any difference is refused (`config`); on other keys a difference is a per-call value
  under §B.4. Mirrors today: the merge registry's `protectedBranch`, the queue `baseBranch` of `RunMergePrsInput`, and
  `sessionsDir` (`merge.resolveConflict`; `sweep.unit`'s `driver.sessionsDir`). W3.6 may then delete them (§B.11).
- **Proposed adversarial-suite case** (the suite's config row is A19 in
  [docs/adversarial-suite.md](../adversarial-suite.md)): _a PR-produced plan or artifact consumed by a privileged
  job carries mirrored config fields and opt-in-shaped strings, and the job's resolved config and journal show no
  relaxation._

## B.2 Namespace grammar

1. **Form.** `CQ_<DOMAIN>_<KEY>`, `[A-Z0-9_]`, SCREAMING_SNAKE. `<DOMAIN>` is from the closed registry below.
   A domain's primary switch may be the bare domain (`CQ_SANDBOX`, `CQ_PROFILE`).
2. **Domains (closed):** `PROFILE`, `MERGE`, `REVIEW` (reserved, no v1.1 keys), `EXTERNAL`, `SANDBOX`, `RUN`,
   `BUDGET`, `GOVERNOR`, `APPROVAL`, `PROVIDER`, `DRIVER`, `JOURNAL`, `SELFHOST`, `GH`, `AUTOMATION`.
3. **One dynamic family:** `CQ_PROVIDER_<ID>_<KEY>`. `<ID>` is the provider profile id uppercased with `-` → `_`
   (`zai-glm-coding` → `ZAI_GLM_CODING`); there is no alias table. Profile ids (bundled and custom) are
   `[a-z0-9]+(-[a-z0-9]+)*`, so the reverse mapping (`_` → `-`, lowercase) is exact. Parsing matches the suffix
   against the closed provider-key set (longest first); the remaining prefix must be a known id: a bundled profile
   id, or one declared by its own `CQ_PROVIDER_<ID>_PROFILE=custom:<path>`.
   - Driver bindings are **not** a dynamic family (`WorkerRole` is an open string type, ADR-0002 §2.5, so
     `CQ_DRIVER_<ROLE>_*` names could not be typo-checked). They are one key, `CQ_DRIVER_BINDINGS` (§B.8.6).
4. **Per-call id** (the journal's entry key and, where a per-call layer exists, the `optIn` id): the domain
   lowercased, then `.`, then the key in lowerCamel: `CQ_MERGE_REQUIRE_HUMAN_APPROVAL` ↔
   `merge.requireHumanApproval`; bare `CQ_SANDBOX` ↔ `sandbox`. Provider ids are **journal-only**, since provider
   keys have no per-call layer (`CQ_PROVIDER_ZAI_GLM_CODING_PEAK_WINDOWS` ↔ `provider.zai-glm-coding.peakWindows`).
   The mapping is mechanical and generated. The only hand-written alias is the CLI sugar `--allow-advisory-budget`
   (≡ `--opt-in budget.allowAdvisory=true`).
5. **Strictness.** Any `CQ_*` name not in the registry fails the run before dispatch with exit 2 (usage/config;
   [src/cli/exit.ts](../../src/cli/exit.ts)). All errors are aggregated, each with the nearest known name. There is
   no escape hatch; an ignore-list would defeat typo detection. A **reserved** key (`CQ_SANDBOX_PROXY_URL` until
   W1.11) that is set also fails, with `reserved (W1.11): not yet honoured`; it is never silently ignored.
6. **The prefix is the toolkit's.** Consumers use their own prefix (cq-fixtures uses `CQFX_*`); toolkit test and
   drill variables use `CQTEST_*`. `CQ_APPROVAL_KEY*` is **reserved and denied**: no config key ever carries signing
   material or its path. `cq approve --key <path>` is the only input (the approval-token annex §3), so no CI mapping
   can hold minting capability.
7. **FOREIGN names are not renamed.** Vendor/tool names the toolkit reads (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
   `ZAI_API_KEY`, `DEEPSEEK_API_KEY`, `ZAI_BASE_URL`, `ZAI_ANTHROPIC_BASE_URL`, `DEEPSEEK_ANTHROPIC_BASE_URL`,
   `ANTHROPIC_BASE_URL`, `GH_REPO`, `PATH`) are registered as FOREIGN. They keep their names so vendor tooling and
   docs still work, and are validated where the toolkit can check (URL keys: `https://` only). They are
   journalled (§B.7): non-secret with their value, secret as presence only. Renaming them would double the secret
   surface for no gain.

## B.3 Types and value grammar

| Type      | Grammar                                                                                                  | Notes                                                                                                                                                                                                                                                                                                                     |
| --------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bool`    | `true` \| `false`                                                                                        | Lowercase only. `1`/`yes`/`on` are errors (typos fail loudly).                                                                                                                                                                                                                                                            |
| `int`     | decimal, no separators                                                                                   | Per-key bounds.                                                                                                                                                                                                                                                                                                           |
| `ms`      | `int`, key ends `_MS`                                                                                    | Milliseconds only; no unit suffixes. The key suffix carries the unit.                                                                                                                                                                                                                                                     |
| `usd`     | decimal ≥ 0, ≤ 6 dp, key ends `_USD`                                                                     |                                                                                                                                                                                                                                                                                                                           |
| `enum`    | one lowercase kebab value                                                                                | `APPROVED`-style GitHub enums keep GitHub's spelling.                                                                                                                                                                                                                                                                     |
| `list<T>` | comma-separated, items trimmed                                                                           | Empty items and duplicates are errors; set semantics unless stated. The literal `none` is legal only as the _sole_ item, on keys that list it.                                                                                                                                                                            |
| `map`     | comma-separated `<k>:<v>` entries; `<k>` and `<v>` are `[a-z0-9*/-]+`                                    | Used by `CQ_DRIVER_BINDINGS` and `WINDOW_FRACTIONS`. Role, provider and lane tokens are `[a-z0-9-]+` (or `*`). Anything else is a loud error, so an open-string role with `/`, `:` or `,` cannot be bound from env.                                                                                                       |
| `aliases` | comma-separated `<lane>/<provider>/<requested>=<served>[\|<served>…]`                                    | Only `CQ_DRIVER_SERVED_ALIASES`. Lane and provider split on the first two `/`. Model ids may contain `/` and `:` (e.g. `vendor/model`, `…-v2:0`, `x:8b`), so the separator is `=`, and model ids may not contain `=`, `,` or `\|`.                                                                                        |
| `model`   | `<provider>/<model>`                                                                                     | Split on the first `/` (the provider token is `[a-z0-9-]+`).                                                                                                                                                                                                                                                              |
| `path`    | absolute after resolution                                                                                | `realpath`'d at resolution. A key marked **outside-workspace** refuses any path under the workspace realpath, so a worker cannot plant or rewrite the file.                                                                                                                                                               |
| `url`     | `https://…`, **no userinfo, no query string** (a credential in a URL would be journalled with the value) | Some keys also require the host to match a bundled host.                                                                                                                                                                                                                                                                  |
| `argv`    | JSON array of non-empty strings                                                                          | `argv[0]` is a bare command resolved on `PATH`, or an absolute path. Never relative. Journalled through the existing redaction.                                                                                                                                                                                           |
| `window`  | **one** window in v1.1: `<Days> <HH:MM>-<HH:MM> <IANA tz>[; mult=<n>][; off=<n>]`                        | `<Days>` is `Mon`…`Sun`, a range `A-B`, or a `+`-joined set (`Sat+Sun`). An end before the start wraps past midnight. A zone, not a fixed offset: fixed offsets lose DST and cannot express `+05:30`. `off=` is the profile-global off-peak multiplier. Example: `Mon-Fri 14:00-18:00 Asia/Singapore; mult=1.0; off=0.5`. |

> Narrowed: `WINDOW_FRACTIONS` values are decimals, which the `map` grammar must admit; see post-acceptance note N3
> in the [ADR index](README.md#post-acceptance-notes).

**Blank** (unset, empty, or whitespace-only) means **this layer sets nothing**. Resolution falls through to the
lower layer: the profile if `CQ_PROFILE` selects one, else the built-in (conservative) value.

- The P8 invariant, stated precisely: **with `CQ_PROFILE` blank, every blank key resolves to its conservative
  value.**
- To clear a profile-set list value explicitly, use the literal `none` on keys that list it.
- `map`/`aliases` keys merge **per entry** across layers (built-in, profile, env, call): a later layer's entry for
  the same pair replaces the earlier one, and other pairs stand. Every other type replaces whole.

## B.4 Precedence and the relaxation rule

```
built-in default  →  project env (CQ_*, optionally seeded by the bundled profile CQ_PROFILE)  →  per call
                                                              last one wins, subject to the rules below
```

1. **Profile = a seed inside the project-env layer.** P7's three layers are unchanged.
   `CQ_PROFILE ∈ {conservative, solo-maintainer}` (blank ≡ `conservative`) expands to that profile's key values; an
   explicit `CQ_*` beats the profile's value for the same key (per entry for maps, §B.3). The journal and the stderr
   summary distinguish `profile` from `env` (§B.7).
   - Profiles load **only from the installed toolkit package** (`policy/profiles/<name>.env`, generated from the
     registry, §B.9), never from the workspace, so a PR cannot edit the profile its own checks run under (P1).
     There are no custom profiles: set the keys directly.
   - `CQ_PROFILE` has no per-call form, since a per-call profile would be a wildcard relaxation, which P7 forbids.
   - `CQ_PROFILE` is only _how_ the `solo-maintainer` values arrive. It adds no layer, and setting the individual
     `vars.*` remains equivalent.

   > Narrowed: the bundled profiles ship as `.profile`, not `.env`; see post-acceptance note N15 in the
   > [ADR index](README.md#post-acceptance-notes).

2. **Order classes.** Every key declares one class:
   - **`tighter`**, a conservative order. Per-call movement toward it is free.
   - **`limit`**, a `tighter` key whose blank is "no extra limit": `CQ_BUDGET_MAX_USD`, `CQ_BUDGET_MAX_TOKENS`,
     and the `CQ_GOVERNOR_*` limits. P8 is still met, because `CQ_BUDGET_REQUIRE_CAP=true` refuses unattended
     governed runs without a cap: blank is conservative _as a posture_, not per key. `CQ_RUN_TOOL` blank `on` is
     likewise conservative only in composition, since it is subject to `CQ_SANDBOX=required`.
   - **`unordered`**, policy-relevant with no order (e.g. `CQ_DRIVER_BINDINGS`, `CQ_MERGE_PROTECTED_BRANCH`). Any
     per-call change needs the key named.
   - **`neutral`**, no policy meaning. A per-call change is free, but a value different from blank is still listed
     in the stderr summary. Neutral keys: `CQ_APPROVAL_LEDGER` (env-only), `CQ_JOURNAL_DIR`,
     `CQ_DRIVER_SESSIONS_DIR` and `CQ_GOVERNOR_CONCURRENCY`. The journal dir scopes the ADR-0003 bound (§2.3: a
     fresh dir starts at S = 0); that is inherent to ADR-0003 and accepted there, so surfacing the change is the
     proportionate control. Concurrency does not move the admission bound (`settled + outstanding + proposed ≤ cap`).
3. **`optIn` shape: ADR-0003's.** `optIn?: readonly GovernanceOptIn[]`, a string array (ADR-0003 §2.1). Each
   element is `'<id>'` or `'<id>=<value>'`. The CLI's repeatable `--opt-in <id>[=<value>]` produces the same array.
   - `GovernanceOptIn` gains the registry's per-call ids as members, as a generated template-literal union. The
     _element type is extended, not reshaped_, so ADR-0003's main text stands. Entry points outside `runPlan`
     (self-host, `createDriverFactory`) accept the same array.
   - **`'<id>=<value>'`** sets the per-call value and authorises it. **A bare `'<id>'`** means: (a) for a
     per-call-only flag (`budget.raiseCap`, `budget.ungovernedOverGoverned`), the flag itself; (b) for a `bool` key,
     `=true`; (c) for any other key, "I authorise the typed per-call value of this key" (e.g.
     `--max-usd 10 --opt-in budget.maxUsd` authorises raising the cap to 10).
   - If a typed option and `'<id>=<value>'` both appear and **disagree**, that is a usage error (exit 2).
4. **Per-call rule** (P7). A per-call value that is tighter than or equal to the resolved value is always
   accepted, as is any change to a `neutral` key. A less conservative value, or any change to an `unordered` key,
   is accepted **only if the key is named** in `optIn`. No wildcards.
   - A typed per-call option for a registry key (`--max-usd`, `--concurrency`, `classifyPr(…, config)`, and the
     mirrored op inputs of §B.1) resolves through the same rule.
   - Every `call`-layer value is journalled and echoed as a `cq:` stderr notice (§B.7).
5. **No per-call layer** (✗ in §B.8): secrets; `CQ_PROFILE`; `CQ_MERGE_TRUSTED_ASSOCIATIONS`,
   `CQ_MERGE_BASE_BRANCH`, `CQ_MERGE_PROTECTED_BRANCH`; `CQ_EXTERNAL_INPUT`; `CQ_BUDGET_REQUIRE_CAP`;
   `CQ_APPROVAL_*`; every `CQ_PROVIDER_*`; and every key of type `argv` or that names an executable or a routing
   file (`CQ_GH_BIN`, `CQ_DRIVER_SUBPROCESS_*`, `CQ_DRIVER_ACP_*`). These keys are env-only in the v1.1 plan, are
   P1-trusted-only, or name what gets executed. SDK construction (`createDriverFactory({ lanes: … })`) remains
   possible: it is code, and is journalled as an `sdk` marker.

6. **Per-call-only inputs** (ADR-0003 §2.1, no env key):
   - `budget.legacyJournal=reset`, `budget.raiseCap`, `budget.ungovernedOverGoverned`, `budget.breakLock=<runId>`;
   - `releaseQuarantine: readonly string[]` (job ids, journalled with provenance `call`);
   - `attended`, as a flag only (`--attended` / `{attended:true}`). An env default would make every run "attended"
     silently (ADR-0003 §2.7: operator-declared, unverified).
7. **Resolved once.** Config resolves once per process entry (`cq` CLI main, `runPlan`, self-host entries,
   `createDriverFactory`). The result is frozen and passed down; env is snapshotted then and never re-read.
   - Ops receive a `ResolvedConfig` and **never read `process.env`**. A W3.6 lint confines `process.env` to
     `src/config/**` and the driver child-env builders, which read FOREIGN names only.
   - This also fixes the pr family ignoring `CQ_GH_BIN` ([src/ops/pr/ghEffects.ts](../../src/ops/pr/ghEffects.ts)).
8. **Resume** re-resolves config, and the journal holds each run's record. The cap on resume stays governed by
   ADR-0003 (`budget.raiseCap`). No other cross-run rule is added here.
9. **CI.** The project layer is repository/org/environment `vars.*` mapped in **default-branch** workflow
   definitions (§B.6). GitHub resolves its own env > repo > org order before the toolkit sees the value; the
   toolkit's layer is `env`. **P1-trusted-only keys** (`CQ_APPROVAL_*`) are refused when `GITHUB_EVENT_NAME` is
   `pull_request`, since the workflow definition is head-controlled. The toolkit cannot verify a workflow's
   provenance beyond that; the template, not the key, carries the rest (ADR-0004).

## B.5 Secret vs non-secret split

| Class                 | Members (v1.1)                                                                                                              | Layers                                                                  | CI source                                                                                                                    | Journal                                                                      | Scrub/redaction                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **CQ secret**         | `CQ_AUTOMATION_TOKEN` (a minted App installation token, ≤ 1 h, never a stored PAT)                                          | env only (SDK typed option allowed; no profile, no `--opt-in`, no argv) | `secrets.*` of a default-branch-only environment (`cq-automation`), mapped per step into privileged jobs only (ADR-0004 D-D) | `{layer, set: true}`: no value, no hash                                      | the name matches `SECRET_ENV_SUFFIXES` (redaction); `CQ_*` scrubbed from worker env **once W1.5 lands** (below) |
| **FOREIGN secret**    | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `ZAI_API_KEY`, `DEEPSEEK_API_KEY`, `GH_TOKEN`/`GITHUB_TOKEN`, route `keyEnv` targets | vendor-read                                                             | `secrets.*` in environments, mapped only into the step that runs the lane                                                    | presence only (`credentials: {NAME: 'set'}`), which explains lane resolution | existing redaction, W1.5 scrub                                                                                  |
| **Non-secret config** | every other `CQ_*`                                                                                                          | all layers per §B.4                                                     | `vars.*` (§B.6)                                                                                                              | value + layer (string values pass through the existing redaction)            | `CQ_*` scrubbed from worker env once W1.5 lands (a worker has no need to read policy)                           |

> Narrowed: the CQ secret is env-only (no SDK typed option); see post-acceptance note N4 in the
> [ADR index](README.md#post-acceptance-notes).

**The rule is by name.** A name is secret iff it ends with one of the existing `SECRET_ENV_SUFFIXES`
(`_API_KEY _TOKEN _AUTH_TOKEN _SECRET _KEY _PASSWORD _CREDENTIALS PRIVATE_KEY`,
[src/driver/error-text.ts](../../src/driver/error-text.ts)).

The registry lint enforces both directions (a secret-classed key must carry a suffix, and a non-secret key must
not), so one suffix list drives naming, redaction, journalling and the `vars.*` refusal, and they cannot drift
apart. `_TOKENS` (e.g. `CQ_BUDGET_MAX_TOKENS`) does not end with `_TOKEN`. The lint also checks every `keyEnv`
name in the subprocess and claude-agent routing tables against the suffix rule, so a route cannot hand a key
through an unredacted name.

**Consequences:**

- The toolkit refuses a secret-classed `CQ_*` found in a profile file.
- `CQ_RUN_ENV_PASSTHROUGH` may not name any `CQ_*`, any secret-suffixed name, or any credential-shaped name.
  Credential-shaped names are the set the subprocess allowlist already excludes by design (`AWS_*`, `NPM_TOKEN`,
  `SSH_AUTH_SOCK`, `GOOGLE_APPLICATION_CREDENTIALS`, `*_URL` names carrying userinfo, `NODE_OPTIONS`, `NODE_PATH`;
  see [src/driver/subprocess/process.ts](../../src/driver/subprocess/process.ts)), plus `DATABASE_URL`. A worker can
  exfiltrate whatever it can read (D14). The deny set is registry data, drift-tested against that file's list.
- `CQ_DRIVER_ACP_ENV_NAMES` may name secret-suffixed vendor keys. That is its purpose (the acp child is the model
  harness). It may not name `CQ_*`.
- **The worker-env scrub is a W1.5 requirement, not a fact at the time of writing.** Then, the claude-agent and acp
  lanes and the harness `run` tool passed the whole host env, including `CQ_AUTOMATION_TOKEN` wherever it was set.
  So until W1.5 lands, no job that maps `CQ_AUTOMATION_TOKEN` may also run a worker (already the P1 job split), and
  the `solo-maintainer` profile's `*/anthropic:claude-agent` binding ships **in the same release as W1.5's
  claude-agent scrub**, not before.

## B.6 CI mapping (`vars.*`)

1. **Same name.** Repository variable `CQ_X` maps to env `CQ_X`. No prefix games.
2. **Generated block.** The shipped templates (`policy/templates/**`, and the toolkit's own `.github/workflows/**`)
   carry a generated job-level block between markers:
   ```yaml
   # >>> cq-config (generated by scripts/gen-config-docs.mjs — do not edit)
   env:
     CQ_PROFILE: ${{ vars.CQ_PROFILE }}
     CQ_MERGE_REQUIRE_HUMAN_APPROVAL: ${{ vars.CQ_MERGE_REQUIRE_HUMAN_APPROVAL }}
     # … every key with ci: true, non-secret
   # <<< cq-config
   ```
   An unset variable renders `''`, which is blank, which is conservative. So mapping **every** key is safe, and
   adding a key never needs a hand edit to each template. The block is drift-checked with `docs/config.md` (§B.9).
3. **Default-branch definitions only for privileged jobs (P1).** The block is authoritative only in workflows
   whose definition comes from the default branch: `workflow_run`, `schedule`, `push` to the default branch,
   `workflow_dispatch` on the default ref, and `pull_request_target` jobs that never execute head code. A
   `pull_request` workflow's env is PR-controlled by construction. Its results are advisory under ADR-0004
   and it holds no write token, so its config mapping carries no trust.
4. **Secrets** are never in the generated block. Each privileged job maps its secret per step from its
   environment (`promote`, `cq-verdict`, `cq-automation`; ADR-0004 D-D). The D13 drift check keeps asserting zero
   repo-level secrets.
5. **Not in the CI block** (`ci: false`). **Rule: every key of type `path` or `argv`, and every key naming an
   executable, is `ci:false`.** Runner paths and executables are the workflow's own business. The keys are
   `CQ_APPROVAL_*`, `CQ_JOURNAL_DIR`, `CQ_DRIVER_SESSIONS_DIR`, `CQ_DRIVER_SUBPROCESS_COMMAND`,
   `CQ_DRIVER_SUBPROCESS_ROUTING`, `CQ_DRIVER_ACP_COMMAND`, `CQ_GH_BIN`, and `CQ_PROVIDER_<ID>_PROFILE` with a
   `custom:` value. A workflow that needs one maps it explicitly, and path keys must resolve outside the checkout.
   - **Approval signers in CI.** The approval-token annex expects signers "from default-branch `vars.*`", but
     `CQ_APPROVAL_SIGNERS` is a path. The template (W1.9) materialises the file in a default-branch step: it
     writes a variable's content to `$RUNNER_TEMP`, then exports `CQ_APPROVAL_SIGNERS` to that path. The source
     variable's name lies **outside** `CQ_`, so it cannot collide with strict validation.
   - The toolkit refuses `CQ_APPROVAL_*` under `GITHUB_EVENT_NAME=pull_request` (§B.4 item 9).
   - A gate sweep interval is a workflow `schedule` cron, so it is an adopt-time template placeholder
     (`{{GATE_SWEEP_CRON}}`, next to `{{GATE_TIMEOUT_MIN}}`), **not** a `CQ_*` key: a runtime env var cannot change
     a cron trigger.

   > Narrowed: three rows of this list read differently in code; see post-acceptance note N15 in the
   > [ADR index](README.md#post-acceptance-notes).

6. **solo-maintainer on the owner's repos:** one variable, `CQ_PROFILE=solo-maintainer`, plus any per-repo key
   overrides. The profile's expansion is journalled key by key, so one variable doesn't hide what it relaxed.
7. **Renames that must land with W3.6:**
   - `vars.CQ_DRILL_OWNER` → `CQTEST_DRILL_OWNER` (`live-merge.yml`);
   - the self-host `GH_REPOSITORY` fallback → `GH_REPO`;
   - the template placeholders `{{SELFHOST_TOKEN}}`/`{{SELFHOST_DRIVER_KEY}}` now name environment secrets;
   - the self-host workflows' `max_usd` dispatch input, when non-empty, is passed as
     `--max-usd "$MAX_USD" --opt-in selfhost.maxUsd`. The dispatcher typed it, so it is a named per-call value
     (§B.4 item 3c). Without this, a dispatch above the resolved `CQ_SELFHOST_MAX_USD` would now be refused.

## B.7 Journal provenance

**Placement: ADR-0003's.** The [journal annex](0003-journal-migration.md) §2 already reserves
`run-started.governance.config?: ResolvedConfigRecord` for P7 provenance. This annex fills that type; the placement
is unchanged.

```ts
interface ResolvedConfigRecord {
  registryVersion: 1;                        // bumps when a key is added/removed/retyped
  profile: 'conservative' | 'solo-maintainer';
  entries: Record<string /* per-call id */, {
    value: JsonValue;                        // resolved, normalised (set-semantic lists sorted); strings pass through redaction
    layer: 'default' | 'profile' | 'env' | 'call';
    env?: string;                            // the CQ_* name, when layer is 'profile' | 'env'
    relaxed: boolean;                        // tighter/limit keys: less conservative than blank; unordered keys: value ≠ blank; neutral: false
    changed: boolean;                        // value ≠ blank (any class) — drives the stderr summary for neutral keys
  }>;                                        // EVERY registry key, not only non-defaults (≈60 entries; audit completeness)
  secrets: Record<string, { layer: 'env' | 'call'; set: true }>;   // CQ secrets: presence only
  credentials: Record<string, 'set'>;        // FOREIGN secrets present in the snapshot: presence only
  foreign: Record<string, string>;           // FOREIGN non-secret values read (base URLs, GH_REPO)
  sdk: Record<string, '<custom>'>;           // SDK-only overrides in effect: pricing, harness, classify config, lane construction
}
```

> Narrowed: read `secrets[…].layer` as `'env'`; see post-acceptance note N4 in the
> [ADR index](README.md#post-acceptance-notes).

- **Opt-in entries duplicate; they do not replace.** The journal annex keeps its own governance fields
  (`attended`, `allowAdvisory`, `legacyJournal`, `raiseCap{from,to}`, and top-level `ungoverned`), and replay and
  fold read those. `entries` repeats them in registry form for audit, e.g.
  `entries['budget.raiseCap'] = {value: true, layer: 'call', relaxed: true, changed: true}`. `releaseQuarantine`
  job ids are recorded as `entries['budget.releaseQuarantine']` with layer `call`.
- **Open: ungoverned runs.** `governance` is present only for governed runs, so an **ungoverned** run records no
  config provenance, while P7 asks for the resolved value and layer on every `run-started`. This annex recommends
  an optional top-level `run-started.config?: ResolvedConfigRecord`, present when `governance` is absent. That is a
  journal-annex change and is not decided here.
- **stderr.** At run start, when any entry is `relaxed` or a neutral entry is `changed`, one summary line is
  printed, e.g.
  `cq: config: profile=solo-maintainer; relaxed: merge.trustedBots (profile), sandbox (profile), …; changed: journal.dir (call)`.
  One `cq: opt-in <id>=<value>` line is printed per `call` relaxation (P7).
- **Fixtures** (W6): matrix rows can be keyed on the `relaxed` set, so an eval result says which policy posture it
  ran under.

## B.8 The keys

Columns: **Type** · **Blank** (the layer-empty value: conservative, or for `limit`-class keys "no extra limit",
§B.4 item 2) · **solo** (the `solo-maintainer` profile value; "—" = not in the profile) · **Per-call** (id; ✗ = no
per-call layer; otherwise accepted per §B.4, and a tighter value needs nothing) · **Order** (the tighter
direction).

### B.8.1 Profile

| Key          | Type                                 | Blank          | solo   | Per-call | Order                |
| ------------ | ------------------------------------ | -------------- | ------ | -------- | -------------------- |
| `CQ_PROFILE` | enum `conservative\|solo-maintainer` | `conservative` | (self) | ✗        | conservative tighter |

### B.8.2 Merge acceptance (D3, D11)

| Key                               | Type                                   | Blank                                            | solo                 | Per-call                     | Order                                                                                  |
| --------------------------------- | -------------------------------------- | ------------------------------------------------ | -------------------- | ---------------------------- | -------------------------------------------------------------------------------------- |
| `CQ_MERGE_REQUIRE_HUMAN_APPROVAL` | bool                                   | `true`                                           | `false`              | `merge.requireHumanApproval` | `true` tighter                                                                         |
| `CQ_MERGE_ACCEPT_REVIEW_STATES`   | list<`APPROVED\|COMMENTED`>            | `APPROVED`                                       | `APPROVED,COMMENTED` | `merge.acceptReviewStates`   | subset tighter                                                                         |
| `CQ_MERGE_TRUSTED_BOTS`           | list<login ending `[bot]`> (or `none`) | none: bots never grant acceptance                | `coderabbitai[bot]`  | `merge.trustedBots`          | subset tighter                                                                         |
| `CQ_MERGE_TRUSTED_ASSOCIATIONS`   | list<`OWNER\|MEMBER\|COLLABORATOR`>    | `OWNER,MEMBER,COLLABORATOR`                      | same                 | ✗                            | **subset of blank only, at every layer** (D3 fixes the set; the key can only narrow)   |
| `CQ_MERGE_SETTLE_MS`              | ms                                     | `600000` (`REVIEW_ACCEPT_SETTLE_MS`)             | `600000`             | `merge.settleMs`             | larger tighter                                                                         |
| `CQ_MERGE_PROTECTED_PATHS`        | enum `human\|diff-check`               | `human`                                          | `diff-check`         | `merge.protectedPaths`       | `human` tighter                                                                        |
| `CQ_MERGE_BASE_BRANCH`            | string (ref name)                      | `merge-queue`                                    | —                    | ✗                            | unordered                                                                              |
| `CQ_MERGE_PROTECTED_BRANCH`       | string (ref name)                      | `main`                                           | —                    | ✗                            | unordered                                                                              |
| `CQ_MERGE_EXCLUDED_LOGINS`        | list<login> (or `none`)                | none: only the structural exclusions below apply | —                    | ✗                            | more tighter (**union only**: it can add exclusions, never remove the structural ones) |

`CQ_MERGE_PROTECTED_BRANCH` is a single branch in v1.1, because the ADR-0004 rulesets protect one trust ref.

**Structural exclusion (STRUCT, no key; D2, P8).** These identities are always removed from the trust set. They are
also rejected if they appear in `CQ_MERGE_TRUSTED_BOTS`:

- the automation identity _derived at run start from the credential in use_ (the App slug `<slug>[bot]` for an
  installation token, `gh api user` otherwise; underivable → acceptance fails closed);
- every toolkit App bot (`cq-verdict[bot]`, `cq-promoter[bot]`, `cq-automation[bot]`);
- `github-actions[bot]`, since a PR's own workflow can post reviews under that login.

`CQ_MERGE_EXCLUDED_LOGINS` can only add to this set. The PR author is excluded by D3 at evaluation time, not by
config.

### B.8.3 External input, sandbox and the run tool (D14)

| Key                      | Type                                                                                                     | Blank                                                             | solo            | Per-call             | Order                                                                                               | Notes                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------- | -------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `CQ_EXTERNAL_INPUT`      | enum `ignore` (v1.1 admits no other value)                                                               | `ignore`                                                          | `ignore`        | ✗                    | —                                                                                                   | external input is a v1.1 non-goal                                                                                  |
| `CQ_SANDBOX`             | enum `required\|off`                                                                                     | `required`                                                        | `off`           | `sandbox`            | `required` tighter                                                                                  |                                                                                                                    |
| `CQ_SANDBOX_BACKEND`     | enum `auto\|landlock\|bwrap\|container\|seatbelt\|cc-native`                                             | `auto` (Linux landlock→bwrap→container; macOS seatbelt→container) | —               | `sandbox.backend`    | unordered (every value is certified; `cc-native` only with the claude driver and its strict policy) |                                                                                                                    |
| `CQ_SANDBOX_NETWORK`     | enum `model-only\|allow`                                                                                 | `model-only`                                                      | `allow`         | `sandbox.network`    | `model-only` tighter                                                                                |                                                                                                                    |
| `CQ_SANDBOX_PROXY_URL`   | proxy URL (`http://` or `https://`, since forward proxies commonly use `http://` + CONNECT; no userinfo) | none (with `model-only`, a required sandbox then has no network)  | —               | ✗                    | —                                                                                                   | **reserved** for W1.11 (model-only needs an external forward proxy); **setting it fails** until then (§B.2 item 5) |
| `CQ_RUN_TOOL`            | enum `on\|off`                                                                                           | `on` (subject to `CQ_SANDBOX`)                                    | `on`            | `run.tool`           | `off` tighter                                                                                       |                                                                                                                    |
| `CQ_RUN_ENV_PASSTHROUGH` | list<env name> (or `none`)                                                                               | none                                                              | — (per project) | `run.envPassthrough` | subset tighter                                                                                      | rejects `CQ_*`, secret-suffixed and credential-shaped names (§B.5)                                                 |
| `CQ_RUN_COMMANDS`        | list<token-prefix pattern>                                                                               | none (each op's declared allowlist only, e.g. `reviewFixHarness`) | — (per project) | `run.commands`       | subset tighter                                                                                      | **added** to the op's allowlist for write-capable roles; `re:` patterns stay SDK-only                              |
| `CQ_RUN_TIMEOUT_MS`      | ms (1 000–1 800 000)                                                                                     | `30000`                                                           | —               | `run.timeoutMs`      | smaller tighter                                                                                     |                                                                                                                    |

Today's run-tool defaults live in [src/harness/config.ts](../../src/harness/config.ts).

### B.8.4 Budget and governor (D5; ADR-0003's configuration keys)

| Key                             | Type    | Blank                                                           | solo    | Per-call                                                                        | Order                                               |
| ------------------------------- | ------- | --------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------- | --------------------------------------------------- |
| `CQ_BUDGET_ALLOW_ADVISORY`      | bool    | `false`                                                         | `false` | `budget.allowAdvisory` (CLI sugar `--allow-advisory-budget`)                    | `false` tighter                                     |
| `CQ_BUDGET_REQUIRE_CAP`         | bool    | `true`                                                          | `true`  | ✗                                                                               | `true` tighter                                      |
| `CQ_BUDGET_MAX_USD`             | usd     | none (with `REQUIRE_CAP`, unattended governed runs are refused) | —       | `budget.maxUsd` / `--max-usd` (entry points `cq run-plan` and plan subcommands) | limit                                               |
| `CQ_BUDGET_MAX_TOKENS`          | int     | none                                                            | —       | `budget.maxTokens` / `--max-tokens`                                             | limit (ADVISORY on every lane, ADR-0003 §2.4)       |
| `CQ_BUDGET_MIN_INNER_USD`       | usd > 0 | `0.01` (`c_min`, ADR-0003 §2.2 step 3)                          | —       | `budget.minInnerUsd`                                                            | larger tighter                                      |
| `CQ_BUDGET_MAX_DEFER_MS`        | ms      | `0` (ADR-0003 §2.6)                                             | —       | `budget.maxDeferMs`                                                             | smaller tighter                                     |
| `CQ_BUDGET_ZOMBIE_GRACE_MS`     | ms      | **`30000` (proposed)**, see below                               | —       | `budget.zombieGraceMs`                                                          | smaller tighter                                     |
| `CQ_BUDGET_INVOCATION_USD`      | usd     | none (`p = C / concurrency`, ADR-0003 §2.2)                     | —       | `budget.invocationUsd`                                                          | smaller tighter                                     |
| `CQ_GOVERNOR_CONCURRENCY`       | int ≥ 1 | `4` (today's CLI default)                                       | —       | `governor.concurrency` / `--concurrency`                                        | neutral (the admission bound does not depend on it) |
| `CQ_GOVERNOR_JOB_WALL_CLOCK_MS` | ms      | none (no ladder)                                                | —       | `governor.jobWallClockMs`                                                       | limit                                               |
| `CQ_GOVERNOR_MAX_ATTEMPTS`      | int ≥ 1 | none                                                            | —       | `governor.maxAttempts`                                                          | limit                                               |
| `CQ_GOVERNOR_DISPATCH_QUOTA`    | int ≥ 1 | none                                                            | —       | `governor.dispatchQuota`                                                        | limit                                               |
| `CQ_GOVERNOR_IN_FLIGHT_CEILING` | int ≥ 1 | none                                                            | —       | `governor.inFlightCeiling`                                                      | limit                                               |

**Rules:**

- **Zombie grace.** `30000` is ≥ 6× the measured worst cooperative settle (≈ 2 s on claude-agent,
  [DD-1](../dd-1-abort-spike.md)) and ≥ the 5 s abort grace. The bound is unaffected (zombies are charged `r` in
  full, ADR-0003 §2.5), so the value only trades quarantine latency. W2 may re-derive it from the ladder.
- **Invocation USD is "smaller tighter"**: a smaller `p` never raises any reservation above `max(p, floor)`.
- **Cap raise on resume:** still ADR-0003's `budget.raiseCap` (§B.4 item 8).
- **Per-call-only:** `releaseQuarantine` (job ids; ADR-0003 §2.1), `budget.legacyJournal=reset`, `budget.raiseCap`,
  `budget.ungovernedOverGoverned`, `budget.breakLock=<runId>`.
- **Flag only:** `--attended`.
- If ADVISORY reservation sizing (ADR-0003's open point O-4) needs a knob, it lives in the `BUDGET` domain and
  follows §B.3/§B.4. None is named here.

### B.8.5 Approval token (the approval-token annex)

| Key                      | Type                                                | Blank                                                                  | solo | Per-call | Order           | Annex ref |
| ------------------------ | --------------------------------------------------- | ---------------------------------------------------------------------- | ---- | -------- | --------------- | --------- |
| `CQ_APPROVAL_SIGNERS`    | path (**outside-workspace**; P1-trusted layer only) | none: approval-required jobs → `needs-human`                           | —    | ✗        | unordered       | §4a       |
| `CQ_APPROVAL_LEDGER`     | path (**outside-workspace**)                        | `$XDG_STATE_HOME/cq/approvals.ndjson` (fallback `~/.local/state/cq/…`) | —    | ✗        | neutral         | §5        |
| `CQ_APPROVAL_MAX_TTL_MS` | ms                                                  | `86400000` (24 h)                                                      | —    | ✗        | smaller tighter | —         |
| `CQ_APPROVAL_KEY*`       | —                                                   | **reserved, denied** (§B.2 item 6)                                     | —    | ✗        | —               | §3 item 5 |

"P1-trusted layer only" means:

- `env`, or `profile`, never `call`;
- in CI, only from a default-branch definition;
- and the path must not resolve under the workspace realpath.

### B.8.6 Drivers (ADR-0002 §2.5–§2.6)

| Key                              | Type                                                                                                | Blank                                                                                                         | solo                       | Per-call                    | Order                                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `CQ_DRIVER_BINDINGS`             | map `<role\|*>/<provider\|*>:<lane>`                                                                | built-in: `*/zai:ai-sdk,*/anthropic:ai-sdk,*/openai:ai-sdk,*/deepseek:ai-sdk`; other providers throw `config` | `*/anthropic:claude-agent` | `driver.bindings`           | unordered                                                                                                          |
| `CQ_DRIVER_SERVED_ALIASES`       | aliases `<lane>/<provider>/<requested>=<served>[\|<served>…]` (§B.3)                                | the built-in layer (the provider profiles' `servedAliases`; **empty until open point O-2 is decided**)        | —                          | `driver.servedAliases`      | fewer tighter (entries are **added** to the built-in layer per `lane/provider/requested`, never replace the layer) |
| `CQ_DRIVER_SERVED_UNOBSERVED_OK` | list<lane> (or `none`)                                                                              | none                                                                                                          | —                          | `driver.servedUnobservedOk` | subset tighter; each listed lane is ADVISORY (ADR-0002 §2.6)                                                       |
| `CQ_DRIVER_SESSION_RETENTION`    | enum `keep\|reap-on-settle`                                                                         | none: each `DriverRequest`'s own value (default `keep`; `review.fixItem` requests reap)                       | —                          | `driver.sessionRetention`   | `keep` tighter (evidence)                                                                                          |
| `CQ_DRIVER_SESSIONS_DIR`         | path (**outside-workspace**: a worker that can rewrite its session record can rebind its workspace) | `$TMPDIR/cq-harness/sessions`                                                                                 | —                          | `driver.sessionsDir`        | neutral (surfaced as `changed`)                                                                                    |
| `CQ_DRIVER_SUBPROCESS_COMMAND`   | argv                                                                                                | `["claude"]`                                                                                                  | —                          | ✗                           | unordered                                                                                                          |
| `CQ_DRIVER_SUBPROCESS_ROUTING`   | path (**outside-workspace**) to a `RoutingTable` JSON (same strict zod schema)                      | `defaultRoutingTable()`                                                                                       | —                          | ✗                           | unordered                                                                                                          |
| `CQ_DRIVER_ACP_ENDPOINT`         | enum (endpoint-table names) `zcode-acp-server\|dsh-acp`                                             | `zcode-acp-server`                                                                                            | —                          | ✗                           | unordered                                                                                                          |
| `CQ_DRIVER_ACP_COMMAND`          | argv                                                                                                | the endpoint's argv                                                                                           | —                          | ✗                           | unordered                                                                                                          |
| `CQ_DRIVER_ACP_ENV_NAMES`        | list<env name>                                                                                      | none                                                                                                          | —                          | ✗                           | subset tighter; rejects `CQ_*`                                                                                     |

**Binding resolution:** the most specific entry wins: `role/provider` > `role/*` > `*/provider` > `*/*`.

- The role wildcard and this specificity order are this annex's semantics. ADR-0002 §2.5's type
  (`role → provider → lane; '*' = any provider`) permits them: role `*` is the default applied to every role not
  listed.
- Env entries override built-in entries per pair, and `call` entries override env entries.
- Binding `subprocess` is legal only after W1.4 closes its tool surface (the validator reads a registry capability
  flag, so a premature binding fails `config`, per ADR-0002 §2.5).
- Which vendor remaps ship in the built-in alias layer is the owner's decision (open point O-2).
  `CQ_DRIVER_SERVED_ALIASES` is only the override surface; until O-2 is decided the built-in layer is empty and a
  project adds remaps deliberately.
- **No key disables the served-model comparison** (ADR-0002 §2.6).

### B.8.7 Providers (D5) — `CQ_PROVIDER_<ID>_<KEY>`

Bundled `<ID>`s: `ANTHROPIC_API`, `CLAUDE_SUBSCRIPTION`, `ZAI_GLM_CODING`, `DEEPSEEK`, `OPENAI_API`,
`CODEX_CHATGPT`, `OPENCODE_GO`. All keys are env-only. The fields they set are those of ADR-0003's
`ProviderProfile`.

| `<KEY>`            | Type                                                                                                                                                                                                     | Blank                                                                                     | Order                                                                                                                                                                                    | Notes                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `PROFILE`          | `bundled` \| `custom:<path>` (**outside-workspace**, validated against the `ProviderProfile` schema)                                                                                                     | `bundled` for known ids; required to declare a new id                                     | unordered                                                                                                                                                                                |                                                                        |
| `LIMITS_KNOWN`     | bool                                                                                                                                                                                                     | the profile's value                                                                       | `false` tighter. `true` is accepted **only** if the resolved profile then carries a complete declaration (`cap`, plus `quota.windows` when `accounting:'quota'`); otherwise config error |                                                                        |
| `CAP_AMOUNT`       | number (unit per `cap.kind`: USD or credits)                                                                                                                                                             | the profile's value (usually none: account-specific)                                      | smaller tighter                                                                                                                                                                          | `cap.amount`; a bundled profile cannot know the account's tier or plan |
| `RPM`              | int                                                                                                                                                                                                      | the profile's `modelLimits` value                                                         | smaller tighter                                                                                                                                                                          | `modelLimits.rpm`                                                      |
| `PEAK_WINDOWS`     | window (one, §B.3)                                                                                                                                                                                       | the profile's `quota.peak` (zai: `Mon-Fri 14:00-18:00 Asia/Singapore; mult=1.0; off=0.5`) | higher `mult` / wider window tighter                                                                                                                                                     | plural name kept for forward compatibility; one window in v1.1         |
| `WINDOW_FRACTIONS` | map `<windowId>:<fraction>`                                                                                                                                                                              | the profile's value (opencode-go `5h:0.2,weekly:0.5`)                                     | smaller tighter                                                                                                                                                                          | `:` separator, the §B.3 map grammar                                    |
| `QUOTA_ENDPOINT`   | url; **host must equal the bundled profile's usage-endpoint host** (the endpoint is called with the lane's credential, `auth:'same-credentials'`, so a free URL would be a credential-exfiltration knob) | the profile's value                                                                       | unordered                                                                                                                                                                                |                                                                        |
| `MAX_DEFER_MS`     | ms                                                                                                                                                                                                       | = `CQ_BUDGET_MAX_DEFER_MS`                                                                | smaller tighter; **effective = min(global, provider)**: a provider can shorten, never lengthen, the global defer ceiling                                                                 |                                                                        |

> Narrowed: `WINDOW_FRACTIONS` values are decimals; see post-acceptance note N3 in the
> [ADR index](README.md#post-acceptance-notes).

D5's `QUOTA_*` example resolves to `QUOTA_ENDPOINT` and `WINDOW_FRACTIONS`. **Unknown or undeclared limits → the
lane is ADVISORY** (ADR-0003 §2.4).

### B.8.8 Journal, self-host, GitHub, automation identity

| Key                             | Type                 | Blank                                                                                                     | solo | Per-call                                                                            | Order                                                                      |
| ------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `CQ_JOURNAL_DIR`                | path                 | none for `cq run-plan` (no journal); self-host: `<repo>/.selfhost/journal`                                | —    | `journal.dir` / `--journal-dir` / `--journal-root`                                  | neutral (surfaced as `changed`; ADR-0003 §2.3 scopes the bound to one dir) |
| `CQ_SELFHOST_MAX_USD`           | usd                  | `1`                                                                                                       | —    | `selfhost.maxUsd` / `--max-usd` (entry points `self-merge-prs`, `self-review-loop`) | smaller tighter                                                            |
| `CQ_SELFHOST_JOB_WALL_CLOCK_MS` | ms                   | `300000`                                                                                                  | —    | `selfhost.jobWallClockMs`                                                           | smaller tighter                                                            |
| `CQ_SELFHOST_MODEL`             | `<provider>/<model>` | `zai/glm-5.3-flash` (today `{provider:'ai-sdk'}`, normalised per ADR-0002 §2.5)                           | —    | `selfhost.model`                                                                    | unordered                                                                  |
| `CQ_GH_BIN`                     | path or bare command | `gh` (existing name)                                                                                      | —    | ✗                                                                                   | unordered                                                                  |
| `CQ_GH_TIMEOUT_MS`              | ms                   | `600000` (the pr family's `DEFAULT_GH_TIMEOUT_MS`; merge/review have none today, so this is a tightening) | —    | `gh.timeoutMs`                                                                      | smaller tighter                                                            |
| `CQ_AUTOMATION_TOKEN`           | **secret**           | none (ratchet-propose throws); existing name                                                              | —    | ✗                                                                                   | —                                                                          |

Today's self-host defaults are in [src/selfhost/config.ts](../../src/selfhost/config.ts).

## B.9 `docs/config.md` and generated artefacts (W3.6)

- **Single source:** [src/config/registry.ts](../../src/config/registry.ts), one entry per key:
  `{env, id, domain, type, bounds, blank, order, layers, secret, ci, outsideWorkspace, profiles:{'solo-maintainer'?}, src, doc}`.
- **Generator** `scripts/gen-config-docs.mjs` (modelled on [scripts/gen-op-docs.mjs](../../scripts/gen-op-docs.mjs))
  writes `docs/config.md`, `policy/profiles/solo-maintainer.env` (packaged in the npm tarball via `package.json`
  `files`), and the `# >>> cq-config` env block in every template and self-host workflow. `package.json` gains
  `gen:config-docs` and `gen:config-docs:check`; `ci.yml` runs the check next to `gen:op-docs:check`.
- **Registry fields** add `order: 'tighter'|'limit'|'unordered'|'neutral'` and `reserved?: string`.
- **Registry lint** (unit test): secret ⇔ secret suffix; per-call ids are unique and mechanical; every `ci:true`
  key is non-secret; and every row of the v1.1 plan's configuration table is present with the same blank and solo
  values (the drift check between this annex and the plan).

## B.10 Names resolved by this annex

Earlier drafts and the v1.1 plan used provisional names. The final names:

| Provisional                    | Final                                                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `run=off`                      | `run.tool=off`                                                                                 |
| `merge.botAcceptance`          | `merge.trustedBots`                                                                            |
| `CQ_RUN_ENV_PASSTHROUGH=off`   | `none` (`off` is not a value)                                                                  |
| `CQ_DRIVER_<ROLE>_LANE`        | `CQ_DRIVER_BINDINGS` (one map key; solo value `*/anthropic:claude-agent`)                      |
| `CQ_AUTOMATION_IDENTITY`       | no key: the structural exclusion, plus union-only `CQ_MERGE_EXCLUDED_LOGINS` (§B.8.2)          |
| `CQ_PROVIDER_ZAI_PEAK_WINDOWS` | `CQ_PROVIDER_ZAI_GLM_CODING_PEAK_WINDOWS` (mechanical id)                                      |
| `CQ_PROVIDER_<ID>_QUOTA_*`     | `CQ_PROVIDER_<ID>_QUOTA_ENDPOINT` and `CQ_PROVIDER_<ID>_WINDOW_FRACTIONS` (`=` becomes `:`)    |
| per-lane construction knobs    | `CQ_DRIVER_SUBPROCESS_COMMAND`, `_ROUTING`, `CQ_DRIVER_ACP_ENDPOINT`, `_COMMAND`, `_ENV_NAMES` |

Unchanged: every other `CQ_*` name in the plan's table, `sandbox=off`, `--allow-advisory-budget` (CLI sugar), and
ADR-0003's nine budget and approval keys. New: `CQ_PROVIDER_<ID>_RPM`, `CQ_PROVIDER_<ID>_CAP_AMOUNT`,
`CQ_MERGE_EXCLUDED_LOGINS`, and `releaseQuarantine` as a per-call-only input. No key names an App slug; the slugs
enter config only as the structural exclusion set (§B.8.2).

## B.11 Migration (W3.6)

| From                                                                                                                                    | To                                                                                                       | Compatibility                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `SelfhostDefaults` (frozen, no override)                                                                                                | built-in layer of `CQ_SELFHOST_*`, `CQ_MERGE_BASE_BRANCH`, `CQ_MERGE_PROTECTED_BRANCH`, `CQ_JOURNAL_DIR` | same defaults                                                                                                                      |
| `sweep.unit` plan JSON `driver.binary` / `driver.routingTable`                                                                          | `CQ_DRIVER_SUBPROCESS_COMMAND` / `_ROUTING`                                                              | plan fields rejected after the ADR-0002 slice (P1)                                                                                 |
| `GH_REPOSITORY` fallback                                                                                                                | `GH_REPO` (FOREIGN)                                                                                      | accept both for v1.1, with a `cq:` deprecation notice for `GH_REPOSITORY`                                                          |
| `vars.CQ_DRILL_OWNER`                                                                                                                   | `CQTEST_DRILL_OWNER`                                                                                     | rename in the same PR that turns on strict validation                                                                              |
| `ops/**` direct `process.env` reads                                                                                                     | `ResolvedConfig`                                                                                         | lint-enforced (§B.4 item 7)                                                                                                        |
| op inputs mirroring registry keys: merge `protectedBranch`, `RunMergePrsInput.baseBranch`, `resolveConflict`/`sweep.unit` `sessionsDir` | resolved config                                                                                          | validated against the resolved value from the W3.6 slice (✗ keys: must be equal); fields deleted when their callers migrate (§B.1) |
| self-host `max_usd` dispatch input above `CQ_SELFHOST_MAX_USD`                                                                          | `--max-usd <v> --opt-in selfhost.maxUsd`                                                                 | **behaviour change:** without the opt-in it is refused. Templates pass the opt-in when the input is non-empty (§B.6 item 7)        |
| merge/review gh/git runners with no timeout                                                                                             | `CQ_GH_TIMEOUT_MS` blank `600000`                                                                        | **behaviour change:** tightening                                                                                                   |
| `--concurrency` above 4                                                                                                                 | unchanged                                                                                                | `CQ_GOVERNOR_CONCURRENCY` is `neutral`, so no opt-in is needed and no break                                                        |
| repo secrets `GH_TOKEN`, `Z_AI_API_KEY`, `PROMOTE_TOKEN`, `CQ_AUTOMATION_TOKEN`                                                         | environment secrets (ADR-0004 C1)                                                                        | ADR-0004 cutover owns the order                                                                                                    |

## B.12 Rejected alternatives

- **A repo-committed config file** (`cq.config.ts`/`.cqrc`): PR-controlled by construction, so a PR could relax
  the policy that judges it (P1). Env from default-branch definitions has no such path.
- **Per-role env names** (`CQ_DRIVER_<ROLE>_LANE`): roles are an open string type, so typo detection would need a
  role registry at env-parse time. One map key keeps strictness.
- **Short provider env ids** (`ZAI` for `zai-glm-coding`): needs a hand-kept alias table, and a provider with two
  accounting profiles (`openai-api` vs `codex-chatgpt`) collides. Mechanical ids cost length only.
- **Journalling only non-default keys:** smaller, but an auditor cannot distinguish "default" from "not recorded".
  About 60 entries per `run-started` is cheap.
- **Hashing secrets into the journal:** a stable fingerprint of a long-lived secret is a correlation handle with no
  audit value the `layer`/`set` pair doesn't already give.
- **Env-configurable pricing:** see §B.1 (no checkable direction; it would break the budget bound).
