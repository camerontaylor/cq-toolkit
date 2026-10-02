# Bundled profile seed: all keys resolve to their conservative built-ins.
# Blank values are omitted intentionally; blank means this layer sets nothing.
#
# The `.profile` extension is deliberate. `policy/denylist/patterns.yml` rule
# `class:key-material-env` treats any content in a `*.env*` path as
# publish-forbidden key material, so no bundled profile may use a `.env`
# suffix. These seeds carry configuration values only, never credentials.
