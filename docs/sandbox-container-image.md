# Container sandbox default image

The `container` sandbox backend (`src/sandbox/backend.ts`) runs model-directed
children inside an OCI container (`docker`/`podman`). Since the Codex P2
review on #244 and the owner ruling that followed it, the adapter ships a
**default image pinned by digest** instead of naming a `cq-sandbox` image
that no installation provides; the fail-closed fallback is unchanged (a
missing image or daemon still yields an uncertified record, never a false
pass).

## The default

`DEFAULT_SANDBOX_IMAGE` (in `src/sandbox/backend.ts`):

```
node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
```

- **Official and maintained**: the Docker Official `node` image (the
  `nodejs/docker-node` collaboration), rebuilt with every Node security
  release.
- **Digest-pinned, multi-arch**: the digest is the OCI _index_ digest, so one
  immutable reference resolves to the same bytes on `linux/amd64` and
  `linux/arm64` (the index also carries `ppc64le` and build attestations). A
  mutable tag can never silently re-target the certified boundary, and no
  per-architecture digest table is needed.
- **Node 24** matches what this repo targets (CI `setup-node` versions and
  `@types/node` are on 24; there is no `engines`/`.nvmrc` override).
- **Sufficient for certification and Node workloads**: every certification
  canary (`src/sandbox/probe.ts`) executes `/usr/bin/touch`, `/bin/cat`,
  `/bin/bash --norc -c`, `/usr/bin/true`, and `/usr/bin/printenv` — all
  present in the Debian slim base — and the image carries `node` plus
  `corepack`. The image does **not** pre-cache any pnpm version, and
  corepack downloads a project-pinned pnpm on first use, which fails under
  the `model-only` launch (`--network none`). A workload that needs pnpm
  inside the container must use an override image that pre-caches it
  ([corepack offline workflow](https://github.com/nodejs/corepack/blob/main/README.md#offline-workflow)),
  or run under `network: 'allow'`.
  `git` is deliberately absent: git operations run on the host (coordinator
  side), outside the model-directed child.

## Why not the alternatives

- `mcr.microsoft.com/devcontainers/javascript-node:24-bookworm` — also
  official (Microsoft) and multi-arch, but an order of magnitude larger
  (zsh/oh-my-zsh and desktop-adjacent tooling included) and still does not
  put pnpm on `PATH` by default. Nothing in the canaries or the run children
  needs it.
- An in-repo `cq-sandbox` Dockerfile (slim base + git + corepack-enabled
  pnpm) — the right shape if sandboxed children ever need git or a
  pre-enabled pnpm shim, but as a _default_ it would require a build/publish
  pipeline and a registry the project does not operate (workflow files are
  instantiated from `policy/templates/`, so this is a deliberate,
  separately-gated decision). It remains the documented escape hatch via the
  override below.

## Overriding the image

```ts
import { containerAdapter } from './src/sandbox/backend.js';

// Default:
containerAdapter();
// Override with a digest-pinned reference (recommended):
containerAdapter({
  image: 'ghcr.io/example/cq-sandbox:v3@sha256:<64 hex>',
});
// Bring-your-own reference that only exists as a tag (explicit opt-in):
containerAdapter({ image: 'cq-sandbox:local', allowUnpinnedImage: true });
```

Overrides are **digest-pinned by default** (`validatedContainerImage`): a
mutable tag would let the image content change between the certification
probe and a later launch while the receipt still names the old reference.
`allowUnpinnedImage: true` is the named opt-in for references a daemon can
only resolve as a tag — typically a locally built image no registry has a
digest for. Flag-shaped references (leading `-`, whitespace, control
characters, more than one `@`) are refused outright regardless, because the
image rides as a bare argv position after the fixed boundary flags.

## Bumping the digest

A bump is a one-line change to `DEFAULT_SANDBOX_IMAGE`. Resolve the fresh
**index** digest (never a single-platform manifest digest, never a tag
alone):

```sh
# Either, with docker/buildx available:
docker buildx imagetools inspect node:24-bookworm-slim
# → Digest: sha256:...

# Or, with only curl: get an anonymous token, then read Docker-Content-Digest
# for the multi-arch Accept header:
TOKEN=$(curl -s 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull' \
  | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
curl -sI \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' \
  'https://registry-1.docker.io/v2/library/node/manifests/24-bookworm-slim' \
  | grep -i docker-content-digest
```

Sanity-check the bump: the digest must resolve to an index listing
`linux/amd64` and `linux/arm64` (add the `Accept:
application/vnd.oci.image.index.v1+json` header and fetch the manifest body
to enumerate `platforms`), and the tag's Node major must stay on the line
this repo targets. Because the pin is a digest, an upstream rebuild that
keeps the tag never reaches an installed toolkit silently — drift requires
this one-line PR, which is the supply-chain point.
