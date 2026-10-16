# Host overlay and recorded runner deployment

P2 supplies deployment tooling; it does not authorize a deployment. Nothing here
changes signer custody. Do not render, patch or restart the old runner before the
owner-approved first monorepo deployment. `CUTOVER.md` and `CUTOVER-COMMANDS.md`
are archival records of the completed cross-host handover, not current commands.

## Private overlay, schema 1

Keep the JSON file outside the deployment checkout and outside every Git
repository, mode 0600. Keep its private record directory outside Git, mode 0700.
Host values are never committed. There is no policy override mechanism.
`prepare-host.py` defines the closed allowlist in `HOST_KEYS`, `CONFIG_KEYS` and
`PATH_KEYS`; unknown keys at any depth fail. `repair.enabled` must be exactly
JSON `false`. Spend authorization, provider/model roles, checks, triggers, quotas
and backoffs remain committed policy. No model/provider is selected by this tool.

Example only; replace every host value privately:

```json
{
  "schema_version": 1,
  "deploy_root": "/srv/crq-deploy",
  "record_dir": "/srv/private/crq-deploy-records",
  "fleet_reader": {
    "ssh_host": "queue.example.invalid",
    "source": "/srv/operator-state/crq/summary.json"
  },
  "config": {
    "clone": "/srv/crq-runtime",
    "worktree_root": "/srv/crq-worktrees",
    "timeout_bin": "/usr/bin/timeout",
    "paseo_hosts": ["worker.example.invalid:6767", "127.0.0.1:6767"],
    "promotion": {
      "record_url_template": "http://queue.example.invalid:6778/promotion/{item}",
      "alert_agent_host": "worker.example.invalid:6767",
      "signer": {
        "spool": {
          "ssh_alias": "operator@127.0.0.1",
          "ssh_key": "/srv/private/crq-spool-key"
        }
      }
    },
    "repair": {
      "enabled": false,
      "cq_bin": "/srv/crq-runtime/dist/cli.js",
      "paseo_host": "127.0.0.1:6767"
    }
  }
}
```

`promotion.signer.spool.dir` is an optional host path; all other config leaves
above are required. The runtime clone must be separate from the deployment clone.
The overlay also supplies the fleet-reader's source host and absolute source path;
`fleet-reader.py --overlay /private/host.json` reads only that summary via SSH.
Render launchd templates with `preview`; install from a retained detached toolkit
checkout on the reader host, so its adjacent `prepare-host.py` remains available.
The reader host has its own private overlay and checkout paths.

## Rendering and evidence

Use a dedicated full cq-toolkit clone, fetched anonymously from
`https://github.com/camerontaylor/cq-toolkit.git`, never the review runtime clone.
Never `git pull` the deployment clone. Fetch, verify the full SHA is reachable
from `origin/main` (= `cq/promoted`), and verify its owner-approved annotated
`crq-runner/YYYYMMDD-N` tag peels to that SHA. This tool does not create tags.
Targets must descend from import C (`f748fd43`); earlier rollback needs the
separate, recorded old-runner rollback below. Keep the checkout detached.

The helper reads `HEAD:apps/crq-python/config.json`, never the generated working
copy. The rendered bytes retain the existing indent-2 JSON plus newline format.
Every successful render writes a private schema-1 audit record with full source
SHA, exact overlay-byte SHA256, rendered-config SHA256, operation and timestamp.
Records describe render intent (not proof that units started) and are atomic
mode-0600 files; installed units also have recorded hashes.
Keep them with the private deployment record in toolkit-research `plans/`,
alongside tag/reachability evidence, pre/post file hashes and runner Git status.
Do not commit the overlay, generated config, unit output or host records publicly.

Offline preparation evidence (temporary, detached clone only):

```sh
python3 apps/crq-python/ops/prepare-host.py --overlay /private/host.json preview --output /private/preview
systemd-analyze --user verify /private/preview/systemd/crq-*
```

The focused test renders a temporary detached monorepo fixture and runs that
verification when systemd is available (Linux CI). macOS skips only the systemd
binary check. `preview` never writes checkout config, markers or installed units.
Templates contain `@CRQ_ROOT@`; never install them without rendering.

