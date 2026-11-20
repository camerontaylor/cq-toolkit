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

1. Two roots, the same layout the Node publisher and watchdog units already use:
   - `<deploy-root>` is the `cd` target and holds the runner's `config.json` and
     `state/` (on ceres `~/repos/crq-deploy/apps/crq-python`; it has no `dist/`).
   - `<artifact>` is the packaged artifact holding `dist/` (on ceres
     `~/.local/opt/crq-<sha>`; it has no `config.json` or `state/`).

   Write both as absolute paths (no `~`). Check:

   ```sh
   test -f <deploy-root>/config.json && test -d <deploy-root>/state && echo deploy-root-ok
   test -f <artifact>/dist/ops/crq/dispatchAuthorizedKeys.js \
     && grep -c "command === 'dispatch'" <artifact>/dist/queue-runner/crq.js
   ```

   The second must print `1`: the artifact is built from a commit that carries
   the `dispatch` route and the line check below. `dispatch` is not a unit
   command, so it is **not** in the artifact's `capabilities.json` (that file
   lists only systemd unit commands; the unit-switch preflight refuses any
   other name).

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
   restrict,command="cd <deploy-root> && /usr/bin/env PATH=<cli-path> CRQ_QUEUE_PRINCIPAL=<principal> CRQ_QUEUE_POLICY=<policy.json> <node> <artifact>/dist/queue-runner/crq.js dispatch" ssh-ed25519 <public-key> <comment>
   ```

   The `cd` matters: the runner reads `config.json` and `state/` from the
   working directory, so it is the deploy root, while the script comes from the
   artifact. Run from the artifact root, every enabled request is refused.
   Do not use `$SSH_ORIGINAL_COMMAND` in the line; the dispatcher reads it itself
   and accepts exactly `author-v1`, `queue-v1` or `review-v1`.

2. Check the line offline before installing it (no host access needed):

   ```sh
   <node> -e '
   import(process.argv[2] + "/dist/ops/crq/dispatchAuthorizedKeys.js").then((m) => {
     const line = require("node:fs").readFileSync(0, "utf8").trim();
     const roots = { deployRoot: process.argv[1], artifactRoot: process.argv[2] };
     console.log(JSON.stringify(m.checkDispatchAuthorizedKeysLine(line, roots)));
   })' <deploy-root> <artifact> < new-line.txt
   ```

   It must print `"ok":true` and the identity you intend. Any `problems` entry
   means do not install. The check refuses shell separators (`;`, `&`, `&&`,
   `|`) anywhere after the fixed `cd <deploy-root> && /usr/bin/env ` prefix.

3. Disable first, then install. Set `"enabled": false` in the policy file, install
   the line, and confirm from the calling host that a well-formed, authorized
   request reaches the activation gate. An empty or malformed frame is refused
   before that gate, so it cannot show `unsupported`. Use a read-only `status`
   frame for the policy's own repo, principal and target selector (`<owner/repo>`
   is the policy's `repo`; `targetSelector` must be one of its `targets`; the PR
   number and SHA need not exist, nothing is looked up while the policy is
   disabled):

   ```sh
   printf '%s\n' '{"v":1,"op":"status","requestId":"switch-probe-1","binding":{"kind":"merged-current","repo":"<owner/repo>","targetSelector":"promoted-main","pr":1,"mergeSha":"0000000000000000000000000000000000000000"}}' \
     | ssh <alias> queue-v1; echo "exit=$?"
   ssh <alias> bogus < /dev/null; echo "exit=$?"
   ```

   The first must exit `0` with
   `"result":{"unsupported":"Reviewed D1C queue-v1 activation required"}`
   (the Python dispatcher prints the same line). A refusal here means the line,
   principal, policy path, repo or `targetSelector` is wrong. The second must exit `2` and print
   `queue capability refused; no permission`.

4. Re-enable the policy (`"enabled": true`) for an approved window and run one
   read-only `health` call from the client. `status` cannot be the check: it is
   refused (exit `2`) for a request id that was never enqueued, and no queue
   capability request writes `state/events.jsonl`. `health` needs no enqueue and
   no forge lookup, but the policy must carry a `health_reads` grant for the
   principal and this exact binding (see `docs/queue-client.md`, health):

   ```sh
   printf '%s\n' '{"v":1,"op":"health","requestId":"switch-probe-health","binding":{"repo":"<owner/repo>","targetSelector":"promoted-main"}}' \
     | ssh <alias> queue-v1; echo "exit=$?"
   ```

   It must exit `0` with a `"result"` carrying `pending`, `blocked`, `deployedSha`
   and a `snapshot` digest (null ages and SHAs are normal on a quiet queue). A
   refusal (`queue capability refused; no permission`, exit `2`) means the
   `health_reads` grant is missing or does not match the binding, the repo or
   `targetSelector` is not in the policy, or `<deploy-root>/state/queue.json` is
   unreadable; the first two are policy fixes, not a reason to roll back. The call
   changes no queue state; `<deploy-root>/state/queue.json` is unchanged.

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
