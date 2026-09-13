# Dependency re-verification — 2026-09 (T0.5, DD-8)

This document is the re-verification required by the 6-week staleness rule
(DD-8): the R1/R2 dependency research was current as of 2026-09-12, and this
record re-checks every fact below directly at its source. Source of truth for
versions is the npm registry (https://registry.npmjs.org) plus, for gitleaks,
the GitHub release. All checks dated 2026-09-14. Per the lane brief's dependency
rule, T1.4 re-confirms the `ai` / `@ai-sdk/*` pins before driver work begins —
this record is the input to that confirmation, not a substitute for it.

## Runtime dependencies (npm registry, checked 2026-09-14)

| package | current version | license (SPDX, registry) | this repo's pin |
| --- | --- | --- | --- |
| `ai` | 7.0.99 (current 7.x release) | Apache-2.0 | 7.0.99 |
| `@ai-sdk/anthropic` | 4.0.53 | Apache-2.0 | 4.0.53 |
| `@ai-sdk/openai` | 4.0.66 | Apache-2.0 | 4.0.66 |
| `@ai-sdk/zai` | 3.0.10 | Apache-2.0 | 3.0.10 |
| `@ai-sdk/deepseek` | 3.0.44 | Apache-2.0 | 3.0.44 |
| `p-limit` | 7.3.2 | MIT | 7.3.2 |

Every pin is at the registry-current version as of 2026-09-14 — nothing is
stale; the leader saw the same 7.0.99 for `ai` at pin time. Authoritative full
license texts: Apache-2.0 at https://spdx.org/licenses/Apache-2.0.html, MIT at
https://spdx.org/licenses/MIT.html (each package also ships the text in its
published tarball).

## `@anthropic-ai/claude-agent-sdk` (optional peer dependency)

Current version 0.3.270; this repo pins it at 0.3.270 as an optional
peerDependency. The registry license field reads, verbatim: `SEE LICENSE IN
README.md`. The published 0.3.270 tarball's README in fact carries no license
text at all — the actual terms ship in the tarball's LICENSE.md, which states:
"© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements
outlined here: https://code.claude.com/docs/en/legal-and-compliance" (read from
https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.270.tgz,
2026-09-14). So the license is not an OSI/SPDX license but Anthropic PBC's
legal-agreement terms. It ships as an optional peer here precisely so consumers
of this toolkit are not bound by those terms.

## gitleaks (CI tool, not an npm dependency of this package)

The gitleaks this repo uses is the Go release pinned — version plus tarball
digest — in `.github/workflows/denylist.yml`: v8.30.1
(https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1). Its license is MIT,
per the GitHub repository metadata (https://api.github.com/repos/gitleaks/gitleaks,
`license.spdx_id` = MIT, checked 2026-09-14); full text at
https://github.com/gitleaks/gitleaks/blob/master/LICENSE. Disambiguation: the
unrelated npm package named `gitleaks` (version 1.0.0, ISC,
https://registry.npmjs.org/gitleaks) is NOT this tool and is not used here in
any way — the tool comes from the digest-pinned GitHub release only.

## models.dev data license (the DD-3 input for T1.4)

- Repository: https://github.com/anomalyco/models.dev — the community-maintained
  database behind https://models.dev/ ("An open-source database of AI models",
  per the site). The site footer's edit link points at `sst/models.dev`, which
  GitHub redirects to `anomalyco/models.dev` (checked 2026-09-14).
- License, quoted from the repository's LICENSE file
  (https://github.com/anomalyco/models.dev/blob/dev/LICENSE, read 2026-09-14):
  it opens "MIT License / Copyright (c) 2025 models.dev / Permission is hereby
  granted, free of charge, to any person obtaining a copy of this software and
  associated documentation files..." — the standard MIT grant; GitHub's license
  metadata agrees (`spdx_id` MIT).
- Verdict: vendoring-allowed — the data repository is MIT-licensed, whose grant
  permits copying and redistribution provided the copyright notice is preserved.

## ADR revisit triggers (status as of 2026-09-14)

| trigger | status | evidence |
| --- | --- | --- |
| AI SDK HarnessAgent stabilizes | not fired | docs still say "Harness packages are experimental. Expect breaking changes between releases as this early API gets further refined." — https://ai-sdk.dev/docs/ai-sdk-harnesses/overview (2026-09-14) |
| pi publishes a stability/semver statement | not fired | pi coding agent still 0.x (0.73.1) with breaking changes documented in its changelog; no statement found — https://www.npmjs.com/package/@mariozechner/pi-coding-agent and https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md (2026-09-14) |
| models.dev license verified | fired — answered by this document | MIT; see the verdict above. T1.4 may vendor the data with the copyright notice preserved |
| Anthropic blesses non-Claude routing through the Agent SDK | not fired | no such statement found in the 0.3.270 README or the official docs — https://code.claude.com/docs/en/agent-sdk/overview (2026-09-14) |
| codex-sdk matures | not fired | `@openai/codex-sdk` remains pre-1.0 (0.154.0, https://registry.npmjs.org/@openai/codex-sdk, 2026-09-14); no stability statement found |
| R1 staleness / 6-week re-verify | fired — discharged by this document | this record IS that re-verification (R1/R2 were current as of 2026-09-12) |
