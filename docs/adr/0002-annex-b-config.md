# ADR-0002 Annex B — Configuration keys (RS-15)

Status: **accepted** (owner G1 sign-off, 2026-09-26, as part of the reconciled ADR set; originally drafted as proposed, RS-15, run=v11, tier O). Fills ADR-0002's Annex B slot and ADR-0003's Slot D without changing
either ADR's main text (`research/g1-adr-reconciliation` @ `bf5f540`). Owner approval rode G1 with the ADRs and was recorded on 2026-09-26.
Date: 2026-09-25.
Evidence: `rs15-config-inventory.md` (every tunable at cq-toolkit `5e52707`, with a disposition per row).
Inputs: V11PLAN §2 P7/P8, §3 D3/D5/D11/D14, §3.1; ADR-0002 §2.5–§2.6 and Annex B slot; ADR-0003 §2.1–§2.7, Slot C,
Slot D, approval-token annex §3–§5; RS-14 §3 config binding (`research/rs14-provider-limits`); RS-13 decision
(`research/rs13-sandbox-backends`); RS-11 (`research-rs11-identity-tokens`).

**Decision:**

- **Namespace.** One strict namespace, `CQ_<DOMAIN>_<KEY>`: a closed set of domains plus one dynamic family,
  `CQ_PROVIDER_<ID>_<KEY>`. Each key is mechanically mirrored as a per-call id, `<domain>.<camelKey>`.
- **Precedence.** P7's three layers, **built-in → project env → per-call**, with the last one winning.
  - The project-env layer may be seeded by a bundled profile (`CQ_PROFILE`); explicit `CQ_*` vars beat the profile.
  - Blank means "this layer sets nothing". With `CQ_PROFILE` blank, every key therefore resolves to its
    conservative value.
  - A per-call value less conservative than the resolved value is refused unless its key is named in `optIn`.
  - Config and opt-ins are **never** read from plan JSON, op input or workspace files.
- **Secrets.** A key is secret exactly when its name ends in one of the toolkit's existing secret suffixes
  (`error-text.ts:14-23`).
  - Secrets come from the env layer only. They never appear in a profile, `vars.*`, argv, or a journal value.
  - In CI they come from `secrets.*` of default-branch-only environments.
- **Non-secrets.** Every other key is non-secret: it comes from `vars.*` via a generated default-branch `env:`
  block, and is journalled with its value and layer.

**Revision r1** (same day) folds an independent critic pass (ITERATE: 5 major, 12 minor, 4 nits). The
finding-by-finding dispositions are in §B.13.

---

## B.1 Scope — what gets a key

Every tunable in the inventory gets exactly one disposition (inventory §0): **ENV**, **ENV-only**, **CALL**,
**SDK**, **STRUCT**, **FOREIGN**, **RENAME**. The rule that decides between ENV and SDK:

> A tunable gets a `CQ_*` key iff (a) a _project_ — not a call site — plausibly wants a different value, and
> (b) its value is plain data with a checkable conservative direction or no policy meaning.

So these stay **SDK** (code/SDK construction only; journalled as a marker in `sdk` when overridden, §B.7):

- measurement-derived constants (`DEFAULT_ABORT_GRACE_MS`, test-pinned to DD-1, `governor.config.ts:1-24`);
- regex and decision-table data (merge `allClearPattern`/`skipPatterns`: an env regex is a ReDoS vector and an
  acceptance bypass). **Exception, today:** review `skipPatterns` is reachable from plan data via the
  `review.classifyThreads` op input (`review/registry.ts:272-291,542-558`). It is CALL, not SDK. It is not a config
  key. It carries a P1 note for W1: a plan-supplied pattern can suppress human feedback;
- callbacks (`pricing`, `jobKey`, `usdOf`, `sdkLoader`, `spawn`);
- pricing tables (a lower price is a silent undercount with no checkable direction; DoD 2);
- protocol constants and prompt/size bounds.

And these are **STRUCT** (no key at any layer, P8): SHA binding, the trust-set filter, write-token separation,
env scrub at spawn, base-ref provenance, fork/draft/protected-head exclusion, the subprocess argv shape, session
store modes, protected-path matchers, and **the exclusion of automation identities from the trust set** (D2; §B.8.2).

**Surfaces that never carry config or opt-ins (normative).**

- Plan JSON, op input, and any file in the workspace under review are never sources of configuration or opt-ins.
  `optIn`, `attended` and `releaseQuarantine` are `Governance`/entry-point parameters (ADR-0003 §2.1), never plan
  data.
- **An op-input field that mirrors a registry key** is validated against the resolved value:
  - on a key with no per-call layer (✗ in §B.8), any difference is refused (`config`);
  - on other keys, a difference is a per-call value under §B.4.

  Mirrors today: `protectedBranch` (merge registry `:273-281,327`), the queue `baseBranch` of `RunMergePrsInput`,
  `sessionsDir` (`resolveConflict.ts:329,488`; `sweep.unit` `driver.sessionsDir`, `unit.ts:1108`). W3.6 may then
  delete them (§B.11).

- **A-suite row** (proposed for V11PLAN §7; the overseer carries it): _a PR-produced plan or artifact consumed by a
  privileged job carries mirrored config fields and opt-in-shaped strings, and the job's resolved config and
  journal show no relaxation._

## B.2 Namespace grammar

1. **Form.** `CQ_<DOMAIN>_<KEY>`, `[A-Z0-9_]`, SCREAMING_SNAKE. `<DOMAIN>` is from the closed registry below.
   A domain's primary switch may be the bare domain (`CQ_SANDBOX`, `CQ_PROFILE`).
2. **Domains (closed):** `PROFILE`, `MERGE`, `REVIEW` (reserved, no v1.1 keys), `EXTERNAL`, `SANDBOX`, `RUN`,
   `BUDGET`, `GOVERNOR`, `APPROVAL`, `PROVIDER`, `DRIVER`, `JOURNAL`, `SELFHOST`, `GH`, `AUTOMATION`.
3. **One dynamic family:** `CQ_PROVIDER_<ID>_<KEY>`.
   - `<ID>` = the RS-14 profile id uppercased with `-` → `_` (`zai-glm-coding` → `ZAI_GLM_CODING`). No alias table.
   - Profile ids (bundled and custom) are `[a-z0-9]+(-[a-z0-9]+)*`, so the reverse mapping (`_` → `-`, lowercase)
     is exact.
   - Parsing is unambiguous: match the suffix against the closed provider-key set (longest first); the remaining
     prefix must be a known id. Known = a bundled profile id, or an id declared by its own
     `CQ_PROVIDER_<ID>_PROFILE=custom:<path>`.
   - Driver bindings are **not** a dynamic family (`WorkerRole` is an open string type, ADR-0002 §2.5, so
     `CQ_DRIVER_<ROLE>_*` names could not be typo-checked). They are one key, `CQ_DRIVER_BINDINGS` (§B.8.6).
