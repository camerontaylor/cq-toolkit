# Release evidence — v1.0.0

Raw logs captured by the T5.1 publication checklist (plan §6). They are the
attachment form of the two local runs the checklist requires, so the release
PR carries the artifacts rather than only describing them.

| file                  | what it is                                                                                                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pack-audit.log`      | reproduction of CI `.github/workflows/pack-audit.yml`: `npm ci`, `npm run build`, `npm pack` at `1.0.0`, untar outside the tree, `package.json` `files` allowlist assertion, denylist scan over the unpacked tree using the tarball's own `policy/denylist/patterns.yml`. Result: **PASS**. |
| `tarball-listing.txt` | the `tar -tzf` listing audited by `pack-audit.log` (273 paths).                                                                                                                                                                                                                             |
| `publish-dry-run.log` | `npm publish --dry-run` at `1.0.0` (the `prepack` hook builds `dist/` first) — packs the tarball, contacts the registry in dry-run mode, uploads nothing. Result: exit 0.                                                                                                                   |

The base is `origin/main` `51c81eb` (T4.4, ff-promoted); the branch is
caught up to `merge-queue` `0d76ed5` by merge commit `ac261fc` (brings PRs
#195 and #198). Each log records the commit it was captured at, the
dirty-diff identity when the tree carried uncommitted work, and the
tarball's sha256; only `dist/`, `policy/`, `LICENSE`, `README.md` and
`package.json` are packed, so the recorded sha256 is stable across later
doc-only commits. The CI equivalents are linked from `RELEASE.md`.
