# Production import provenance

Source: `0e35cd11153fc7ad681f002d580b9b22feb22092`.
Redacted, prefixed production tip: `14ecc7e60da2bee3e5da2651e97dec9dfe92477e`.
The import merge preserves the rewritten production history. Summary schema-2
expectations are ported separately (T); immediate green-tip promotion is C;
monorepo integration is I. Lease/fallback work is held for a later PR.

Hostnames, operator paths, private domains and operational identifiers were
replaced throughout historical blobs and messages. Research notes were excluded.
Trust identity pins are unchanged. The redaction rules and original identifiers
remain in the private research archive and are deliberately not published.

DISCLOSURE-INVENTORY PASS: 50 rewritten commits, 209 unique blobs, all messages and identity metadata inspected; 59 historical paths prefix-only; 0 research paths; 0 forbidden/private remnants; gitleaks history+messages clean; signer equivalence 9/9; trust pins unchanged.

The sweep covers both rewritten production and the held lease lineage. Only
production is imported here. Original commits are archived in a verified local
bundle; SHA-256 `6db837dc182c50f28c197411d28f3eab13afc8106a6786745538f395052d84de`.

## Signer-family equivalence

Applying the approved redaction rules to each accepted source blob produces
exactly the imported blob. No numeric trust pins changed; executable signer AST
is unchanged apart from documentation strings. Hashes are SHA-256.

| File | Accepted source | Redacted import |
| --- | --- | --- |
| `signer/DEPLOY.md` | `9b00b72c0d29019dd75d63865e7b5d18c569263afd297ae3cab967730ea93358` | `cb167e7077aaf564062b8cacee7aba16d24388d7b1ce1d18cde248246b6195fd` |
| `signer/README.md` | `ddc95aa645a8340fbc22fb6e86a2303f2c6f0926eaf62e5b6d94a2650c703ac7` | `4d8c46813f54be505594b9b70322936fad5a7f335948acad85fb02d4b8489eca` |
| `signer/crq-override` | `00b26c21855be3888741dd9cf0d59b8dcd4132873b73a686e6e5d587f3251f93` | `bca98539eab9bd45bc933772aa1b3e73a3100f782df7b4008aa3e04992c07fc9` |
| `signer/crq-signer.py` | `bb2162ac2f7f3a17926008b9c48fdafcfad46b15ed8cd8e10c8a89b0e8d5769e` | `93bb7d21529eab499c8a4115eab41aa48511865dbfb754465ce9e2a46918bbc3` |
| `signer/crq-signer.service` | `1cfa8726b437afe15a46fdf5a33ae1f51569eaf997b9e461557a44d81696b8bc` | `e3777e8a38e9d6952d282f70764e129fa72a917713dcf9308f02d24cc2365cb6` |
| `signer/fixtures/file-patterns-malformed-after-valid.yml` | `c08fe33dcc48078dd9e85d081492a778d80c746edd2cda4a81eaeac6e7094f92` | `c08fe33dcc48078dd9e85d081492a778d80c746edd2cda4a81eaeac6e7094f92` |
| `signer/fixtures/file-patterns-malformed-dash-indentation.yml` | `d720d3b4ec43fdc3f0b4347071ac775a47f13fa8ad9e650dc1378b7b3cde88bb` | `d720d3b4ec43fdc3f0b4347071ac775a47f13fa8ad9e650dc1378b7b3cde88bb` |
| `signer/record_ids.py` | `0dc1d5e98300ce6731b084baf1eb861f50b98148cb00e84fa9872e0db63962f4` | `0dc1d5e98300ce6731b084baf1eb861f50b98148cb00e84fa9872e0db63962f4` |
| `signer/spool-shell` | `c9a6c9dc8afe19810c31d834af3d1a5e928e2c038e4619d9d2464c4ad19930a4` | `c9a6c9dc8afe19810c31d834af3d1a5e928e2c038e4619d9d2464c4ad19930a4` |

## Runtime and custody

CI uses Python 3.14, matching the production minor reported by the owner
(3.14.7, read 2026-10-16). Python remains the sole issuer. This import does not
install, enable, render or deploy anything. Policy is still read from the review
clone at `origin/main`. Location and internal layout, including signer and
systemd unit names, are frozen until the retirement PR; Phase 1/2 moves must
exclude this directory. Repair remains disabled.

## Import validation (local, 2026-10-16)

- `check:static`: pass, zero errors; `format:check`: pass; `knip`: exit 0.
- `denylist-scan`: tree scan clean (9 rule classes active).
- Full import diff scanned with the same generated gitleaks configuration:
  no leaks, approximately 582 KB scanned.
- Before the runner extension existed, the permitted `python3 -m unittest`
  runs passed: summary (3), then promotion policy/retry/summary (14).
- Shared-runner mixed check (promotion/summary plus runner and promote-gate
  tests): `test:narrow result="pass" exit=0 files=6 projects="python,pure,process" tests="136/136" failed=0 skipped=0`.
- Same-SHA signer pins and workflow rendering:
  `test:narrow result="pass" exit=0 files=3 projects="python,pure,process" tests="36/36" failed=0 skipped=0`.
- Accepted author admission/quota baseline plus runner regressions:
  `test:narrow result="pass" exit=0 files=3 projects="python,pure" tests="101/101" failed=0 skipped=0`.

CodeRabbit CLI 0.7.7 cycle, full diff against
`7069782f5e935a7938e6b4ad5e2897a198a1f170`, including staged integration:
**BLOCKED before analysis**. The initial attempt and one same-scope retry both
returned `errorType=rate_limit`, exit 1: all five included reviews used,
no on-demand review available. No findings were produced, so there are no
finding dispositions; this is not a successful or clean review. No scope was
narrowed and billing configuration was not changed. The pre-PR review gate
remains open. Publication, CI at the final SHA and independent final-head review
remain pending. The owner has not applied the D11 record.
