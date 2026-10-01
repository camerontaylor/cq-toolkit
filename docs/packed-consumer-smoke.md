# Packed consumer smoke

Run this check against the exact `.tgz` that is proposed for release. It verifies the supplied SHA-256 before invoking npm, installs into a temporary consumer with npm's offline mode, imports the package root and every concrete declared export, and runs the installed `cq --help` entry point.

```sh
shasum -a 256 /absolute/path/to/cq-toolkit-0.2.0.tgz
node scripts/smoke-packed-package.mjs \
  --tarball /absolute/path/to/cq-toolkit-0.2.0.tgz \
  --sha256 <64-character-sha256> \
  --version 0.2.0
```

Run it from a checkout with Node.js and npm installed. Dependency packages must already be in npm's local cache; the audit deliberately fails rather than accessing the network when they are not. Package lifecycle scripts are disabled during installation. The package must declare a concrete root export, concrete subpath exports, and a `cq` binary. Wildcard exports fail closed because this audit cannot enumerate them safely.

The script always removes its temporary consumer directory. It does not build, pack, publish, or modify the tarball.
