# Workflow templates

PRs target `main`: require `static` and `denylist` and one independent exact-head
review comment. CRQ reviews after merge. See [merge policy](../../docs/promotion-policy.md).

## Files

`instances.json` is the inventory of rendered workflows. Queue bootstrap,
synchronization and promotion templates are retired. The cq-* workflows report
advisory PR verdicts; the self-host workflows review and merge main PRs.

## Placeholder tokens

Every literal `{{TOKEN}}` in a template file is replaced by its literal
value at instantiation time, and nothing else in the file changes — with
one deliberate exception: `{{COMMANDS...}}` (last table row) names a
HAND-REPLACED slot, not a token. No literal `{{COMMANDS...}}` placeholder
appears in `required-check.md` — the worked example carries this repo's
real run steps — so an adopter swaps those steps by hand rather than by
substitution.

| token                     | used by                              | meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{{DRILL_SECRET}}`        | live-merge                           | NAME of the `drill` environment secret holding the drill credential (this repo: `CQ_DRILL_MERGE_TOKEN`): a classic token with `repo` plus `read:org` (see the template header). Never the promotion credential, and never `GH_TOKEN`, which in `drill` is live-review's fine-grained scratch-repo PAT.                                                                                                                                                           |
| `{{RUNNER}}`              | required-check.md, affected-tests.md | `runs-on` label, e.g. `ubuntu-latest`                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `{{NODE_VERSION}}`        | required-check.md, affected-tests.md | Node version for `setup-node`                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `{{INSTALL_CMD}}`         | required-check.md, affected-tests.md | dependency install command, e.g. `pnpm install --frozen-lockfile`; the templates' `pnpm/action-setup` step and `cache: pnpm` assume pnpm, so swap them with it                                                                                                                                                                                                                                                                                                   |
| `{{COMMANDS...}}`         | required-check.md                    | HAND-REPLACED slot (see above): the variadic ordered run-steps of the static job. The template carries this repo's filling: one `uses: ./.github/actions/static-gate` step, the repo-owned composite action holding the seven steps — static gate, format check, `test:unit`, `test:e2e`, Knip, build, generated-op-docs drift — that the macOS venue shares. An adopter replaces that step by hand with their own commands; no placeholder text is substituted. |
| `{{SELFHOST_DRIVER_KEY}}` | self-host workflows                  | NAME of the `automation` environment secret holding the model-provider API key the review-fix workers' driver reads (`ZAI_API_KEY` at run time) — instantiated files reference it as `${{ secrets.<name> }}`; a name, never a value                                                                                                                                                                                                                              |

The automation App's per-run mint carries NO placeholder: `self-merge-prs`,
`self-review-loop` and
`ratchet-propose` all name the `automation` environment secret
`CQ_AUTOMATION_APP_KEY` and the `CQ_AUTOMATION_APP_CLIENT_ID` repository
variable literally, so each adopter sets them under those names. The interim
`{{AUTOMATION_SECRET}}`/`{{INTERIM_SECRET}}`/`{{INTERIM_FALLBACK}}` and
`{{SELFHOST_TOKEN}}` placeholders are retired — no template uses them any
more (the automation credential is never a stored PAT).

Literal names (no token; the same in every instantiation): the verdict
posters (`cq-policy`, `cq-verify`, `cq-accept`) and `settings-drift` read
`CQ_VERDICT_APP_KEY` from environment `cq-verdict`; `settings-drift` falls
back to the interim read-only fine-grained PAT `CQ_SETTINGS_TOKEN` there
(Administration, Environments, Secrets and Actions: read; the Actions event
policy, which GitHub serves only to Administration: write, is reported
unchecked and covered by the owner-run `--require-event-policy` check).
App minting requires the corresponding `vars.CQ_*_APP_CLIENT_ID` variable.
Self-merge configuration includes `vars.CQ_MERGE_TRUSTED_BOTS`, `vars.CQ_MERGE_ACCEPT_REVIEW_STATES`,
`vars.CQ_MERGE_TRUSTED_ASSOCIATIONS` and the posture
`vars.CQ_MERGE_PROTECTED_PATHS` (blank = the conservative default). Human review comments containing the exact head SHA and `PASS` count for
shared-account agents without an opt-in; Bot authors and `[bot]` logins are
excluded. The legacy `CQ_MERGE_ALLOW_SAME_ACCOUNT_AGENT_REVIEW` setting is
retained for configuration compatibility and no longer controls matching.

**Advisory posture (development).** `vars.CQ_MERGE_PROTECTED_PATHS=advisory`
is this repository's development posture (2026-10-20; see
[docs/protected-scope.md](../../docs/protected-scope.md#advisory-posture-development-2026-10-20)).
Only a path the trust ref's `policy/protected-paths.json` names (the
privileged list), a loosened baseline, or a removed ratchet target or
definition/policy-list entry still needs a human; `lint` still fails; every
other finding is an `advisory:` line in the run report. An adopter that wants
the conservative behaviour leaves the variable blank (`human`).

## How instantiation works

Edit templates, then run `node scripts/render-templates.mjs --write`.
`node scripts/render-templates.mjs --check` verifies the generated copies.
The instance table supplies token values; preserve the provenance header.

## The bootstrap rule

`ci.yml` and `denylist.yml` hand-carry the documented `required-check.md` pattern;
their job bodies are repository-specific, so they are not rendered from YAML
slots. The static job calls the shared static-gate composite action. An adopter
supplies its own commands in the documentation template's COMMANDS slot.
Required check workflows never filter PR triggers. Their check-run names,
not workflow names, are used in repository settings.

## Action pinning

Every action reference is pinned to an immutable commit SHA. Required-check
jobs set `persist-credentials: false`: the checkout token must not survive into
repository code. Advisory trusted verifiers fetch with step-scoped read-only
credentials; their signing jobs never run head-authored code.