4. **Per-call id** (the journal's entry key and, where a per-call layer exists, the `optIn` id): the domain
   lowercased, then `.`, then the key in lowerCamel.
   - Examples: `CQ_MERGE_REQUIRE_HUMAN_APPROVAL` ↔ `merge.requireHumanApproval`; bare `CQ_SANDBOX` ↔ `sandbox`.
   - Provider ids are **journal-only**, since provider keys have no per-call layer:
     `CQ_PROVIDER_ZAI_GLM_CODING_PEAK_WINDOWS` ↔ `provider.zai-glm-coding.peakWindows`.
   - The mapping is mechanical and generated. The only hand-written alias is the §3.1 CLI sugar
     `--allow-advisory-budget` (≡ `--opt-in budget.allowAdvisory=true`).
5. **Strictness.**
   - Any `CQ_*` name not in the registry fails the run before dispatch with exit 2 (usage/config;
     `cli/exit.ts:5-15`). All errors are aggregated, each with the nearest known name. There is no escape hatch;
     an ignore-list would defeat typo detection.
   - A **reserved** key (`CQ_SANDBOX_PROXY_URL` until W1.11) that is set also fails, with
     `reserved (W1.11): not yet honoured`. It is never silently ignored.
6. **The prefix is the toolkit's.**
   - Consumers use their own prefix: cq-fixtures `CQFX_*`. Toolkit test and drill variables use `CQTEST_*`.
   - `CQ_APPROVAL_KEY*` is **reserved and denied**. No config key ever carries signing material or its path;
     `cq approve --key <path>` is the only input (ADR-0003 token annex §3), so no CI mapping can hold minting
     capability.
7. **FOREIGN names are not renamed.** Vendor/tool names the toolkit reads (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
   `ZAI_API_KEY`, `DEEPSEEK_API_KEY`, `ZAI_BASE_URL`, `ZAI_ANTHROPIC_BASE_URL`, `DEEPSEEK_ANTHROPIC_BASE_URL`,
   `ANTHROPIC_BASE_URL`, `GH_REPO`, `PATH`) are registered as FOREIGN. They keep their names so vendor tooling and
   docs still work, and are validated where the toolkit can check (URL keys: `https://` only). They are
   journalled (§B.7): non-secret with their value, secret as presence only. Renaming them would double the secret
   surface for no gain.

## B.3 Types and value grammar

| Type      | Grammar                                                                                                  | Notes                                                                                                                                                                                                                                                                                                                                                                                              |
| --------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bool`    | `true` \| `false`                                                                                        | Lowercase only. `1`/`yes`/`on` are errors (typos fail loudly).                                                                                                                                                                                                                                                                                                                                     |
| `int`     | decimal, no separators                                                                                   | Per-key bounds.                                                                                                                                                                                                                                                                                                                                                                                    |
| `ms`      | `int`, key ends `_MS`                                                                                    | Milliseconds only; no unit suffixes. The key suffix carries the unit.                                                                                                                                                                                                                                                                                                                              |
| `usd`     | decimal ≥ 0, ≤ 6 dp, key ends `_USD`                                                                     |                                                                                                                                                                                                                                                                                                                                                                                                    |
| `enum`    | one lowercase kebab value                                                                                | `APPROVED`-style GitHub enums keep GitHub's spelling.                                                                                                                                                                                                                                                                                                                                              |
| `list<T>` | comma-separated, items trimmed                                                                           | Empty items and duplicates are errors; set semantics unless stated. The literal `none` is legal only as the _sole_ item, on keys that list it.                                                                                                                                                                                                                                                     |
| `map`     | comma-separated `<k>:<v>` entries; `<k>` and `<v>` are `[a-z0-9*/-]+`                                    | Used by `CQ_DRIVER_BINDINGS` and `WINDOW_FRACTIONS`. Role, provider and lane tokens are `[a-z0-9-]+` (or `*`). Anything else is a loud error, so an open-string role with `/`, `:` or `,` cannot be bound from env.                                                                                                                                                                                |
| `aliases` | comma-separated `<lane>/<provider>/<requested>=<served>[\|<served>…]`                                    | Only `CQ_DRIVER_SERVED_ALIASES`. Lane and provider split on the first two `/`. Model ids may contain `/` and `:` (e.g. `vendor/model`, `…-v2:0`, `x:8b`), so the separator is `=`, and model ids may not contain `=`, `,` or `\|`.                                                                                                                                                                 |
| `model`   | `<provider>/<model>`                                                                                     | Split on the first `/` (the provider token is `[a-z0-9-]+`).                                                                                                                                                                                                                                                                                                                                       |
| `path`    | absolute after resolution                                                                                | `realpath`'d at resolution. A key marked **outside-workspace** refuses any path under the workspace realpath (tamper vector #26; ADR-0003 O-5 class).                                                                                                                                                                                                                                              |
| `url`     | `https://…`, **no userinfo, no query string** (a credential in a URL would be journalled with the value) | Some keys also require the host to match a bundled host.                                                                                                                                                                                                                                                                                                                                           |
| `argv`    | JSON array of non-empty strings                                                                          | `argv[0]` is a bare command resolved on `PATH`, or an absolute path. Never relative. Journalled through the existing redaction (`error-text.ts:33-44`).                                                                                                                                                                                                                                            |
| `window`  | **one** window in v1.1: `<Days> <HH:MM>-<HH:MM> <IANA tz>[; mult=<n>][; off=<n>]`                        | `<Days>` is `Mon`…`Sun`, a range `A-B`, or a `+`-joined set (`Sat+Sun`). An end before the start wraps past midnight. It uses an IANA tz, not a fixed offset: RS-14's `peak.tz` is a zone, and fixed offsets lose DST and cannot express `+05:30`. `off=` is the profile-global off-peak multiplier (RS-14 `offPeakMultiplier`). Example: `Mon-Fri 14:00-18:00 Asia/Singapore; mult=1.0; off=0.5`. |

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
   - `CQ_PROFILE ∈ {conservative, solo-maintainer}` (blank ≡ `conservative`) expands to that profile's key values.
     An explicit `CQ_*` beats the profile's value for the same key (per entry for maps, §B.3).
   - The journal and the stderr summary distinguish `profile` from `env` (§B.7).
   - Profiles load **only from the installed toolkit package** (`policy/profiles/<name>.env`, generated from the
     registry, §B.9), never from the workspace, so a PR cannot edit the profile its own checks run under (P1).
   - Custom profiles don't exist: set the keys directly.
   - `CQ_PROFILE` has no per-call form, since a per-call profile would be a wildcard relaxation, which P7 forbids.
   - **Owner-visible delta (G1):** §3.1 describes the profile as values that are "set as repository `vars.*` … and
     shipped as `policy/profiles/solo-maintainer.env`". The `CQ_PROFILE` selector is RS-15's refinement of _how_
     those values arrive. It adds no layer, and setting the individual `vars.*` remains equivalent.
2. **Order classes.** Every key declares one class:
   - **`tighter`**, a conservative order. Per-call movement toward it is free.
   - **`limit`**, a `tighter` key whose blank is "no extra limit": `CQ_BUDGET_MAX_USD`, `CQ_BUDGET_MAX_TOKENS`,
     and the `CQ_GOVERNOR_*` limits.
     - P8 is still met, because `CQ_BUDGET_REQUIRE_CAP=true` refuses unattended governed runs without a cap. Blank
       is conservative _as a posture_, not per key.
     - The class is listed so the owner sees it (§B.13 m6).
     - `CQ_RUN_TOOL` blank `on` is likewise conservative only in composition: it is subject to
       `CQ_SANDBOX=required`, as §3.1 specifies.
   - **`unordered`**, policy-relevant with no order (e.g. `CQ_DRIVER_BINDINGS`, `CQ_MERGE_PROTECTED_BRANCH`). Any
     per-call change needs the key named.
   - **`neutral`**, no policy meaning. A per-call change is free, but a value different from blank is still listed
     in the stderr summary. Neutral keys: `CQ_APPROVAL_LEDGER` (env-only), `CQ_JOURNAL_DIR`,
     `CQ_DRIVER_SESSIONS_DIR` and `CQ_GOVERNOR_CONCURRENCY`.
     - The journal dir scopes the ADR-0003 bound (§2.3: a fresh dir starts at S = 0). That is inherent to ADR-0003
       and accepted there, so surfacing the change is the proportionate control.
     - Concurrency does not move the admission bound (`settled + outstanding + proposed ≤ cap`).
3. **`optIn` shape: ADR-0003's.** `optIn?: readonly GovernanceOptIn[]`, a string array (ADR-0003 §2.1). Each
   element is `'<id>'` or `'<id>=<value>'`. The CLI's repeatable `--opt-in <id>[=<value>]` produces the same array.
   - `GovernanceOptIn` gains the registry's per-call ids as members. This is a generated template-literal union: the
     _element type is extended, not reshaped_, so ADR-0003's main text stands.
   - Entry points outside `runPlan` (self-host, `createDriverFactory`) accept the same `optIn` array.
   - **`'<id>=<value>'`** sets the per-call value and authorises it.
   - **A bare `'<id>'`** means one of three things:
     - (a) for a per-call-only flag (`budget.raiseCap`, `budget.ungovernedOverGoverned`), the flag itself;
     - (b) for a `bool` key, `=true`;
     - (c) for any other key, "I authorise the typed per-call value of this key". For example,
       `--max-usd 10 --opt-in budget.maxUsd` authorises raising the cap to 10.
   - If a typed option and `'<id>=<value>'` both appear and **disagree**, that is a usage error (exit 2).
4. **Per-call rule** (P7; §3.1 "Rules"):
   - A per-call value that is tighter than or equal to the resolved value is always accepted. So is any change to a
     `neutral` key.
   - A less conservative value, or any change to an `unordered` key, is accepted **only if the key is named** in
     `optIn`. No wildcards.
   - A typed per-call option for a registry key (`--max-usd`, `--concurrency`, `classifyPr(…, config)`, and the
     mirrored op inputs of §B.1) resolves through the same rule.
   - Every `call`-layer value is journalled and echoed as a `cq:` stderr notice (§B.7).
5. **No per-call layer** (✗ in §B.8):
   - secrets;
   - `CQ_PROFILE`;
   - `CQ_MERGE_TRUSTED_ASSOCIATIONS`, `CQ_MERGE_BASE_BRANCH`, `CQ_MERGE_PROTECTED_BRANCH`;
   - `CQ_EXTERNAL_INPUT`;
   - `CQ_BUDGET_REQUIRE_CAP`;
   - `CQ_APPROVAL_*`;
   - every `CQ_PROVIDER_*`;
   - every key of type `argv`, or that names an executable or a routing file (`CQ_GH_BIN`,
     `CQ_DRIVER_SUBPROCESS_*`, `CQ_DRIVER_ACP_*`).

   These rows are "—" in §3.1, are P1-trusted-only, or name what gets executed. SDK construction
   (`createDriverFactory({ lanes: … })`) remains possible: it is code, and is journalled as an `sdk` marker.

6. **Per-call-only inputs** (ADR-0003 §2.1, no env key):
   - `budget.legacyJournal=reset`, `budget.raiseCap`, `budget.ungovernedOverGoverned`, `budget.breakLock=<runId>`;
   - `releaseQuarantine: readonly string[]` (job ids, journalled with provenance `call`);
   - `attended`, as a flag only (`--attended` / `{attended:true}`). An env default would make every run "attended"
     silently (ADR-0003 §2.7: operator-declared, unverified).
7. **Resolved once.** Config resolves once per process entry: `cq` CLI main, `runPlan`, self-host entries,
   `createDriverFactory`.
   - The result is frozen and passed down. Env is snapshotted then and never re-read.
   - Ops receive a `ResolvedConfig` and **never read `process.env`**. A W3.6 lint confines `process.env` to
     `src/config/**` and the driver child-env builders, which read FOREIGN names only.
   - This fixes inventory F-2 (`CQ_GH_BIN` is ignored by `pr/ghEffects.ts:107`).
8. **Resume** re-resolves config, and the journal holds each run's record. The cap on resume stays governed by
   ADR-0003 (`budget.raiseCap`). No other cross-run rule is added here.
9. **CI.** The project layer is repository/org/environment `vars.*` mapped in **default-branch** workflow
   definitions (§B.6). GitHub resolves its own env > repo > org order before the toolkit sees the value; the
   toolkit's layer is `env`.
   - **P1-trusted-only keys** (`CQ_APPROVAL_*`) are refused when `GITHUB_EVENT_NAME` is `pull_request`, since the
     workflow definition is head-controlled.
   - The toolkit cannot verify a workflow's provenance beyond that. The template, not the key, carries the rest
     (ADR-0004).

## B.5 Secret vs non-secret split

| Class                 | Members (v1.1)                                                                                                              | Layers                                                                  | CI source                                                                                                                                        | Journal                                                                      | Scrub/redaction                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **CQ secret**         | `CQ_AUTOMATION_TOKEN` (after RS-11: a minted ≤1 h App installation token, never a stored PAT)                               | env only (SDK typed option allowed; no profile, no `--opt-in`, no argv) | `secrets.*` of a default-branch-only environment (`cq-automation`), mapped per step into privileged jobs only (ADR-0004 D-D, RS-11 token matrix) | `{layer, set: true}`: no value, no hash                                      | the name matches `SECRET_ENV_SUFFIXES` (redaction); `CQ_*` scrubbed from worker env **once W1.5 lands** (below) |
| **FOREIGN secret**    | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `ZAI_API_KEY`, `DEEPSEEK_API_KEY`, `GH_TOKEN`/`GITHUB_TOKEN`, route `keyEnv` targets | vendor-read                                                             | `secrets.*` in environments, mapped only into the step that runs the lane                                                                        | presence only (`credentials: {NAME: 'set'}`), which explains lane resolution | existing redaction (`error-text.ts:33-44`), W1.5 scrub                                                          |
| **Non-secret config** | every other `CQ_*`                                                                                                          | all layers per §B.4                                                     | `vars.*` (§B.6)                                                                                                                                  | value + layer (string values pass through the existing redaction)            | `CQ_*` scrubbed from worker env once W1.5 lands (a worker has no need to read policy)                           |

**The rule is by name.** A name is secret iff it ends with one of the existing `SECRET_ENV_SUFFIXES`
(`_API_KEY _TOKEN _AUTH_TOKEN _SECRET _KEY _PASSWORD _CREDENTIALS PRIVATE_KEY`, `error-text.ts:14-23`).

- The registry lint enforces both directions: a secret-classed key must carry a suffix, and a non-secret key must
  not.
- One suffix list therefore drives naming, redaction, journalling and the `vars.*` refusal. They cannot drift
  apart.
- Note that `_TOKENS` (e.g. `CQ_BUDGET_MAX_TOKENS`) does not end with `_TOKEN`.
- The registry lint also checks every routing-table `keyEnv` name (`subprocess/routing.ts`, `claude-agent/routing.ts`)
  against the suffix rule, so a route cannot hand a key through an unredacted name.

**Consequences:**

- The toolkit refuses a secret-classed `CQ_*` found in a profile file.
- `CQ_RUN_ENV_PASSTHROUGH` may not name any `CQ_*`, any secret-suffixed name, or any credential-shaped name.
  Credential-shaped names are the set the subprocess allowlist already excludes by design (`AWS_*`, `NPM_TOKEN`,
  `SSH_AUTH_SOCK`, `GOOGLE_APPLICATION_CREDENTIALS`, `*_URL` names carrying userinfo, `NODE_OPTIONS`, `NODE_PATH`;
  `subprocess/process.ts:57-60`), plus `DATABASE_URL`. A worker can exfiltrate whatever it can read (D14). The deny
  set is registry data, drift-tested against that comment's list.
- `CQ_DRIVER_ACP_ENV_NAMES` may name secret-suffixed vendor keys. That is its purpose (the acp child is the model
  harness). It may not name `CQ_*`.
- **The worker-env scrub is a W1.5 requirement, not current fact.** At `5e52707` the claude-agent and acp lanes and
  the harness `run` tool pass the whole host env (inventory F-1). That includes `CQ_AUTOMATION_TOKEN` wherever it
  is set. Two consequences:
  - Until W1.5 lands, no job that maps `CQ_AUTOMATION_TOKEN` may also run a worker. This is already the P1 job
    split.
  - The `solo-maintainer` profile's `*/anthropic:claude-agent` binding ships **in the same release as W1.5's
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
   - An unset variable renders `''`, which is blank, which is conservative. So mapping **every** key is safe, and
     adding a key never needs a hand edit to each template.
   - Drift-checked with `docs/config.md` (§B.9).
3. **Default-branch definitions only for privileged jobs (P1).** The block is authoritative only in workflows
   whose definition comes from the default branch: `workflow_run`, `schedule`, `push` to the default branch,
   `workflow_dispatch` on the default ref, and `pull_request_target` jobs that never execute head code.
   - A `pull_request` workflow's env is PR-controlled by construction. Its results are advisory under ADR-0004
     and it holds no write token, so its config mapping carries no trust.
4. **Secrets** are never in the generated block. Each privileged job maps its secret per step from its
   environment (`promote`, `cq-verdict`, `cq-automation`; ADR-0004 D-D, RS-11). The D13 drift check keeps
   asserting zero repo-level secrets.
5. **Not in the CI block** (`ci: false`). **Rule: every key of type `path` or `argv`, and every key naming an
   executable, is `ci:false`.** Runner paths and executables are the workflow's own business. The keys are:
   - `CQ_APPROVAL_*`
   - `CQ_JOURNAL_DIR`
   - `CQ_DRIVER_SESSIONS_DIR`
   - `CQ_DRIVER_SUBPROCESS_COMMAND`
   - `CQ_DRIVER_SUBPROCESS_ROUTING`
   - `CQ_DRIVER_ACP_COMMAND`
   - `CQ_GH_BIN`
   - `CQ_PROVIDER_<ID>_PROFILE` with a `custom:` value

   A workflow that needs one maps it explicitly, and path keys must resolve outside the checkout.
   - **Approval signers in CI.** The token annex expects signers "from default-branch `vars.*`", but
     `CQ_APPROVAL_SIGNERS` is a path. The template, owned by W1.9, materialises the file in a default-branch step:
     it writes a variable's content to `$RUNNER_TEMP`, then exports `CQ_APPROVAL_SIGNERS` to that path. The source
     variable's name lies **outside** `CQ_`, so it cannot collide with strict validation.
   - The toolkit refuses `CQ_APPROVAL_*` under `GITHUB_EVENT_NAME=pull_request` (§B.4 item 9).

6. **solo-maintainer on the owner's repos:** one variable, `CQ_PROFILE=solo-maintainer`, plus any per-repo key
   overrides. The profile's expansion is journalled key by key, so one variable doesn't hide what it relaxed.
7. **Renames that must land with W3.6:**
   - `vars.CQ_DRILL_OWNER` → `CQTEST_DRILL_OWNER` (`live-merge.yml:89`; F-9);
   - the self-host `GH_REPOSITORY` fallback → `GH_REPO` (F-8);
   - the template placeholders `{{SELFHOST_TOKEN}}`/`{{SELFHOST_DRIVER_KEY}}` now name environment secrets;
   - the self-host workflows' `max_usd` dispatch input, when non-empty, is passed as
     `--max-usd "$MAX_USD" --opt-in selfhost.maxUsd`. The dispatcher typed it, so it is a named per-call value
     (§B.4 item 3c). Without this, a dispatch above the resolved `CQ_SELFHOST_MAX_USD` would now be refused.

## B.7 Journal provenance

**Placement: ADR-0003's.** The journal annex (`adr-0003-journal-migration.md` §1, `bf5f540`) already reserves
`run-started.governance.config?: ResolvedConfigRecord` ("P7 provenance; shape owned by RS-15 / W3.6"). This annex
fills that type. The placement is not changed.

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

- **Opt-in entries duplicate; they do not replace.** The journal annex keeps its own governance fields
  (`attended`, `allowAdvisory`, `legacyJournal`, `raiseCap{from,to}`, and top-level `ungoverned`).
  - `entries` repeats them in registry form. For example, `entries['budget.raiseCap'] = {value: true, layer: 'call',
relaxed: true, changed: true}`.
  - `releaseQuarantine` job ids are recorded as `entries['budget.releaseQuarantine']` with layer `call`.
  - Replay and fold read the governance fields. `entries` exists for audit.
- **Gap, raised for the ADR-0003 journal-annex owner (not decided here).** `governance` is present only for
  governed runs, so an **ungoverned** run records no config provenance. P7 asks for the resolved value and layer on
  every `run-started`.
  - RS-15 recommends an optional top-level `run-started.config?: ResolvedConfigRecord` for ungoverned runs, with the
    same type, one of the two present.
  - That is a journal-annex change, so it is carried as a reconciliation item (§B.10), not asserted.
- **stderr.**
  - At run start, when any entry is `relaxed` or a neutral entry is `changed`, one summary line is printed, e.g.
    `cq: config: profile=solo-maintainer; relaxed: merge.trustedBots (profile), sandbox (profile), …; changed:
journal.dir (call)`.
  - One `cq: opt-in <id>=<value>` line is printed per `call` relaxation (P7).
- **Fixtures** (W6): matrix rows can be keyed on the `relaxed` set, so an eval result says which policy posture it
  ran under.

## B.8 The keys

Columns: **Type** · **Blank** (the layer-empty value: conservative, or for `limit`-class keys "no extra limit", §B.4 item 2) · **solo-maintainer** (profile value; "—" = not in the profile) ·
**Per-call** (id; ✓ = accepted per §B.4, tighter needs nothing; ✗ = no per-call layer) · **Order** (the tighter
direction) · **Src**.

### B.8.1 Profile

| Key          | Type                                 | Blank          | solo   | Per-call | Order                | Src  |
| ------------ | ------------------------------------ | -------------- | ------ | -------- | -------------------- | ---- |
| `CQ_PROFILE` | enum `conservative\|solo-maintainer` | `conservative` | (self) | ✗        | conservative tighter | §3.1 |

### B.8.2 Merge acceptance (D3, D11; V11PLAN §3.1)

| Key                               | Type                                   | Blank                                            | solo                 | Per-call                     | Order                                                                                  | Src                                                       |
| --------------------------------- | -------------------------------------- | ------------------------------------------------ | -------------------- | ---------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `CQ_MERGE_REQUIRE_HUMAN_APPROVAL` | bool                                   | `true`                                           | `false`              | `merge.requireHumanApproval` | `true` tighter                                                                         | §3.1                                                      |
| `CQ_MERGE_ACCEPT_REVIEW_STATES`   | list<`APPROVED\|COMMENTED`>            | `APPROVED`                                       | `APPROVED,COMMENTED` | `merge.acceptReviewStates`   | subset tighter                                                                         | §3.1                                                      |
| `CQ_MERGE_TRUSTED_BOTS`           | list<login ending `[bot]`> (or `none`) | none: bots never grant acceptance                | `coderabbitai[bot]`  | `merge.trustedBots`          | subset tighter                                                                         | §3.1                                                      |
| `CQ_MERGE_TRUSTED_ASSOCIATIONS`   | list<`OWNER\|MEMBER\|COLLABORATOR`>    | `OWNER,MEMBER,COLLABORATOR`                      | same                 | ✗                            | **subset of blank only, at every layer** (D3 fixes the set; the key can only narrow)   | §3.1                                                      |
| `CQ_MERGE_SETTLE_MS`              | ms                                     | `600000` (`REVIEW_ACCEPT_SETTLE_MS`)             | `600000`             | `merge.settleMs`             | larger tighter                                                                         | §3.1; `classify.config.ts`                                |
| `CQ_MERGE_PROTECTED_PATHS`        | enum `human\|diff-check`               | `human`                                          | `diff-check`         | `merge.protectedPaths`       | `human` tighter                                                                        | D11                                                       |
| `CQ_MERGE_BASE_BRANCH`            | string (ref name)                      | `merge-queue`                                    | —                    | ✗                            | unordered                                                                              | inventory §1, §8                                          |
| `CQ_MERGE_PROTECTED_BRANCH`       | string (ref name)                      | `main`                                           | —                    | ✗                            | unordered                                                                              | inventory §1, §8                                          |
| `CQ_MERGE_EXCLUDED_LOGINS`        | list<login> (or `none`)                | none: only the structural exclusions below apply | —                    | ✗                            | more tighter (**union only**: it can add exclusions, never remove the structural ones) | D2/D3 (**added**; replaces r0's `CQ_AUTOMATION_IDENTITY`) |

**Structural exclusion (STRUCT, no key; D2, P8).** These identities are always removed from the trust set. They are
also rejected if they appear in `CQ_MERGE_TRUSTED_BOTS`:

- the automation identity _derived at run start from the credential in use_ (the App slug `<slug>[bot]` for an
  installation token, `gh api user` otherwise; underivable → acceptance fails closed);
- every RS-11 App bot (`cq-verdict[bot]`, `cq-promoter[bot]`, `cq-automation[bot]`);
- `github-actions[bot]`, since a PR's own workflow can post reviews under that login.

`CQ_MERGE_EXCLUDED_LOGINS` can only add to this set.

- The PR author is excluded by D3 at evaluation time, not by config.

### B.8.3 External input, sandbox and the run tool (D14, RS-13)

| Key                      | Type                                                                                                     | Blank                                                                          | solo            | Per-call             | Order                                                                                                      | Src                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------- | -------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `CQ_EXTERNAL_INPUT`      | enum `ignore` (v1.1 admits no other value)                                                               | `ignore`                                                                       | `ignore`        | ✗                    | —                                                                                                          | §1 non-goal, §3.1                                                                                                                |
| `CQ_SANDBOX`             | enum `required\|off`                                                                                     | `required`                                                                     | `off`           | `sandbox`            | `required` tighter                                                                                         | D14                                                                                                                              |
| `CQ_SANDBOX_BACKEND`     | enum `auto\|landlock\|bwrap\|container\|seatbelt\|cc-native`                                             | `auto` (RS-13 order: Linux landlock→bwrap→container; macOS seatbelt→container) | —               | `sandbox.backend`    | unordered (every value is certified; `cc-native` only with the claude driver and its strict policy, RS-13) | D14, RS-13                                                                                                                       |
| `CQ_SANDBOX_NETWORK`     | enum `model-only\|allow`                                                                                 | `model-only`                                                                   | `allow`         | `sandbox.network`    | `model-only` tighter                                                                                       | D14                                                                                                                              |
| `CQ_SANDBOX_PROXY_URL`   | proxy URL (`http://` or `https://`, since forward proxies commonly use `http://` + CONNECT; no userinfo) | none (with `model-only`, a required sandbox then has no network)               | —               | ✗                    | —                                                                                                          | **reserved** for W1.11 (RS-13: model-only needs an external forward proxy). **Setting it fails** until W1.11 lands (§B.2 item 5) |
| `CQ_RUN_TOOL`            | enum `on\|off`                                                                                           | `on` (subject to `CQ_SANDBOX`)                                                 | `on`            | `run.tool`           | `off` tighter                                                                                              | §3.1 (was `run=off`)                                                                                                             |
| `CQ_RUN_ENV_PASSTHROUGH` | list<env name> (or `none`)                                                                               | none                                                                           | — (per project) | `run.envPassthrough` | subset tighter                                                                                             | §3.1; rejects `CQ_*` and secret-suffixed names                                                                                   |
| `CQ_RUN_COMMANDS`        | list<token-prefix pattern>                                                                               | none (each op's declared allowlist only, e.g. `reviewFixHarness`)              | — (per project) | `run.commands`       | subset tighter                                                                                             | `harness/config.ts:59,143`. **Added** to the op's allowlist for write-capable roles. `re:` patterns stay SDK-only.               |
| `CQ_RUN_TIMEOUT_MS`      | ms (1 000–1 800 000)                                                                                     | `30000`                                                                        | —               | `run.timeoutMs`      | smaller tighter                                                                                            | `harness/config.ts:60,144`                                                                                                       |

### B.8.4 Budget and governor (D5, ADR-0003 Slot D)

| Key                             | Type    | Blank                                                                                                                                                                                                                                                                | solo    | Per-call                                                                        | Order                                               | Src                                                       |
| ------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------- |
| `CQ_BUDGET_ALLOW_ADVISORY`      | bool    | `false`                                                                                                                                                                                                                                                              | `false` | `budget.allowAdvisory` (CLI sugar `--allow-advisory-budget`)                    | `false` tighter                                     | §3.1, ADR-0003                                            |
| `CQ_BUDGET_REQUIRE_CAP`         | bool    | `true`                                                                                                                                                                                                                                                               | `true`  | ✗                                                                               | `true` tighter                                      | §3.1, ADR-0003                                            |
| `CQ_BUDGET_MAX_USD`             | usd     | none (with `REQUIRE_CAP`, unattended governed runs are refused)                                                                                                                                                                                                      | —       | `budget.maxUsd` / `--max-usd` (entry points `cq run-plan` and plan subcommands) | limit                                               | `governor.ts:449,529`                                     |
| `CQ_BUDGET_MAX_TOKENS`          | int     | none                                                                                                                                                                                                                                                                 | —       | `budget.maxTokens` / `--max-tokens`                                             | limit                                               | `governor.ts:456` (ADVISORY on every lane, ADR-0003 §2.4) |
| `CQ_BUDGET_MIN_INNER_USD`       | usd > 0 | `0.01` (`c_min`)                                                                                                                                                                                                                                                     | —       | `budget.minInnerUsd`                                                            | larger tighter                                      | ADR-0003 §2.2 step 3                                      |
| `CQ_BUDGET_MAX_DEFER_MS`        | ms      | `0`                                                                                                                                                                                                                                                                  | —       | `budget.maxDeferMs`                                                             | smaller tighter                                     | ADR-0003 §2.6                                             |
| `CQ_BUDGET_ZOMBIE_GRACE_MS`     | ms      | **`30000` (proposed)**: ≥ 6× the measured worst cooperative settle (≈2 s claude-agent, DD-1) and ≥ the 5 s abort grace. The bound is unaffected (zombies are charged `r` in full), so the value only trades quarantine latency. W2 may re-derive it from the ladder. | —       | `budget.zombieGraceMs`                                                          | smaller tighter                                     | ADR-0003 §2.5                                             |
| `CQ_BUDGET_INVOCATION_USD`      | usd     | none (`p = C / concurrency`, ADR-0003 §2.2)                                                                                                                                                                                                                          | —       | `budget.invocationUsd`                                                          | smaller tighter                                     | ADR-0003 Slot D                                           |
| `CQ_GOVERNOR_CONCURRENCY`       | int ≥ 1 | `4` (today's CLI default)                                                                                                                                                                                                                                            | —       | `governor.concurrency` / `--concurrency`                                        | neutral (the admission bound does not depend on it) | `run-plan.ts:77`                                          |
| `CQ_GOVERNOR_JOB_WALL_CLOCK_MS` | ms      | none (no ladder)                                                                                                                                                                                                                                                     | —       | `governor.jobWallClockMs`                                                       | limit                                               | `governor.ts:458`                                         |
| `CQ_GOVERNOR_MAX_ATTEMPTS`      | int ≥ 1 | none                                                                                                                                                                                                                                                                 | —       | `governor.maxAttempts`                                                          | limit                                               | `governor.ts:464`                                         |
| `CQ_GOVERNOR_DISPATCH_QUOTA`    | int ≥ 1 | none                                                                                                                                                                                                                                                                 | —       | `governor.dispatchQuota`                                                        | limit                                               | `governor.ts:466`                                         |
| `CQ_GOVERNOR_IN_FLIGHT_CEILING` | int ≥ 1 | none                                                                                                                                                                                                                                                                 | —       | `governor.inFlightCeiling`                                                      | limit                                               | `governor.ts:472`                                         |

**Rules:**

- **Cap raise on resume:** still ADR-0003's `budget.raiseCap` (§B.4 item 7).
- **Per-call-only:** `releaseQuarantine` (job ids; ADR-0003 §2.1), `budget.legacyJournal=reset`, `budget.raiseCap`, `budget.ungovernedOverGoverned`,
  `budget.breakLock=<runId>`.
- **Flag only:** `--attended`.

### B.8.5 Approval token (ADR-0003 token annex)

| Key                      | Type                                                | Blank                                                                  | solo | Per-call | Order           | Src                   |
| ------------------------ | --------------------------------------------------- | ---------------------------------------------------------------------- | ---- | -------- | --------------- | --------------------- |
| `CQ_APPROVAL_SIGNERS`    | path (**outside-workspace**; P1-trusted layer only) | none: approval-required jobs → `needs-human`                           | —    | ✗        | unordered       | token annex §4a       |
| `CQ_APPROVAL_LEDGER`     | path (**outside-workspace**)                        | `$XDG_STATE_HOME/cq/approvals.ndjson` (fallback `~/.local/state/cq/…`) | —    | ✗        | neutral         | token annex §5        |
| `CQ_APPROVAL_MAX_TTL_MS` | ms                                                  | `86400000` (24 h)                                                      | —    | ✗        | smaller tighter | ADR-0003 Slot D       |
| `CQ_APPROVAL_KEY*`       | —                                                   | **reserved, denied** (§B.2 item 6)                                     | —    | ✗        | —               | token annex §3 item 5 |

"P1-trusted layer only" is defined operationally:

- `env`, or `profile`, never `call`;
- in CI, only from a default-branch definition;
- and the path must not resolve under the workspace realpath.

### B.8.6 Drivers (ADR-0002 Annex B placeholders)

| Key                              | Type                                                                                                | Blank                                                                                                         | solo                       | Per-call                    | Order                                                                                                              | Src                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `CQ_DRIVER_BINDINGS`             | map `<role\|*>/<provider\|*>:<lane>`                                                                | built-in: `*/zai:ai-sdk,*/anthropic:ai-sdk,*/openai:ai-sdk,*/deepseek:ai-sdk`; other providers throw `config` | `*/anthropic:claude-agent` | `driver.bindings`           | unordered                                                                                                          | ADR-0002 §2.5 (was `CQ_DRIVER_<ROLE>_LANE`-shaped)                          |
| `CQ_DRIVER_SERVED_ALIASES`       | aliases `<lane>/<provider>/<requested>=<served>[\|<served>…]` (§B.3)                                | the built-in layer (RS-14 `servedAliases`; **empty until O-2 is decided**)                                    | —                          | `driver.servedAliases`      | fewer tighter (entries are **added** to the built-in layer per `lane/provider/requested`, never replace the layer) | ADR-0002 §2.6                                                               |
| `CQ_DRIVER_SERVED_UNOBSERVED_OK` | list<lane> (or `none`)                                                                              | none                                                                                                          | —                          | `driver.servedUnobservedOk` | subset tighter; each listed lane is ADVISORY (ADR-0002 §2.6/§6)                                                    | ADR-0002 Annex B                                                            |
| `CQ_DRIVER_SESSION_RETENTION`    | enum `keep\|reap-on-settle`                                                                         | none: each `DriverRequest`'s own value (default `keep`; `review.fixItem` requests reap)                       | —                          | `driver.sessionRetention`   | `keep` tighter (evidence, P5)                                                                                      | ADR-0002 §2.5                                                               |
| `CQ_DRIVER_SESSIONS_DIR`         | path (**outside-workspace**: a worker that can rewrite its session record can rebind its workspace) | `$TMPDIR/cq-harness/sessions`                                                                                 | —                          | `driver.sessionsDir`        | neutral (surfaced as `changed`)                                                                                    | inventory §4.1                                                              |
| `CQ_DRIVER_SUBPROCESS_COMMAND`   | argv                                                                                                | `["claude"]`                                                                                                  | —                          | ✗                           | unordered                                                                                                          | `subprocess/index.ts:243,305`; replaces `sweep.unit` `driver.binary`        |
| `CQ_DRIVER_SUBPROCESS_ROUTING`   | path (**outside-workspace**) to a `RoutingTable` JSON (same strict zod schema)                      | `defaultRoutingTable()`                                                                                       | —                          | ✗                           | unordered                                                                                                          | `subprocess/routing.ts:53-118`; replaces `sweep.unit` `driver.routingTable` |
| `CQ_DRIVER_ACP_ENDPOINT`         | enum (endpoint-table names) `zcode-acp-server\|dsh-acp`                                             | `zcode-acp-server`                                                                                            | —                          | ✗                           | unordered                                                                                                          | `acp/binaries.ts:55,64-83`                                                  |
| `CQ_DRIVER_ACP_COMMAND`          | argv                                                                                                | the endpoint's argv                                                                                           | —                          | ✗                           | unordered                                                                                                          | `acp/index.ts:298,742`                                                      |
| `CQ_DRIVER_ACP_ENV_NAMES`        | list<env name>                                                                                      | none                                                                                                          | —                          | ✗                           | subset tighter; rejects `CQ_*`                                                                                     | `acp/index.ts:310,745`                                                      |

**Binding resolution:** the most specific entry wins: `role/provider` > `role/*` > `*/provider` > `*/*`.

- The role wildcard and this specificity order are **annex semantics**. ADR-0002 §2.5's type (`role → provider →
lane; '*' = any provider`) permits them: role `*` is the default applied to every role not listed.
- Env entries override built-in entries per pair, and `call` entries override env entries.
- Binding `subprocess` is legal only after W1.4 closes its tool surface (the validator reads a registry capability
  flag, so a premature binding fails `config`, per ADR-0002 §2.5).
- **No key disables the served-model comparison** (ADR-0002 Annex B).

### B.8.7 Providers (D5, RS-14, ADR-0003 Slot C) — `CQ_PROVIDER_<ID>_<KEY>`

Bundled `<ID>`s: `ANTHROPIC_API`, `CLAUDE_SUBSCRIPTION`, `ZAI_GLM_CODING`, `DEEPSEEK`, `OPENAI_API`,
`CODEX_CHATGPT`, `OPENCODE_GO`. All keys are env-only (§3.1 "—").

| `<KEY>`            | Type                                                                                                                                                                                                     | Blank                                                                                     | Order                                                                                                                                                                                    | Src / constraint                                                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROFILE`          | `bundled` \| `custom:<path>` (**outside-workspace**, validated against the RS-14 `ProviderProfile` schema)                                                                                               | `bundled` for known ids; required to declare a new id                                     | unordered                                                                                                                                                                                | RS-14 §3                                                                                                                                                              |
| `LIMITS_KNOWN`     | bool                                                                                                                                                                                                     | the profile's value                                                                       | `false` tighter. `true` is accepted **only** if the resolved profile then carries a complete declaration (`cap`, plus `quota.windows` when `accounting:'quota'`); otherwise config error | RS-14 §3                                                                                                                                                              |
| `CAP_AMOUNT`       | number (unit per `cap.kind`: USD or credits)                                                                                                                                                             | the profile's value (usually none: account-specific)                                      | smaller tighter                                                                                                                                                                          | RS-14 `cap.amount` (**added**: bundled profiles cannot know the account's tier/plan)                                                                                  |
| `RPM`              | int                                                                                                                                                                                                      | the profile's `modelLimits` value                                                         | smaller tighter                                                                                                                                                                          | D5 (`CQ_PROVIDER_<ID>_RPM`), RS-14 `modelLimits.rpm` (**added**)                                                                                                      |
| `PEAK_WINDOWS`     | window (one, §B.3)                                                                                                                                                                                       | the profile's `quota.peak` (zai: `Mon-Fri 14:00-18:00 Asia/Singapore; mult=1.0; off=0.5`) | higher `mult` / wider window tighter                                                                                                                                                     | RS-14 (`CQ_PROVIDER_ZAI_PEAK_WINDOWS` → **`CQ_PROVIDER_ZAI_GLM_CODING_PEAK_WINDOWS`**, mechanical id; plural name kept for forward compatibility, one window in v1.1) |
| `WINDOW_FRACTIONS` | map `<windowId>:<fraction>`                                                                                                                                                                              | the profile's value (opencode-go `5h:0.2,weekly:0.5`)                                     | smaller tighter                                                                                                                                                                          | RS-14 (RS-14's `=` becomes `:`, the §B.3 map grammar)                                                                                                                 |
| `QUOTA_ENDPOINT`   | url; **host must equal the bundled profile's usage-endpoint host** (the endpoint is called with the lane's credential, `auth:'same-credentials'`, so a free URL would be a credential-exfiltration knob) | the profile's value                                                                       | unordered                                                                                                                                                                                | RS-14 §3                                                                                                                                                              |
| `MAX_DEFER_MS`     | ms                                                                                                                                                                                                       | = `CQ_BUDGET_MAX_DEFER_MS`                                                                | smaller tighter; **effective = min(global, provider)**: a provider can shorten, never lengthen, the global defer ceiling                                                                 | RS-14                                                                                                                                                                 |

D5's `QUOTA_*` example resolves to `QUOTA_ENDPOINT` and `WINDOW_FRACTIONS`. **Unknown or undeclared limits → the
lane is ADVISORY** (§3.1 row, ADR-0003 §2.4).

### B.8.8 Journal, self-host, GitHub, automation identity

| Key                             | Type                 | Blank                                                                                                                     | solo | Per-call                                                                            | Order                                                                      | Src                                                     |
| ------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------- |
| `CQ_JOURNAL_DIR`                | path                 | none for `cq run-plan` (no journal); self-host: `<repo>/.selfhost/journal`                                                | —    | `journal.dir` / `--journal-dir` / `--journal-root`                                  | neutral (surfaced as `changed`; ADR-0003 §2.3 scopes the bound to one dir) | `kernel/types.ts:103`; `selfhost/config.ts:105-106`     |
| `CQ_SELFHOST_MAX_USD`           | usd                  | `1`                                                                                                                       | —    | `selfhost.maxUsd` / `--max-usd` (entry points `self-merge-prs`, `self-review-loop`) | smaller tighter                                                            | `selfhost/config.ts:42,91`                              |
| `CQ_SELFHOST_JOB_WALL_CLOCK_MS` | ms                   | `300000`                                                                                                                  | —    | `selfhost.jobWallClockMs`                                                           | smaller tighter                                                            | `selfhost/config.ts:52,92`                              |
| `CQ_SELFHOST_MODEL`             | `<provider>/<model>` | `zai/glm-5.3-flash` (today `{provider:'ai-sdk'}`, normalised per ADR-0002 §2.5)                                           | —    | `selfhost.model`                                                                    | unordered                                                                  | `selfhost/config.ts:69,93`                              |
| `CQ_GH_BIN`                     | path or bare command | `gh`                                                                                                                      | —    | ✗                                                                                   | unordered                                                                  | `ratchet/effects.ts:106`; `review/gh.ts:94` (kept name) |
| `CQ_GH_TIMEOUT_MS`              | ms                   | `600000` (the pr family's `DEFAULT_GH_TIMEOUT_MS`; merge/review have none today, F-3, so this is a deliberate tightening) | —    | `gh.timeoutMs`                                                                      | smaller tighter                                                            | `pr/ghEffects.ts:58-61`; inventory F-3                  |
| `CQ_AUTOMATION_TOKEN`           | **secret**           | none (ratchet-propose throws)                                                                                             | —    | ✗                                                                                   | —                                                                          | `ratchet/effects.ts:116-126` (kept name)                |

## B.9 `docs/config.md` and generated artefacts (W3.6)

- **Single source:** `src/config/registry.ts`, one entry per key: `{env, id, domain, type, bounds, blank, order,
layers, secret, ci, outsideWorkspace, profiles:{'solo-maintainer'?}, src, doc}`.
- **Generator** `scripts/gen-config-docs.mjs` (modelled on `scripts/gen-op-docs.mjs`) writes:
  - `docs/config.md`;
  - `policy/profiles/solo-maintainer.env` (packaged in the npm tarball; `package.json` `files`);
  - the `# >>> cq-config` env block in every template and self-host workflow.
- **`package.json`:** `gen:config-docs` and `gen:config-docs:check`.
- **CI:** `ci.yml` runs `gen:config-docs:check` next to `gen:op-docs:check` (`ci.yml:52`).
- **Registry fields** add `order: 'tighter'|'limit'|'unordered'|'neutral'` and `reserved?: string`.
- **Registry lint** (unit test):
  - secret ⇔ secret suffix;
  - per-call ids are unique and mechanical;
  - every `ci:true` key is non-secret;
  - every §3.1 row is present, with its blank and solo values equal to the table.

  The last check is the drift check for this annex against the plan.

The skeleton W3.6 fills is `docs-config-skeleton.md`.

## B.10 Resolutions of the names pending RS-15

| Pending item                                                                                          | Where                                            | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §3.1 "Names are final after RS-15"                                                                    | V11PLAN §3.1                                     | **Confirmed** every `CQ_*` name in the table. Per-call ids made mechanical: `run=off` → **`run.tool=off`**; P7's example `merge.botAcceptance` → **`merge.trustedBots`**; `--allow-advisory-budget` kept as CLI sugar for `budget.allowAdvisory=true`; `sandbox=off` unchanged (bare domain). `CQ_RUN_ENV_PASSTHROUGH` blank spelled `none` (RS-13's informal `=off` is not a value).                                                                       |
| D3 "Variable names are finalised by RS-15"                                                            | V11PLAN §3                                       | `CQ_MERGE_*` (§B.8.2). The D2/D3 automation-identity exclusion is **STRUCT** (derived identity + RS-11 bots + `github-actions[bot]`); `CQ_MERGE_EXCLUDED_LOGINS` can only add to it.                                                                                                                                                                                                                                                                        |
| D5 `CQ_PROVIDER_<ID>_PEAK_WINDOWS`, `_RPM`, `_QUOTA_*` "names per RS-15"                              | V11PLAN §3                                       | **Confirmed family** with refinements (§B.8.7): `<ID>` is the mechanical RS-14 profile id (so zai is `ZAI_GLM_CODING`); `QUOTA_*` = `QUOTA_ENDPOINT` + `WINDOW_FRACTIONS`; `RPM` and `CAP_AMOUNT` added; `QUOTA_ENDPOINT` host-pinned; `LIMITS_KNOWN=true` needs a complete declaration; `MAX_DEFER_MS` = min with the global.                                                                                                                              |
| D14 keys                                                                                              | V11PLAN §3                                       | Confirmed; `CQ_SANDBOX_BACKEND` enum = RS-13's certified set; `CQ_SANDBOX_PROXY_URL` reserved for W1.11 (setting it fails until then).                                                                                                                                                                                                                                                                                                                      |
| ADR-0002 Annex B: factory bindings (`CQ_DRIVER_<ROLE>_LANE`-shaped) + solo `anthropic → claude-agent` | ADR-0002                                         | **`CQ_DRIVER_BINDINGS`** (single map key; roles are an open type) with solo value `*/anthropic:claude-agent`.                                                                                                                                                                                                                                                                                                                                               |
| ADR-0002 Annex B: `CQ_DRIVER_SERVED_ALIASES`                                                          | ADR-0002                                         | Confirmed; additive over the built-in layer; grammar §B.8.6.                                                                                                                                                                                                                                                                                                                                                                                                |
| ADR-0002 Annex B: `CQ_DRIVER_SERVED_UNOBSERVED_OK=<lane,…>`                                           | ADR-0002                                         | Confirmed; blank `none`.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ADR-0002 Annex B: session retention                                                                   | ADR-0002                                         | `CQ_DRIVER_SESSION_RETENTION` (+ `CQ_DRIVER_SESSIONS_DIR`, outside-workspace).                                                                                                                                                                                                                                                                                                                                                                              |
| ADR-0002 Annex B: per-lane construction knobs                                                         | ADR-0002                                         | `CQ_DRIVER_SUBPROCESS_COMMAND`, `CQ_DRIVER_SUBPROCESS_ROUTING`, `CQ_DRIVER_ACP_ENDPOINT`, `CQ_DRIVER_ACP_COMMAND`, `CQ_DRIVER_ACP_ENV_NAMES`; all env-only (executables).                                                                                                                                                                                                                                                                                   |
| ADR-0003 Slot D (9 keys + 4 opt-ins + attended)                                                       | ADR-0003                                         | **All confirmed as named**, each with a per-call id. Blanks filled: `CQ_BUDGET_ZOMBIE_GRACE_MS=30000` (proposed), `CQ_BUDGET_INVOCATION_USD` = none. `CQ_APPROVAL_SIGNERS`/`_LEDGER` are outside-workspace, P1-trusted-only, env-only. `attended` stays a flag only. `releaseQuarantine` (ADR-0003 §2.1) is added as a per-call-only input (it was missing from Slot D's list). Every budget opt-in and key name uses ADR-0003's `optIn` string-array form. |
| RS-14 config-binding table                                                                            | RS-14 §3                                         | As D5 above.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| RS-11 App slugs                                                                                       | RS-11 ("RS-15 finalises config keys, not these") | No key names an App slug. The slugs enter config only as the structural exclusion set (§B.8.2).                                                                                                                                                                                                                                                                                                                                                             |

**Reconciliation open points O-1…O-8** (none is a naming item). Where one touches config:

- **O-2** (which vendor remaps ship built in): the _override surface_ is `CQ_DRIVER_SERVED_ALIASES` (additive).
  The _built-in contents_ remain the owner's decision. Until then the built-in layer is empty and the project can
  add remaps deliberately.
- **O-4** (ADVISORY reservation sizing): if the rule needs a knob, it lives in the `BUDGET` domain and follows
  §B.3/§B.4. None is named here; the rule itself is not RS-15's to invent.
- **O-7** (gate sweep interval): a workflow `schedule` cron in the gate template, i.e. an adopt-time template
  placeholder (`{{GATE_SWEEP_CRON}}`, next to `{{GATE_TIMEOUT_MIN}}`), **not** a `CQ_*` key. A runtime env var
  cannot change a cron trigger.
- O-1, O-3, O-5, O-6, O-8: no configuration surface.

**New cross-ADR items raised by this annex** (for the overseer or reconciliation; none is decided here):

- **R-1 (ADR-0003 journal annex):** config provenance for **ungoverned** runs. RS-15 recommends an optional
  top-level `run-started.config?: ResolvedConfigRecord`, present when `governance` is absent (§B.7).
- **R-2 (ADR-0003 §2.1):** `GovernanceOptIn`'s union gains the registry's per-call ids. The element type is
  extended and the shape is unchanged (§B.4 item 3).
- **R-3 (V11PLAN §7):** a new A-suite row. _A PR-produced plan or artifact consumed by a privileged job cannot relax
  its config_ (§B.1).
- **R-4 (V11PLAN §3.1, owner-visible):** the `CQ_PROFILE` selector as the delivery mechanism for the
  `solo-maintainer` column (§B.4 item 1), and the `limit`-key class (§B.4 item 2).

## B.11 Migration (W3.6)

| From                                                                                                                                                         | To                                                                                                       | Compatibility                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `SelfhostDefaults` (frozen, no override)                                                                                                                     | built-in layer of `CQ_SELFHOST_*`, `CQ_MERGE_BASE_BRANCH`, `CQ_MERGE_PROTECTED_BRANCH`, `CQ_JOURNAL_DIR` | same defaults                                                                                                                      |
| `sweep.unit` plan JSON `driver.binary` / `driver.routingTable`                                                                                               | `CQ_DRIVER_SUBPROCESS_COMMAND` / `_ROUTING`                                                              | plan fields rejected after the ADR-0002 slice (P1)                                                                                 |
| `GH_REPOSITORY` fallback                                                                                                                                     | `GH_REPO` (FOREIGN)                                                                                      | accept both for v1.1, with a `cq:` deprecation notice for `GH_REPOSITORY`                                                          |
| `vars.CQ_DRILL_OWNER`                                                                                                                                        | `CQTEST_DRILL_OWNER`                                                                                     | rename in the same PR that turns on strict validation                                                                              |
| `ops/**` direct `process.env` reads                                                                                                                          | `ResolvedConfig`                                                                                         | lint-enforced (§B.4 item 7)                                                                                                        |
| op inputs mirroring registry keys: merge `protectedBranch` (reg `:273-281,327`), `RunMergePrsInput.baseBranch`, `resolveConflict`/`sweep.unit` `sessionsDir` | resolved config                                                                                          | validated against the resolved value from the W3.6 slice (✗ keys: must be equal); fields deleted when their callers migrate (§B.1) |
| self-host `max_usd` dispatch input above `CQ_SELFHOST_MAX_USD`                                                                                               | `--max-usd <v> --opt-in selfhost.maxUsd`                                                                 | **behaviour change:** without the opt-in it is refused. Templates pass the opt-in when the input is non-empty (§B.6 item 7)        |
| merge/review gh/git runners with no timeout                                                                                                                  | `CQ_GH_TIMEOUT_MS` blank `600000`                                                                        | **behaviour change:** tightening (F-3)                                                                                             |
| `--concurrency` above 4                                                                                                                                      | unchanged                                                                                                | `CQ_GOVERNOR_CONCURRENCY` is `neutral`, so no opt-in is needed and no break                                                        |
| repo secrets `GH_TOKEN`, `Z_AI_API_KEY`, `PROMOTE_TOKEN`, `CQ_AUTOMATION_TOKEN`                                                                              | environment secrets (ADR-0004 C1, RS-11)                                                                 | ADR-0004 cutover owns the order                                                                                                    |

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
- **Env-configurable pricing:** see §B.1 (no checkable direction; DoD 2 bound integrity).

## B.13 Critic r1 dispositions (independent critic pass, same day; ITERATE → folded)

| #      | Sev   | Finding                                                                                                                      | Disposition                                                                                                                                                                                                                                                                                                                           |
| ------ | ----- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1      | major | Blank-vs-profile contradiction; profile layer vs P7's three layers; map merge unspecified                                    | **Fixed.** Blank = "layer sets nothing". The invariant is restated with `CQ_PROFILE` blank. The profile is a seed inside the env layer. `none` clears. Maps merge per entry. Owner delta R-4 (§B.3, §B.4.1, §B.10).                                                                                                                   |
| 2      | major | Plan data and op inputs get around the per-call rule (`protectedBranch`, `baseBranch`, `sessionsDir`, review `skipPatterns`) | **Fixed.** A normative "never from plan/op input/workspace" rule, validation of mirrored fields, migration rows, `skipPatterns` reclassified as CALL with a P1 note, and A-suite row R-3 (§B.1, §B.11).                                                                                                                               |
| 3      | major | `CQ_AUTOMATION_IDENTITY` put a key on the D2 correctness rule                                                                | **Fixed.** The key is removed and the exclusion is STRUCT (derived identity + RS-11 bots + `github-actions[bot]`). `CQ_MERGE_EXCLUDED_LOGINS` is union-only (§B.8.2).                                                                                                                                                                 |
| 4      | major | SDK `optIn` object shape contradicts ADR-0003's `readonly GovernanceOptIn[]`                                                 | **Fixed.** Uses ADR-0003's string array. Bare-id semantics defined. A disagreement between a typed flag and `--opt-in` is exit 2. Union extension is item R-2 (§B.4.3).                                                                                                                                                               |
| 5      | major | Journal placement contradicts the journal annex                                                                              | **Fixed.** Now `governance.config: ResolvedConfigRecord`. Opt-in entries duplicate the governance fields rather than replace them. The ungoverned gap is item R-1 (§B.7).                                                                                                                                                             |
| m6     | minor | Some blanks are the loosest end of their order; `CQ_GH_TIMEOUT_MS` had no blank                                              | **Fixed.** A `limit` class, backstopped by `REQUIRE_CAP`. The `CQ_RUN_TOOL` composition is noted. The GH timeout blank is `600000`.                                                                                                                                                                                                   |
| m7     | minor | Journal and sessions dir changes are silent                                                                                  | **Fixed.** Both stay `neutral` but are surfaced as `changed` on stderr and in the journal.                                                                                                                                                                                                                                            |
| m8     | minor | `relaxed` is undefined for unordered keys                                                                                    | **Fixed.** Unordered keys use `value ≠ blank`, and a `changed` flag is added.                                                                                                                                                                                                                                                         |
| m9     | minor | Grammar: model ids containing `:` or `/`; windows; `none`; the `<ID>` charset                                                | **Fixed.** Added the `aliases` type (`=` separator), the `model` type and token charsets. Windows are limited to one per v1.1, use an IANA tz, and define days and midnight wrap. `none` must be the sole item. Bot logins must end in `[bot]`. The id charset now gives an exact reverse mapping, and provider ids are journal-only. |
| m10    | minor | The CI yes/no rule was inconsistent                                                                                          | **Fixed.** One rule: every `path`/`argv`/executable key is `ci:false`.                                                                                                                                                                                                                                                                |
| m11    | minor | Behaviour of reserved keys was undefined; proxy scheme                                                                       | **Fixed.** Setting a reserved key fails. The proxy accepts `http`/`https` with no userinfo.                                                                                                                                                                                                                                           |
| m12    | minor | Secrets reachable through URL/argv values; the passthrough gate is too narrow; `keyEnv` unchecked                            | **Fixed.** URLs may carry no userinfo or query. Journalled strings are redacted. A credential-shaped passthrough deny set is added. `keyEnv` names are linted.                                                                                                                                                                        |
| m13    | minor | Worker scrub stated as current fact                                                                                          | **Fixed.** It is now a W1.5 requirement. The solo claude-agent binding ships with the W1.5 scrub (§B.5).                                                                                                                                                                                                                              |
| m14    | minor | `releaseQuarantine` missing                                                                                                  | **Fixed.** Now a per-call-only input (§B.4.6, §B.8.4, §B.7).                                                                                                                                                                                                                                                                          |
| m15    | minor | Migration behaviour changes not recorded; which entry point `--max-usd` maps to                                              | **Fixed.** Migration rows added, `--concurrency` made neutral, entry points named.                                                                                                                                                                                                                                                    |
| m16    | minor | Approval signers in CI can't be enforced                                                                                     | **Fixed.** Template materialisation (W1.9), a source var outside `CQ_`, and a refusal under `pull_request` (§B.6.5, §B.4.9).                                                                                                                                                                                                          |
| m17    | minor | The role wildcard is invented                                                                                                | **Fixed.** Marked as annex semantics that the ADR's type permits.                                                                                                                                                                                                                                                                     |
| n18–21 | nit   | Section pointer, pricing journal form, missing `CQ_PROFILE` row in the skeleton, type-name drift                             | **Fixed** in the inventory and skeleton. The type is `ResolvedConfigRecord` throughout.                                                                                                                                                                                                                                               |
| Q      | open  | Is `CQ_BUDGET_INVOCATION_USD` really "smaller tighter" given `r = max(p, floor)`? Should the protected branch be a list?     | Kept "smaller tighter": a smaller `p` never raises any reservation above `max(p, floor)`. A single protected branch is kept for v1.1 (the ADR-0004 rulesets protect one trust ref).                                                                                                                                                   |
