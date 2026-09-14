# Dependency re-verification — 2026-09 (T0.5, DD-8)

> **Plan identifiers:** `T0.5`, `DD-3`, `DD-8`, `R1`/`R2`, and `T1.4` come from
> the toolkit's development plan, maintained outside this repo (private research
> notes). Inlined rules: DD-8 = "re-verify dependency versions and licenses
> before implementation starts (6-week staleness rule)"; DD-3 = "verify the
> models.dev pricing-data license before vendoring the price map".

This document is the re-verification required by the 6-week staleness rule
(DD-8): the R1/R2 dependency research was current as of 2026-09-12, and this
record re-checks every fact below directly at its source. Source of truth for
versions is the npm registry (https://registry.npmjs.org) plus, for gitleaks,
the GitHub release. The "this repo's pin" column below mirrors this repo's
authoritative pin sources — package.json for the npm pins and
.github/workflows/denylist.yml for the gitleaks version-and-digest pin. All
checks were executed 2026-09-13 (UTC); this write-up was committed 2026-09-14.
Per the lane brief's dependency rule, T1.4
re-confirms the `ai` / `@ai-sdk/*` pins before driver work begins — this
record is the input to that confirmation, not a substitute for it.

## Runtime dependencies (npm registry, checked 2026-09-13)

| package | current version | license (SPDX, registry) | this repo's pin |
| --- | --- | --- | --- |
| `ai` | 7.0.99 (current 7.x release) | Apache-2.0 | 7.0.99 |
| `@ai-sdk/anthropic` | 4.0.53 | Apache-2.0 | 4.0.53 |
| `@ai-sdk/openai` | 4.0.66 | Apache-2.0 | 4.0.66 |
| `@ai-sdk/zai` | 3.0.10 | Apache-2.0 | 3.0.10 |
| `@ai-sdk/deepseek` | 3.0.44 | Apache-2.0 | 3.0.44 |
| `p-limit` | 7.3.2 | MIT | 7.3.2 |
| `zod` | 4.6.4 | MIT | 4.6.4 |
| `proper-lockfile` | 4.1.2 | MIT | 4.1.2 |
| `@ast-grep/napi` | 0.45.3 | MIT | 0.45.3 |

Every pin is at the registry-current version as of 2026-09-13 — nothing is
stale; the leader saw the same 7.0.99 for `ai` at pin time. The nine rows
above cover every runtime dependency in package.json; the devDependencies
(the `typescript` 6 alias chain, `vitest`, the eslint set, and `@types/node`)
are installed from the lockfile by `npm ci` (lockfile/manifest consistency
only — not registry currency), so they are out of scope for this table.
Authoritative full license texts: Apache-2.0 at
https://spdx.org/licenses/Apache-2.0.html, MIT at
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
2026-09-13). So the license is not an OSI/SPDX license but Anthropic PBC's
legal-agreement terms. This SDK ships as an optional peer dependency: npm
installs it only when a consumer explicitly opts in, so a consumer who never
installs it never receives those terms. That is an omission of the dependency,
not a licence exemption — a consumer who does install or use
`@anthropic-ai/claude-agent-sdk` is bound by its LICENSE.md terms like any
other licensee. The optional-peer marking governs what npm fetches by default;
it does not opt anyone out of terms accepted by installing.

## gitleaks (CI tool, not an npm dependency of this package)

The gitleaks this repo uses is the Go release pinned — version plus tarball
digest — in `.github/workflows/denylist.yml`: v8.30.1
(https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1). Its license is MIT,
per the GitHub repository metadata (https://api.github.com/repos/gitleaks/gitleaks,
`license.spdx_id` = MIT, checked 2026-09-13); full text at
https://github.com/gitleaks/gitleaks/blob/master/LICENSE. Disambiguation: the
unrelated npm package named `gitleaks` (version 1.0.0, ISC,
https://registry.npmjs.org/gitleaks) is NOT this tool and is not used here in
any way — the tool comes from the digest-pinned GitHub release only.

## models.dev data license (the DD-3 input for T1.4)

- Repository: https://github.com/anomalyco/models.dev — the community-maintained
  database behind https://models.dev/ ("An open-source database of AI models",
  per the site). The site footer's edit link points at `sst/models.dev`, which
  GitHub redirects to `anomalyco/models.dev` (checked 2026-09-13).
- License, quoted from the repository's LICENSE file
  (https://github.com/anomalyco/models.dev/blob/dev/LICENSE, read 2026-09-13):
  it opens "MIT License / Copyright (c) 2025 models.dev / Permission is hereby
  granted, free of charge, to any person obtaining a copy of this software and
  associated documentation files..." — the standard MIT grant; GitHub's license
  metadata agrees (`spdx_id` MIT).
- Verdict: vendoring-allowed — for the data classes this toolkit actually
  vendors: the per-model pricing entries (model id, display name, USD per
  million input/output tokens) for the eval-matrix families (claude, gpt,
  glm, deepseek), transcribed from the provider pages into the TypeScript
  table `src/driver/pricing/data.ts`. Terms basis: the upstream repository's
  root MIT LICENSE covers the repository's content, including its data files
  (the upstream README describes the same data as per-provider/per-model TOML
  with per-model `license` fields and links); the per-model `license` field
  describes each MODEL's own terms, not the terms of the pricing data itself,
  so it does not restrict copying the data. The MIT grant requires the
  copyright notice — preserved in `data.ts`'s header, as the grant requires.

## ADR revisit triggers (status as of 2026-09-13)

| trigger | status | evidence |
| --- | --- | --- |
| AI SDK HarnessAgent stabilizes | not fired | docs still say "Harness packages are experimental. Expect breaking changes between releases as this early API gets further refined." — https://ai-sdk.dev/docs/ai-sdk-harnesses/overview (2026-09-13) |
| pi publishes a stability/semver statement | not fired | pi coding agent still 0.x — 0.85.1 at `@earendil-works/pi-coding-agent` (MIT, registry), the maintained name; the original `@mariozechner/pi-coding-agent` (0.73.1) is deprecated at the registry in its favor ("please use @earendil-works/pi-coding-agent instead going forward"); breaking changes documented in its changelog, no stability statement found — https://www.npmjs.com/package/@earendil-works/pi-coding-agent and https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md (2026-09-13) |
| models.dev license verified | fired — answered by this document | MIT for the vendored scope — the eval-matrix pricing entries now transcribed into `src/driver/pricing/data.ts` (the upstream root MIT covers its data files; per-model `license` fields describe the models' own terms, not the data's); see the verdict above. T1.4 may vendor that scope with the copyright notice preserved |
| Anthropic blesses non-Claude routing through the Agent SDK | not fired | no such statement found in the 0.3.270 README or the official docs — https://code.claude.com/docs/en/agent-sdk/overview (2026-09-13) |
| codex-sdk matures | not fired | `@openai/codex-sdk` remains pre-1.0 (0.154.0, https://registry.npmjs.org/@openai/codex-sdk, 2026-09-13); no stability statement found |
| R1 staleness / 6-week re-verify | fired — discharged by this document | this record IS that re-verification (R1/R2 were current as of 2026-09-12) |
