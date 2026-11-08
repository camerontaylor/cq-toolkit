# Environment configuration

Generated from the env registry by [`scripts/gen-config-docs.mjs`](../scripts/gen-config-docs.mjs).
Do not edit by hand — run `pnpm run gen:config-docs`. The contract is
[ADR-0009](adr/0009-config-contract-v2.md): names warn, values fail; blank means conservative.

## CQ_* names

`blank` is what an unset or empty value means: `conservative` is the strictest safe built-in,
`neutral` is a value with no safety effect. `trust` keys never come from `cq.json`, plan data or
op input. `secret` values are never printed.

| Name | Kind | Trust | Blank | Status | Secret | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `CQ_APPROVAL_SIGNERS` | config | yes | conservative | live | no | Operator-ledger signers allowed to approve. |
| `CQ_AUTHOR_REPO` | config | no | neutral | live | no | Repository path the review-transport author side works in. |
| `CQ_AUTHOR_SNAPSHOT_SCANNER` | config | no | neutral | live | no | Snapshot scanner command for the review transport and review.submit (an explicit scanner input wins). |
| `CQ_AUTHOR_SSH_ALIAS` | config | no | neutral | live | no | SSH alias of the author host for the review transport. |
| `CQ_AUTOMATION_TOKEN` | config | yes | conservative | live | yes | Automation credential mapped to GH_TOKEN for gh (no ambient fallback). |
| `CQ_DIST_PREPARED` | test | no | neutral | live | no | Set to 1 by the repo test runners when dist is already fresh (read by test/global-setup.ts). |
| `CQ_GH_BIN` | config | no | neutral | live | no | Path or name of the gh binary (default gh). |
| `CQ_MERGE_ACCEPT_REVIEW_STATES` | config | yes | conservative | live | no | Review states that count as acceptance (blank: APPROVED only). |
| `CQ_MERGE_BASE_BRANCH` | config | yes | conservative | live | no | Base branch the self-merge flow targets. |
| `CQ_MERGE_PROTECTED_BRANCH` | config | yes | conservative | live | no | Branch merge pushes may never target; plan data cannot override it (blank: main). |
| `CQ_MERGE_PROTECTED_PATHS` | config | yes | conservative | live | no | Protected-paths posture: human, diff-check or advisory (blank: human). |
| `CQ_MERGE_TRUSTED_ASSOCIATIONS` | config | yes | conservative | live | no | Trusted author associations (blank: OWNER, MEMBER, COLLABORATOR). |
| `CQ_MERGE_TRUSTED_BOTS` | config | yes | conservative | live | no | Trusted bot logins (blank: none). |
| `CQ_PARENT_WORK_ID` | identity | no | neutral | live | no | Parent work id stamped into child environments. |
| `CQ_PRODUCER_VERSION` | config | no | neutral | live | no | Producer version stamped into run provenance (default: the toolkit package version). |
| `CQ_QUEUE_SSH_ALIAS` | config | no | neutral | live | no | SSH alias of the review queue host. |
| `CQ_RESOURCE_SCOPED` | test | no | neutral | live | no | Set to 1 by the repo scripts once they run inside a memory scope (scripts/lib/resource-scope.mjs). |
| `CQ_REVIEW_NOTIFY_HOST` | config | no | neutral | live | no | Paseo host:port override for local-review completion notifications; defaults to the lowercase short OS hostname on port 6767, or null if unusable. |
| `CQ_ROLE` | identity | no | neutral | live | no | Role label stamped into child environments. |
| `CQ_RUN_ENV_PASSTHROUGH` | config | yes | conservative | live | no | Extra env names copied into run children (blank: none). |
| `CQ_RUN_ID` | identity | no | neutral | live | no | Run id stamped into child environments. |
| `CQ_RUN_TOOL` | config | yes | conservative | live | no | Run tool on or off (blank: on, still withheld under a required sandbox). |
| `CQ_SANDBOX` | config | yes | conservative | live | no | Sandbox mode off or required (blank: required). |
| `CQ_SANDBOX_BACKEND` | config | yes | conservative | live | no | Sandbox backend (blank: auto). |
| `CQ_SANDBOX_NETWORK` | config | yes | conservative | live | no | Requested egress posture model-only or allow (blank: model-only). |
| `CQ_SELFHOST_DRIVER` | config | no | neutral | live | no | Off-peak selfhost driver as provider/model. |
| `CQ_SELFHOST_NOW_MS` | test | no | neutral | live | no | Pinned run-start epoch-ms for the selfhost review loop. |
| `CQ_SELFHOST_PEAK_DRIVER` | config | no | neutral | live | no | Peak-window selfhost driver as provider/model. |
| `CQ_SESSIONS_DIR` | config | no | neutral | live | no | Directory driver session files are written to. |
| `CQ_SESSION_LOGS` | config | no | neutral | live | no | Session-log destination for driver runs. |
| `CQ_TASK` | identity | no | neutral | live | no | Task label stamped into child environments. |
| `CQ_WORK_ID` | identity | no | neutral | live | no | Work id stamped into child environments. |
| `CQ_APPROVAL_KEY*` | prefix | no | - | denied | yes | Approval keys never come from the environment. Setting it is an error. |

## Foreign names

Read by drivers, forge adapters and selfhost entries. They are never warned on. A secret name records
presence only. `_URL` is not a secret suffix: a URL value is shown and recorded with userinfo, query and
fragment stripped, or `[redacted-url]` when it does not parse (ADR-0009).

| Name | Secret | Description |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | Anthropic API key (claude-code and ai-sdk drivers). |
| `ANTHROPIC_AUTH_TOKEN` | yes | Anthropic auth token injected into claude-code children. |
| `ANTHROPIC_BASE_URL` | no | Anthropic endpoint override. |
| `DEEPSEEK_ANTHROPIC_BASE_URL` | no | DeepSeek Anthropic-compatible endpoint override. |
| `DEEPSEEK_API_KEY` | yes | DeepSeek API key. |
| `GH_REPOSITORY` | no | Repository slug default for selfhost entries. |
| `GH_TOKEN` | yes | GitHub token read by gh. |
| `GITHUB_REPOSITORY` | no | Repository slug set by GitHub Actions. |
| `GITHUB_TOKEN` | yes | GitHub Actions token (removed from gh children). |
| `NPM_TOKEN` | yes | npm publish token (kept out of child environments). |
| `OPENAI_API_KEY` | yes | OpenAI API key. |
| `OPENCODE_GO_API_KEY` | yes | OpenCode Go API key. |
| `OPENCODE_GO_BASE_URL` | no | OpenCode Go endpoint (required, no default). |
| `PASEO_AGENT_ID` | no | Current Paseo agent notification destination. |
| `ZAI_ANTHROPIC_BASE_URL` | no | Z.ai Anthropic-compatible endpoint override. |
| `ZAI_API_KEY` | yes | Z.ai API key. |
| `ZAI_BASE_URL` | no | Z.ai ai-sdk endpoint override. |