## First monorepo deploy: owner-operated root move

1. The chancellor records read-only hashes of the old live config and `.bak`;
   these provisional hashes do not authorize a render or a live edit.
2. Stop tick/watchdog timers and records service; repair units remain disabled.
   Wait for tick inactivity and drain exact owned reviews using author recovery:
   neither `alive` nor `ambiguous` runs may migrate. Hold the OLD tick lock through
   the state snapshot, transfer and old-root inert marker.
3. Use the P2 helper from a retained checkout, with a **legacy** private overlay
   containing the accepted old prepare overrides, to run `legacy-check
   --legacy-root /private/old-runner`. It reads accepted `0e35cd11:config.json`,
   computes its host rendering in memory/temp, permits only `merges_trigger` 5→1,
   and byte-compares old live config. Any other drift refuses. It never writes
   old config, locks or markers. Retain its audit and the `.bak` privately, then
   remove `.bak` from the old checkout as an explicit owner migration step.
4. Snapshot/copy drained `state/` to the new detached deployment root. Keep the
   old checkout at `0e35cd11`, inert, throughout the observation window. Preserve
   state bytes; do not copy host locks. A cross-host flock is not an ownership
   fence. The sanctioned first rollback uses the recorded old live config,
   never a re-render of old committed policy.
5. With the NEW overlay, run `prepare --tag crq-runner/YYYYMMDD-N
   --units-output "$HOME/.config/systemd/user"`. It refuses active units,
   renders relocated units, verifies them, records hashes, writes config and an
   inert marker, then reloads the user manager. It never starts/enables anything.
   The target's `dispatch_after_min` 20→0 is an intended C change, not old-root
   drift. The installed signer and its files/units/keys are untouched.
6. The owner removes the NEW inert marker and starts records/tick/watchdog only
   after approving evidence. Acceptance requires `last_tick` to advance for TWO
   consecutive slots in the new-root heartbeat/summary. Exit 0 alone proves no
   progress. Repair activation is separate, requiring spend authorization and
   provider credentials privately; these are not model-free handover prerequisites.

No spool probes are authorized by this document. Any new probe requires separate
recorded owner authorization. Retain the heartbeat endpoint confirmation from the
old handover as evidence, without inventing new live evidence.

## Subsequent deploy and rollback

Stop timers/records and wait for tick inactivity before invoking `switch`.
Keep a reviewed copy of the P2 helper outside the checkout when rolling back to
an import commit whose original helper predates P2.

```sh
python3 /retained/prepare-host.py --overlay /private/host.json switch --sha FULL40SHA --tag crq-runner/YYYYMMDD-N
```

The helper verifies tag and `origin/main` ancestry without fetching. Under one
nonblocking tick lock it rechecks stopped units, renders CURRENT SHA + overlay
into a temporary file, and compares every byte with live config. Drift reports
field names only and refuses before restore/checkout. Resolve drift by an approved
overlay/repository change and a recorded render, never by editing live JSON.
It refuses other dirty/untracked files; restores tracked config; requires a clean
Git status; checks out detached; records and atomically re-renders target config;
and requires status to show only ` M apps/crq-python/config.json`.
The same protocol applies to rollback. State is ignored and retained in place.

`--live-config` (alias `live-config`) performs only a recorded, locked config
re-render, with no marker/unit changes. It is not a checkout-switch shortcut and
is never authorized on the old checkout. During a switch, the same render stays
inside the already-held tick lock. If anything fails after checkout, leave units
stopped, preserve the private records and recover with the owner; do not start an
unverified candidate. Reinstall/verify changed unit templates from the target
before owner restart. The owner starts units only after reviewing config and unit
hashes plus Git status; then confirms completed heartbeat slots.

## P2 review deferrals and protection

This replaces the stale W5 lease/test suspension in `coverage.md`, distinguishes
the completed cross-host handover from current deployment, removes its unapproved
spool probes, and makes repair credentials optional for model-free handover.
Under the proposed deployed-system protection narrowing (#328), P2 still touches
protected `ops/prepare-host.py`, `ops/systemd/*` and `config.json`. The renderer
and switch guard stay within the protected helper. No signer byte changes.
