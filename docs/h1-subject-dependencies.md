# H1: subject dependencies with a trusted compiler

Design at base `1eea0b5b323de8b23a9388a72da4e97f8e631450` (#517).
Current scope is a fixture-only prototype; H1 production implementation is not complete.
The original production recompute source and dependency-resolution path are unchanged.

Publish-safe provenance: host names are generic role labels and personal home
paths use `<USER_HOME>`. Versions, hashes, result lines and proof limitations
are preserved. Identity excerpts below are sanitized representations; original
actual log bytes remain in the referenced `/tmp` logs outside the repository.
The design below describes the intended boundary, not implemented production behavior.

The subject is extracted attribute-free as data. The compiler and measurement code
come from the trusted checkout. Dependency preparation has its own directory,
project-local virtual store and empty HOME, and receives only a generated manifest,
a validated lockfile and trusted configuration. Subject scripts, pnpm hooks,
package-manager selection, workspace settings, npmrc and executable config never
enter that directory. The child environment is an allowlist, excluding credentials,
proxies, npm configuration, Node loaders and resolver hooks. The compiler is invoked
by absolute path through the trusted Node executable, never through subject bins.
Only the subject dependency graph is visible to ordinary module resolution; there
is no fallback symlink to trusted dependencies.

Giles's coordinator disposition (2026-10-28) keeps existing authority unchanged:
compute safely validates the subject graph without a caller authorization flag or
a new mandatory gate for ordinary dependency changes. Judge retains D11/advisory
authority. Manifest declarations must match the exact root lockfile importer.
This data binding does not purport to authorize a definition change. Signer,
promotion and privileged-path policy are outside H1.

The fixture parser is the direct pinned devDependency `yaml@2.9.1`, reusing its existing
resolution and integrity. Input bytes, document count, AST nodes, nesting and
package count are bounded. Duplicate keys, aliases, anchors, custom tags,
unsupported importers, sources and lock formats are nonpassing. The proven
subset will be expanded only with fixtures. The pnpm 12 manager document is
validated separately and discarded before installation; it must not install
config dependencies or select a subject package manager.

The first proof uses generated local tarballs served by a trusted loopback static
registry to seed an isolated store, then stops that server before a frozen offline
consumer install. Scripts and pnpmfiles are disabled throughout. Missing cache is
an explicit failure with no online fallback. `--trust-lockfile` is permitted here
for the fixture only: it bypasses release-age, trust-downgrade and tarball-URL
resolution verifiers, not merely metadata loading. It is not a production
justification or substitute for validation. Frozen importer and archive integrity
checks remain distinct. No raw dependency logs or compiler diagnostics cross the
compute/sign boundary.

Production fetching remains contingent on the offline proof. pnpm will never be
the online fetcher: validating an initial URL does not constrain its redirects.
The proposed small trusted HTTPS downloader accepts integrity-pinned tarballs
only at the approved registry origin, rejects every redirect without following
it, bounds bytes and time, and uses no ambient proxy/auth/resolver configuration.
Fetched archives must seed the offline store successfully before this mechanism
can be used. No restored deciding-job cache is introduced. Cache misses, rejected
origins, missing integrity, incompatible lockfiles, timeout and genuine compiler
errors are never represented as a clean or skipped measurement.

The first boundary fixture uses a temporary real Git subject and real TypeScript:
missing dependency produces TS2307, the isolated subject dependency resolves it,
and fake subject compiler, lifecycle scripts and pnpm hooks remain inert. It also
checks the sanitized environment and manifest, missing offline cache and rejected
origins. Follow-on fixtures cover removal, version drift, real errors, malformed
locks, integrity, redirect rejection and production entrypoint wiring. Workflow
wiring follows the proof and is rendered from the canonical template.

## Earlier boundary proof: blocked on store addressing

The first real fixture reaches TS2307 before dependency preparation. Seeding an
isolated pnpm 12.8.1 store with `pnpm store add <local-tarball> --offline` succeeds,
but the subsequent frozen offline install of the registry-addressed lockfile
fails with `ERR_PNPM_NO_OFFLINE_TARBALL`. Local-file seeding therefore does not
prove the registry-addressed cache required by this design. Production wiring is
stopped; no network fallback, cache-layout fabrication or trust relaxation has
been introduced. Assertions after the install (including the clean compiler run)
have not been reached and are not passing evidence.

Evidence: `/tmp/h1-boundary-diagnosis.log` on worker-host. The named selection was
`test/ops/ratchet/recomputeTypecheck.test.ts test/ops/ratchet/adapters.test.ts`;
the narrow runner also selected `test/driver/process-inventory.test.ts`.
Its final result was:

```text
test:narrow result="fail" exit=1 files=3 projects="pure,process" tests="54/55" failed=1 skipped=0 wait="0.0s" duration="4.1s" nice=5 load="0.5" uptime="2012368s" source="explicit" ran="test/driver/process-inventory.test.ts,test/ops/ratchet/adapters.test.ts,test/ops/ratchet/recomputeTypecheck.test.ts"
```

Earlier runs exposed a TypeScript AST guard typing error and an obsolete fixture
`moduleResolution=node10` setting, both corrected. The actual boundary failure
above remains unresolved. Next work must establish a supported registry-addressed
offline cache population mechanism before proceeding to constrained fetching or
workflow wiring. The helper is a proof under development; production recompute
still uses its original dependency-resolution path.

## Fixture-only registry-addressing revision

Coordinator release permits only this fixture correction and its evidence. The
absolute trusted executable is
`<USER_HOME>/.local/share/mise/installs/node/22.20.0/lib/node_modules/pnpm/node_modules/@pnpm/exe.linux-x64/pnpm`;
its observed `--version` is `12.8.1` on worker-host. The Node 24 installation's pnpm
version is not substituted.

The source-backed candidate uses `store add boundary-dep@1.0.0 typescript@1.0.0`,
not local-path specifiers. pnpm's [store-add implementation](https://github.com/pnpm/pnpm/blob/v12.8.1/pnpm/crates/cli/src/cli_args/store/add.rs#L202)
passes the resolved package identity and integrity into archive ingestion. A
local-path resolution does not establish the registry package identity. The
[install resolution-verifier implementation](https://github.com/pnpm/pnpm/blob/v12.8.1/pnpm/crates/package-manager/src/install/run.rs#L436)
returns no resolution verifiers when `trust_lockfile` is true; the surrounding
source identifies release-age, trust-downgrade and tarball-URL checks. These
sources motivate the candidate sequence; execution evidence is recorded below
separately.

A separate trusted Node child serves only four exact GET routes on `127.0.0.1`
at a random port: the two packuments and their two tarballs. Bodies are generated
from the same local archive bytes and SHA512 integrities used by the unchanged
registry-addressed, integrity-only subject lockfile. The server has no outbound
client, redirects, authentication or subject-controlled routes; it rejects other
routes, methods, Host values and authorization headers. Its request report must
contain precisely the expected route set. The seed cwd contains a generated `{}`
manifest and trusted manager-selection configuration; its environment contains
only the explicit HOME/XDG/PATH/CI allowlist. No subject npmrc, config dependencies,
scripts, hooks, manager selection, credentials or proxy environment is passed.

After seeding, the fixture stops and awaits the server. The consumer uses a new
HOME/config/cache directory and generated dependency-only project, sharing only
the explicit store with the seed. Its offline frozen invocation receives the
stopped fixture registry via an explicit trusted CLI argument. This is internal
fixture configuration, not a subject URL allowance or production HTTP exception.
This prototype consumer lives in the test: it exercises the proposed operations
without changing the production helper input schema or registry handling. The
existing draft helper is still separately checked for missing-store failure.

Canary assertions follow seed, install and trusted compiler execution. The fake
subject TypeScript package has an executable `tsc` bin mapping so compiler
selection would be observable. The real compiler must report TS2307 before the
install, compile cleanly afterward, then retain TS2322 for a real type error and
TS2307 for a trusted-only package absent from the subject graph. Additional
assertions require empty-store failure, frozen importer mismatch failure and
rejected-origin validation. No cache layout is synthesized and no online fallback
is allowed. This does not yet prove production fetching, redirects, general lock
shapes, dependency removal/version drift or workflow integration. Production
wiring and authority changes remain held for the focused trust review.

The single authorized revised selection failed before the loopback server was
started or the store seeded: `/usr/bin/tar -czf` invokes `gzip` through PATH, and
the scrubbed environment contains only the trusted Node executable's directory.
The observed error is `/bin/sh: line 1: gzip: command not found`. Calling tar by
absolute path did not account for its child executable. The fixture is unchanged
after this failure; there is no retry or broadened workaround. Consequently none
of the revised seeding, offline-consumer or compiler assertions has passing
execution evidence. The registry-addressing sequence remains an unproven
candidate and production wiring remains stopped.

Evidence: `/tmp/h1-loopback-boundary-narrow.log` on worker-host. The named selection was
`test/ops/ratchet/recomputeTypecheck.test.ts test/ops/ratchet/adapters.test.ts`;
the runner also selected `test/driver/process-inventory.test.ts`. Its actual final
line was:

```text
test:narrow result="fail" exit=1 files=3 projects="pure,process" tests="54/55" failed=1 skipped=0 wait="0.0s" duration="3.4s" nice=5 load="0.4" uptime="2013052s" source="explicit" ran="test/driver/process-inventory.test.ts,test/ops/ratchet/adapters.test.ts,test/ops/ratchet/recomputeTypecheck.test.ts"
```

The pre-run `pnpm run format:check` completed with exit 0 and
`All matched files use the correct format.` Final documentation formatting is
checked separately after recording this result. No PR or CodeRabbit cycle was
started, and no production source, dependency schema or workflow was changed by
this fixture-only revision. The five previously dirty files remain dirty.

## H4 bounded packaging repair

Giles authorized one fixture-only repair after the distinct 54/55 packaging
failure above. Preflight on worker-host found executable `/usr/bin/tar` (GNU tar 1.35)
and `/usr/bin/gzip` (gzip 1.14). The fixture now resolves the trusted Git, tar,
gzip, Node and pinned pnpm paths absolutely and checks executable access before
use; it also resolves the trusted compiler path and checks read access. Tar gets
`--use-compress-program=<absolute verified gzip>` rather than resolving its child
through PATH. The existing environment allowlist is unchanged. No production
helper, schema, workflow or authority is changed. The existing five dirty files
are preserved; this release edits only the owned test and this evidence note.

The one authorized named selection failed at module preflight:
`realpathSync('/usr/bin/git')` raised ENOENT in the test process. The shell's
discovered Git path was `/run/current-system/sw/bin/git`; the fixture incorrectly
selected `/usr/bin/git` instead. No recompute tests or boundary assertions ran.
The loopback server, seed install, offline consumer, trusted compiler and canary
checks were all unreached. The 51 tests in the two other files passed, but the
selection failed because this test suite could not load. This is a new preflight
failure, distinct from the previous 54/55 tar/gzip packaging failure. No further
fixture edit, workaround or retry follows this result.

Evidence: `/tmp/h1-h4-boundary-narrow.log` on worker-host. Actual final line:

```text
test:narrow result="fail" exit=1 files=3 projects="pure,process" tests="51/51" failed=0 skipped=0 wait="0.0s" duration="1.3s" nice=5 load="0.3" uptime="2013189s" source="explicit" ran="test/driver/process-inventory.test.ts,test/ops/ratchet/adapters.test.ts,test/ops/ratchet/recomputeTypecheck.test.ts"
```

The summary's `failed=0` describes individual tests; the failed suite still gives
`result="fail" exit=1` and is not passing evidence. Only formatting and diff checks
follow this evidence update. No PR, CodeRabbit cycle or production wiring was
started. The five pre-existing dirty files remain preserved.

## H5 discovery inventory and one corrected preflight

Read-only inventory completed on worker-host and coordinator-host before this revision's edits.
The inspected process calls comprise fixture Git setup, tar (and its gzip/shell
child), Node server fork, Node environment probe, native pnpm version/store-add/
install, trusted compiler execution, draft helper pnpm execution, and the existing
Git adapter's execFile/spawn and check-runner's execFile. The adjacent adapter and
process-inventory tests add no fixture executables. The unchanged narrow wrapper
uses nice, ps, Git and Node, and may invoke pnpm to rebuild stale dist. Its full
suite/coverage helper routes are not invoked. These are prerequisite observations,
not passing boundary evidence.

| Helper                | worker-host discovered path → canonical path; version                                                                      | coordinator-host discovered path → canonical path; version                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Login shell           | `/run/current-system/sw/bin/bash` → `/nix/store/nn27l879np49xvx6l1a8nqnqlp9apd8n-bash-interactive-5.2p37/bin/bash`; 5.2.37 | `/usr/bin/zsh` → same; 5.9                                                          |
| bash                  | Same as login shell; 5.2.37                                                                                                | `/usr/bin/bash` → same; 5.3.9                                                       |
| sh                    | `/run/current-system/sw/bin/sh` → same canonical bash above; 5.2.37                                                        | `/usr/bin/sh` → `/usr/bin/dash`; package 0.5.12-12ubuntu3 (`--version` unsupported) |
| git                   | `/run/current-system/sw/bin/git` → `/nix/store/jg9g0gs0x0f69m8mn31syic45bf9lwh9-git-2.50.1/bin/git`; 2.50.1                | `/usr/bin/git` → same; 2.53.0                                                       |
| tar                   | `/run/current-system/sw/bin/tar` → `/nix/store/76df6j9sq1ar58id3y3v4rkijany1wxp-gnutar-1.35/bin/tar`; 1.35                 | `/usr/bin/tar` → same; 1.35                                                         |
| gzip                  | `/run/current-system/sw/bin/gzip` → `/nix/store/44c243x0jpv587hmxrzl31pripa0f0j8-gzip-1.14/bin/gzip`; 1.14                 | `/usr/bin/gzip` → same; 1.14                                                        |
| env                   | `/run/current-system/sw/bin/env` → `/nix/store/3sdbmzgasq0yji85zhm1rjdhi17ya64c-coreutils-full-9.7/bin/coreutils`; env 9.7 | `/usr/bin/env` → `/usr/lib/cargo/bin/coreutils/env`; 0.10.0                         |
| nice                  | `/run/current-system/sw/bin/nice` → same canonical coreutils above; nice 9.7                                               | `/usr/bin/nice` → `/usr/lib/cargo/bin/coreutils/nice`; 0.10.0                       |
| ps                    | `/run/current-system/sw/bin/ps` → `/nix/store/1xb348bicw1b0fmahnvnvax0jhiapz42-procps-4.0.4/bin/ps`; 4.0.4                 | `/usr/bin/ps` → same; 4.0.4                                                         |
| Node shim             | `~/.local/share/mise/shims/node` → `~/.local/bin/mise`; invoked as node reports 24.21.0                                    | Same relative paths; invoked as node reports 24.22.0                                |
| Native Node           | `~/.local/share/mise/installs/node/24.21.0/bin/node` → same; 24.21.0                                                       | `~/.local/share/mise/installs/node/24.22.0/bin/node` → same; 24.22.0                |
| Ambient pnpm shim     | `~/.local/share/mise/shims/pnpm` → `~/.local/bin/mise`; invoked as pnpm reports 12.8.1 at inventory time                   | Same relative paths; invoked as pnpm reports 12.15.0                                |
| Versioned native pnpm | Node 22.20.0 candidate recorded above → same; **12.8.1 selected**                                                          | Inspected Node 24.22.0 native candidate → same; 12.14.0, not acceptable             |

`~` in this table is `<USER_HOME>`. Mise shims require their invocation identity;
executing their canonical `mise` path with `--version` reports mise, not Node or
pnpm. The fixture therefore discovers its current absolute native Node path and
the explicitly versioned Node 22.20.0 native pnpm candidate, rather than executing
the canonical shim target. No fallback to a different pnpm version is permitted.
The current ambient version observation does not replace the exact 12.8.1 check.
No 12.8.1 candidate was present among the inspected coordinator-host mise-native paths;
no tests, installs or builds were run there. The compiler is a trusted checkout
data entrypoint, not a PATH executable: on worker-host its canonical path is
`<USER_HOME>/.local/share/pnpm/store/v11/links/@/typescript/7.0.2/f67fd18f58b6de9dc7529c73bb837b1bc425b92d59dd9ce937bb25f7e1470429/node_modules/typescript/bin/tsc`,
package version 7.0.2. No compiler was present in coordinator-host's inventory cwd.

H5 supersedes the earlier FHS assumption. The fixture bootstraps only from the
trusted login shell declared by SHELL, resolves/checks that shell, then runs
`command -v` once per helper during preflight, canonicalizes the resulting paths
with Node realpath and asserts executable access. It checks that shell discovery
agrees with the bootstrap. Children then receive the retained absolute paths;
there are no literal `/usr/bin` helper paths or ambient PATH resolution in fixture
execution. Tar receives its discovered absolute gzip path. The deliberately fake
compiler shebang and lifecycle canaries also name the trusted Node absolutely.
For the existing adapter's bare Git calls, a test-only forwarding layer selects
the same discovered real executable and a fixed credentialless Git environment
with empty PATH. All results still come from real Git processes; production
adapter/helper code is unchanged. Dependency children retain their existing
allowlisted environment with no PATH widening. Preflight does not fetch packages
or run subject code.

Exactly one existing named narrow selection ran on worker-host and passed. The log
records the discovered and canonical paths used by the test process, matching
the inventory above. Both earlier failures remain distinct; this result does
not convert either into passing evidence. No retry was run.

## H5 actual boundary evidence and trust-review handoff

Evidence: `/tmp/h1-h5-boundary-narrow.log` on worker-host. The named selection was
`test/ops/ratchet/recomputeTypecheck.test.ts test/ops/ratchet/adapters.test.ts`;
the runner also selected `test/driver/process-inventory.test.ts`. Its actual
final line was:

```text
test:narrow result="pass" exit=0 files=3 projects="pure,process" tests="55/55" failed=0 skipped=0 wait="0.0s" duration="3.2s" nice=5 load="0.1" uptime="2013597s" source="explicit" ran="test/driver/process-inventory.test.ts,test/ops/ratchet/adapters.test.ts,test/ops/ratchet/recomputeTypecheck.test.ts"
```

The boundary test passed and emitted every checkpoint after its assertions:

- Registry-name store seeding completed with no canary effect.
- The registry stopped and was awaited before consumption; its request report
  contained only the four exact allowlisted, unauthenticated routes.
- The trusted compiler reported real TS2307 before installation, with no canary
  effect; the environment probe excluded secret, proxy, registry and loader
  canaries.
- A fresh consumer with only the seeded store shared completed its frozen
  offline install after registry shutdown, with no script or hook canary effect.
  Its generated manifest and unchanged integrity-only lock matched the plan.
- The absolute trusted compiler compiled the subject import cleanly. The subject
  fake compiler was present with its executable bin mapping but did not run;
  compiler and lifecycle/hook/loader canaries remained absent.
- Changing the source retained a genuine TS2322, and importing trusted-only yaml
  produced TS2307 rather than falling back to the trusted dependency graph.
- The draft helper (then present in production source, now moved entirely into the
  fixture by the P1 correction below) failed closed with an empty store and did not link dependencies;
  the explicit fixture consumer also reported `ERR_PNPM_NO_OFFLINE_TARBALL`.
  A mismatched root declaration reported `ERR_PNPM_OUTDATED_LOCKFILE`.
- The rejected-origin plan failed validation and the final canary remained absent.

This is passing evidence for the bounded offline fixture only. The successful
consumer is deliberately implemented in the test with trusted internal registry
configuration, not wired into production. General lock shapes, production fetch
origin/integrity/redirect enforcement, dependency removal/version drift, production
entrypoints and workflow integration remain unproven. Fixture-only
`--trust-lockfile` remains the explicitly documented verifier bypass above; this
result grants no production exception. Existing authority and judge behavior
remain unchanged.

Implementation stops here for focused trust review. No production/helper/schema/
workflow/authority changes, dependency edits, push, PR or CodeRabbit cycle were
made in H5; only this note and the owned fixture changed, preserving the five
previously dirty files. Only format/diff checks follow the evidence note.

## Trust review 1ef60aa5 P1 correction

The review correctly identified that the unused exported preparation prototype
contained a fixture-only `--trust-lockfile` bypass in production source. The
prototype, bounded parser, environment helper and bypass now live entirely in
`test/ops/ratchet/recomputeTypecheck.test.ts` as private fixture code. Production
`src/ops/ratchet/recomputeTypecheck.ts` is restored byte-for-byte to the pinned
base, SHA256 `752a950b474af5c37884968cd5945f54dac1833bc9252b85e14208f911a1fb7f`.
The original production path still resolves trusted checkout dependencies; this
correction does not implement #517 or authorize a production supply mechanism.
No helper/input schema, workflow, downloader or authority changes are included.

The prototype helper is exercised only for empty-cache nonpass and absence of a
dependency symlink. Its success path is NOT tested. The separate test consumer
provides the successful seed/server-shutdown/offline-install/compiler proof;
these are distinct claims. All existing fixture assertions are preserved, and
the checkpoint now explicitly labels the helper's scope as fixture-only. The
verifier bypass remains fixture-only with the limitations documented above;
removing a flag would not establish verifier-safe production behavior.

`yaml@2.9.1` is required by the fixture's strict parser and lock generation, so
it is a pinned direct devDependency. Only its exact root devDependency importer
entry is added; existing package resolutions, integrity and snapshots are
unchanged. No unrelated upgrades or scripts/config changes are included.
Validation evidence for this correction follows below after actual execution.

### P1 correction actual verification

Exactly one named selection ran on worker-host after correction; no boundary retry.
Evidence: `/tmp/h1-p1-boundary-narrow.log`. The actual final wrapper line is:

```text
test:narrow result="pass" exit=0 files=3 projects="pure,process" tests="55/55" failed=0 skipped=0 wait="0.0s" duration="3.3s" nice=5 load="0.1" uptime="2014284s" source="explicit" ran="test/driver/process-inventory.test.ts,test/ops/ratchet/adapters.test.ts,test/ops/ratchet/recomputeTypecheck.test.ts"
```

All boundary checkpoints were reached: registry-name seed and absent canary;
server stopped and awaited with exact allowed routes; real trusted compiler
TS2307 before installation; fresh consumer frozen offline install; trusted
compiler green with inert selectable fake compiler; real TS2322 and trusted-only
module TS2307; fixture-only helper empty-cache failure without symlink; separate
consumer empty-cache and frozen importer mismatch; rejected origin and final
absent canary. Helper success remains untested.

`pnpm run check:static` passed (zero compiler errors, typed lint exit 0), log
`/tmp/h1-p1-static-final.log`. Its initial run found unsafe any handling in the
fixture forwarding/event/environment plumbing; explicit unknown annotations
resolved those findings before the boundary run. `pnpm run knip` passed, exit 0
(`/tmp/h1-p1-knip.log`). The package-manager preflight for the owned-file fix
reported an up-to-date lockfile and passed its 316-entry supply-chain scan; no
package resolutions were changed. Final format and diff status are recorded
in the reviewer handoff. No commit, push, PR or CodeRabbit cycle was performed.
Implementation stops for the same independent reviewer.

## Portability trust-review correction (fixture only)

The previous finalized diff `dfbf7c6a92bfbfec34c7d478efc9acdbcf438e52c8ee3c522c335f1ee5c86dac`
had a new P1: module-load preflight assumed a worker-host-specific mise installation
and SHELL. The production-source P1 remains fixed. Only the owned fixture and
this note change in this correction; #517 remains open and proof-only.

Checked-in CI evidence: `.github/workflows/ratchet.yml` lines 91–100 provisions
pnpm via pinned pnpm/action-setup (version from package.json packageManager),
then actions/setup-node Node24 and frozen install. Lines 125–126 run coverage
Vitest, which loads this process test. No workflow changes are required or made.
The trusted root manifest currently has `packageManager: pnpm@12.8.1` and no
engines field. Giles's disposition supersedes the host-versioned executable
requirement: runtime version is bound to repository packageManager, with Node24
from the checked-in CI contract while engines is absent. A future engines field
or unsupported packageManager shape fails closed for explicit contract review.

Preflight now verifies canonical process.execPath with X_OK, requires Node24,
and verifies the trusted runner's npm_execpath with realpath and X_OK. It accepts
a native Linux ELF pnpm executable or a Node-shebang entrypoint (launched through
absolute trusted Node with an explicit argument prefix); unknown launchers and
missing inputs fail. pnpm's reported version must equal the root manifest pin.
Node scans only absolute entries of the trusted preflight PATH once for git,
tar and gzip, canonicalizing and checking executable access before subject data
or canaries. All child helper commands retain absolute paths; no child resolves
a bare helper through ambient PATH. No shell is launched and SHELL is unused.
Fresh HOME/XDG, sanitized children, absolute gzip and compiler provenance remain.
There is no runtime download, fallback tool installation, opt-in or skip.

The earlier source citations prove only the pnpm12.8.1 implementation inspected
then. Reading the repository pin does not extend those source claims to another
version; actual runtime identity/version and new execution evidence are recorded
below. Native and Node-entrypoint invocation support is explicit, but only the
actual observed branch will have local execution evidence. Strategy was sent to
the coordinator before the single named run.

### Portability correction actual evidence

One named selection ran on worker-host, launched with SHELL removed using
`env -u SHELL pnpm test:narrow test/ops/ratchet/recomputeTypecheck.test.ts test/ops/ratchet/adapters.test.ts`.
No retry. Log: `/tmp/h1-portability-narrow.log`. Sanitized identities/version:

```text
H1 preflight helpers: {"git":"/nix/store/jg9g0gs0x0f69m8mn31syic45bf9lwh9-git-2.50.1/bin/git","tar":"/nix/store/76df6j9sq1ar58id3y3v4rkijany1wxp-gnutar-1.35/bin/tar","gzip":"/nix/store/44c243x0jpv587hmxrzl31pripa0f0j8-gzip-1.14/bin/gzip","node":"<USER_HOME>/.local/share/mise/installs/node/24.21.0/bin/node","nodeVersion":"24.21.0","pnpmEntrypoint":"<USER_HOME>/.cache/node/corepack/v1/pnpm/12.8.1/pnpm-native","pnpmExecutable":"<USER_HOME>/.cache/node/corepack/v1/pnpm/12.8.1/pnpm-native","pnpmPrefix":[],"requiredPnpmVersion":"12.8.1","packageManager":"pnpm@12.8.1"}
H1 verified pnpm version: 12.8.1 entrypoint: <USER_HOME>/.cache/node/corepack/v1/pnpm/12.8.1/pnpm-native
```

Actual final wrapper line:

```text
test:narrow result="pass" exit=0 files=3 projects="pure,process" tests="55/55" failed=0 skipped=0 wait="0.0s" duration="3.2s" nice=5 load="1.1" uptime="2014773s" source="explicit" ran="test/driver/process-inventory.test.ts,test/ops/ratchet/adapters.test.ts,test/ops/ratchet/recomputeTypecheck.test.ts"
```

All nine existing boundary checkpoints were reached, including seed canary,
stopped/awaited registry routes, compiler TS2307 before install, sanitized
environment, frozen offline install, compiler green and selectable inert fake
compiler, real TS2322/trusted-only TS2307, fixture-only helper empty-cache failure
and consumer missing-cache/importer mismatch, rejected origin/final canary.
The successful consumer remains separate from the prototype helper; helper
success is not tested. Native pnpm12.8.1 from the runner context was actually
used, with Node24.21.0. The JS-entrypoint branch and actual GitHub CI execution
have not been run here and are not claimed. Missing toolchain always fails;
there is no skip path or successful unavailable evidence.

`pnpm run check:static` passed with zero errors and typed lint exit0
(`/tmp/h1-portability-static.log`); `pnpm run knip` passed exit0
(`/tmp/h1-portability-knip.log`). Package manifest/lock and restored production
source hashes remain identical to the previous P1 correction. Final format/diff
checks and hashes are supplied in the handoff. No production wiring, commit,
push, PR or CodeRabbit cycle. Stop for the same independent reviewer.

## PR569 macOS launcher recognition repair

CI run40581884064 attempt1 job122463141887 step6 failed in module-load
preflight with unsupported provisioned pnpm launcher. That bounded failure
log does not identify the runner's actual launcher format. This repair does
not claim it does. The reviewed head remains 5d8f23a33acdf501a7e93e8f83e2d69e679a6b33.

The checked-in macos-venue.yml provisions the manifest-pinned pnpm action and
Node24 before frozen install and the shared static-gate action. The pinned
[action provisioner source](https://github.com/pnpm/action-setup/blob/ea17c68df8912ef543352723c149a84f56e3d413/src/install-pnpm/run.ts)
selects its native path for pnpm12. Official registry metadata for
[pnpm12.8.1](https://registry.npmjs.org/pnpm/12.8.1),
[Darwin arm64](https://registry.npmjs.org/@pnpm/exe.darwin-arm64/12.8.1) and
[Darwin x64](https://registry.npmjs.org/@pnpm/exe.darwin-x64/12.8.1) was read
without installing or executing those artifacts. Each platform tarball's
SHA512 was verified against its official metadata before inspecting package/pnpm.
Both official executables begin cffaedfe. Verified archive integrities:

- arm64: sha512-/rwavvMQJsl2RIxOHBnDF+4Gk+fhQFAY4M3PQZoKskJOEnaJcygG9p1xby6wcQcbS4d9dIubv09CQhufTgfmpw==
- x64: sha512-htYt2gN7zqJKLhC99Ft6EUiO7myjZAZXfmGCTJUL1v+o7vE9hZdE1+fAkk4Oj1ZHNRti6b2woOxEkRkAusi8OQ==

Apple's [Mach-O loader definition](https://github.com/apple-oss-distributions/cctools/blob/main/include/mach-o/loader.h)
specifies the 32-byte mach_header_64, MH_MAGIC_64 and MH_EXECUTE. The bounded
classifier adds only Darwin thin64LE recognition with a complete32-byte header,
filetype2 and cputype matching arm64 (0x0100000c) or x64 (0x01000007). Existing
ELF and direct Node-shebang behavior is retained. Actual read length is used so
zero-padding cannot turn a truncated header into a complete one. Other CPU/OS,
universal, swapped, truncated, nonexecutable or shell-wrapper forms fail closed.
Synthetic headers exercise recognition/rejection only, never executable output.
The OS loader and exact pnpm version check still run the real provisioned tool.

Canonical npm_execpath realpath/X_OK, trusted process.execPath, exact repository
packageManager version, scrubbed child environment, no ambient execution PATH
and no skip/mock-output behavior remain required. No production source,
workflow, schema or authority changes are made. The original production source
remains byte-for-byte unchanged; #517 is not fixed by this proof-only repair.
Linux execution and synthetic Darwin recognition are distinct from real macOS
CI execution, which remains to be established by successor CI. No CI rerun,
CodeRabbit retry or merge is requested.

S1 provenance containment: the existing child-environment probe now emits only
four named Boolean canary-presence checks, preserving absence assertions without
serializing an environment object or exposing values. No credentials, account
settings or unrelated transcripts are inspected.

### macOS recognition repair actual local evidence

The trusted checkout's offline frozen no-scripts/no-pnpmfile install succeeded
with pnpm12.8.1. Exactly one existing named ratchet selection ran on the
authorized validation host; no full suite, watch, coverage or provider calls.
Log: `/tmp/h1-macos-repair-narrow.log`. Actual final wrapper line:

```text
test:narrow result="pass" exit=0 files=3 projects="pure,process" tests="58/58" failed=0 skipped=0 wait="0.0s" duration="5.5s" nice=5 load="5.3" uptime="851562s" source="explicit" ran="test/driver/process-inventory.test.ts,test/ops/ratchet/adapters.test.ts,test/ops/ratchet/recomputeTypecheck.test.ts"
```

All nine existing boundary checkpoints were reached, alongside three new
recognition tests preserving ELF/Node behavior, accepting supported Darwin
headers, and rejecting unsupported/truncated/wrong-OS/CPU/nonexecutable forms.
No synthetic executable output was used. Real Node24.22.0 and exact pnpm12.8.1
ran the Linux fixture. Static verification passed with zero compiler/lint
errors (`/tmp/h1-macos-repair-static.log`), and Knip passed exit0
(`/tmp/h1-macos-repair-knip.log`). Header assertions do not establish the
original failed CI launcher's bytes or successful macOS execution. All earlier
helper-success and production-supply limitations remain unchanged. Final
format/diff/scans and successor hashes are supplied in the handoff.
