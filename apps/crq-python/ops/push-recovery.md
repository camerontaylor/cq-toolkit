# Recover a scan-blocked push lane

Run from the deployed runner's `apps/crq-python` directory. Use the runner's
supported command, not a JSON editor, and coordinate deployment separately if
that runner does not yet have `push-recover`. No service switch is part of this
command.

1. Inspect the blocked item's `last_error`, capture and immutable receipt, plus
   the redacted `state/runs/<run-id>/secret-scan.json`. Do not paste matched
   material into an issue or operator reason. A scan block consumes no start.
2. Correct the source in its owning repository and merge it normally. For a
   WebSocket example, `$(openssl rand -base64 16)` generates a valid handshake
   nonce without embedding a key-shaped constant. Do not weaken the scanner.
3. Recapture at the configured default branch's current tip:

   ```sh
   python3 crq.py push-recover <blocked-item-id> recapture \
     --operator <operator-identity> --verdict source-fixed \
     --reason 'Corrected example merged in owning-repo PR <number>'
   ```

   Verdicts are `source-fixed`, `false-positive` or `abandon`. They record an
   assessment, not permission to upload flagged content. The command acquires
   `tick.lock`, reloads with `load_queue`, verifies the blocked receipt's digest
   and binding, fetches the owning clone, then captures a replacement from the
   original base. It saves using `save_queue`. It does not invoke the vendor.
   Success prints JSON with the replacement id. Exit 3 means refused or lock
   contention. Inspect state before retrying an uncertain command result.
4. Confirm the old item is `skipped` with unchanged capture and receipt and a
   `push_recovery` disposition containing reason, verdict and operator. The new
   item is normally `pending`, pinned to the fetched tip, and `reviewed_tip` is
   unchanged. Empty or unsupported captures use their normal terminal outcome.
5. Let the natural tick run. Confirm a **new** scan on the replacement projection
   passes before a review starts. If flagged content remains, it blocks again
   without a quota reservation. Only a counted harvest advances the review
   boundary. Confirm the replacement completes and later pushes enroll from
   that boundary. No extra owner approval or review gate is introduced here.

## Release without immediate recapture

To remove a refused capture's lane pin without asking for a new capture now:

```sh
python3 crq.py push-recover <blocked-item-id> release \
  --operator <operator-identity> --verdict abandon \
  --reason 'Retire this capture and retain review debt for the next changed tip'
```

The old capture and receipt remain. No review credit is granted, and the same
unchanged tip is not re-enrolled. The next changed tip still owes the whole
range from `reviewed_tip`. Release requires a whole-range item whose base is
still that boundary. For a blocked split part after a counted parent, use
recapture so outstanding original paths cannot disappear. Unstarted active
parts of the same range are retired together. Any dispatched active part
refuses recovery until harvested. Rewritten history refuses recapture.

Recovery ids gain `-rN` only when the natural id already exists. Split parts
include that generation, so they cannot collide with retained old parts.

## Policy choice

Recovery is explicit, not triggered automatically by an unrelated later push.
Foreign repository `.gitleaksignore` files are not read by the stdin projection
scan. Existing gitleaks inline suppression behavior is unchanged and never
suppresses the separate denylist. Prefer fixing source examples. These choices
retain refused evidence and keep unscanned code away from the vendor.
