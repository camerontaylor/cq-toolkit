# Switching the forced command to the TypeScript `dispatch`

For the **ceres operator**. This is a runbook, not an automated step: nothing in
the repo changes `authorized_keys`, and an agent does not run it. It replaces the
Python forced command (`capability_dispatcher.py`) with
`node dist/queue-runner/crq.js dispatch` for one identity at a time. The TypeScript
dispatcher is byte-for-byte equal to the Python one on the covered cases
(differential tests: `queueDifferential`, `reviewDifferential`, `authorDifferential`),
with the three known divergences listed at the end.

Nothing here edits queue state, the policy file or the signer.

## Before you start

1. The deployed runner root (`<root>`) contains `dist/queue-runner/crq.js` built
   from a commit that includes `dispatch` in `dist/queue-runner/capabilities.json`:
   `grep -c dispatch <root>/dist/queue-runner/capabilities.json` must print `1`.
2. Node resolves as an absolute path: `command -v node` (use that path as `<node>`).
3. The forced command's exact `PATH` finds `git`, `gh` and `gitleaks`, checked
   outside a login shell. A found-but-broken `gitleaks` refuses every
   unpublished-commit submission; an absent one is silently skipped:

   ```sh
   env -i PATH=<cli-path> sh -c 'command -v git gh gitleaks && gitleaks version'
   ```

4. Pick **one** identity to switch first (the queue identity is the lowest risk).
   A queue identity carries `CRQ_QUEUE_PRINCIPAL` and `CRQ_QUEUE_POLICY` only; an
   author identity carries all three `CRQ_AUTHOR_*` settings only. Never mix them.
5. Back up the file and note the current line:

   ```sh
   cp -p ~/.ssh/authorized_keys ~/.ssh/authorized_keys.pre-dispatch-$(date +%Y%m%d)
   grep -n capability_dispatcher ~/.ssh/authorized_keys
   ```

## Switch

1. Write the new line for the same public key, same principal, same policy path.
   Keep the old line, commented out with `#`, directly above it:

   ```text
   restrict,command="cd <root> && /usr/bin/env PATH=<cli-path> CRQ_QUEUE_PRINCIPAL=<principal> CRQ_QUEUE_POLICY=<policy.json> <node> <root>/dist/queue-runner/crq.js dispatch" ssh-ed25519 <public-key> <comment>
   ```

   The `cd` matters: the runner takes its root from the working directory.
   Do not use `$SSH_ORIGINAL_COMMAND` in the line; the dispatcher reads it itself
   and accepts exactly `author-v1`, `queue-v1` or `review-v1`.

2. Check the line offline before installing it (no host access needed):

   ```sh
   node -e '
   import("<root>/dist/ops/crq/dispatchAuthorizedKeys.js").then((m) => {
     const line = require("node:fs").readFileSync(0, "utf8").trim();
     console.log(JSON.stringify(m.checkDispatchAuthorizedKeysLine(line, "<root>")));
   })' < new-line.txt
   ```

   It must print `"ok":true` and the identity you intend. Any `problems` entry
   means do not install.

3. Disable first, then install. Set `"enabled": false` in the policy file, install
   the line, and confirm a refusal path works from the calling host (a request
   to a disabled policy returns `unsupported`, not an SSH error):

   ```sh
   ssh <alias> queue-v1 < /dev/null; echo "exit=$?"
   ssh <alias> bogus < /dev/null; echo "exit=$?"
   ```

   The second must exit `2` and print `queue capability refused; no permission`.

4. Re-enable the policy (`"enabled": true`) for an approved window and run one
   `status` call from the client. Watch `state/events.jsonl` for the request.

## Rollback

Fastest, no key change: set `"enabled": false` in the policy file. Valid
authorized requests then return `unsupported`; malformed or unauthorized ones
are refused earlier, as before.

Full rollback to the Python dispatcher:

1. Comment out the TypeScript line with `#`.
2. Uncomment the saved Python line (or restore `authorized_keys.pre-dispatch-*`).
3. Run the `ssh <alias> bogus` check above; it prints the same refusal line from
   Python and exits `2`.

Queue requests and receipts are never deleted by either path.

## Known divergences from Python (reported to the contract owner)

- review-v1 `cancel`: TypeScript requires the recorded principal
  (`cancel request owner denied`); Python has no owner check.
- review-v1 frame without a trailing newline: Python accepts it, TypeScript
  refuses it (`invalid JSON request`).
- Decode and schema error message text differs; refusals coincide.
