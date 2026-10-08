# Bundled profile seed. Explicit project CQ_* variables override these values.
# The `.profile` extension is deliberate: see `conservative.profile` and the
# `class:key-material-env` rule in `policy/denylist/patterns.yml`.
CQ_MERGE_REQUIRE_HUMAN_APPROVAL=false
CQ_MERGE_ACCEPT_REVIEW_STATES=APPROVED,COMMENTED
CQ_MERGE_TRUSTED_BOTS=coderabbitai[bot]
CQ_MERGE_PROTECTED_PATHS=diff-check
CQ_SANDBOX=off
CQ_SANDBOX_NETWORK=allow
CQ_DRIVER_BINDINGS=*/anthropic:claude-agent
