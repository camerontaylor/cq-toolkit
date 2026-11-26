# CRQ tick shadow on the queue host: read-only procedure (S6-0)

Audience: the deploy operator. This compares what can be compared **today**:
the TypeScript tick's scheduling pass against the production Python runner, on
a frozen copy of live state. It never writes live state, never takes
`tick.lock`, and never starts or stops a unit. It does **not** authorize a
switch: `tick` and `slot` stay Python until every row in
[tick-slot-missing-effects.md](tick-slot-missing-effects.md) is closed and both
commands are routed and declared in `LIVE_UNIT_COMMANDS`.

## What is compared

`node crq.js tick --dry-run` runs only the scheduling pass (`planTick`,
`src/queue-runner/tick.ts`). It writes a plan to `<cwd>/shadow/<uuid>.json`
and exits 1 with `{"status":"indeterminate", ...}`. That exit is expected: the
plan is incomplete by design, and its `reason` lists the missing effects.
`apps/crq-python/tick_shadow_compare.py` imports the production `crq.py`
against the same frozen copy, with the clock pinned to the plan's `last_tick`,
and compares these fields:

| Field                                                            | Python source                                              |
| ---------------------------------------------------------------- | ---------------------------------------------------------- |
| `admission.usage`, `admission.reserved`                          | `read_slot_usage`                                          |
| `admission.slots`, `gate`, `log`                                 | `admit_available` (launch stubbed: nothing starts)         |
| `admission.admissions`, `inflight`, `startsLastHour`             | `admit_available`'s budget, `inflight`, `starts_last_hour` |
| `harvest.alive` / `ambiguous` / `harvestable`                    | `run_liveness` per reviewing run                           |
| `normalized.retired`, `normalized.boostsDropped`                 | `load_queue` normalization                                 |
| `candidates` (first 50 pending: id, kind, rank, order, priority) | `sort_key`, `rank`                                         |
| `backgroundTurn`                                                 | `background_turn`                                          |

Not comparable yet: discovery, harvest effects, launches, delivery, repair,
backfill, status, heartbeat and the whole `slot` command. The comparator
prints the plan's `missing_effects` list with every result.

## Procedure (on the queue host)

Use an artifact built from a `main` SHA that contains this PR. Older
artifacts lack the promotion-row `boost` fix and show a spurious
`boostsDropped` difference when a retired promotion row still has `boost`.

1. Locate the live runner root and the artifact. Read only.

   ```sh
   CRQ_ROOT=$(systemctl --user show crq-tick.service -p WorkingDirectory --value)
   SHA=<merged main sha>
   CRQ_JS=$HOME/.local/opt/crq-$SHA/dist/queue-runner/crq.js
   test -f "$CRQ_JS" && test -f "$CRQ_ROOT/config.json"
   ```

2. Freeze a copy: `config.json`, the queue, the disabled marker, and the run
   directories of reviewing items only. Live files are only read. `queue.json`
   is replaced atomically, so a copy taken during a tick is still a whole
   document.

   ```sh
   SCRATCH=$(mktemp -d "$HOME/.local/state/crq-tick-shadow.XXXXXX")
   FROZEN=$SCRATCH/root
   mkdir -p "$FROZEN/state/runs" "$SCRATCH/out"
   cp -p "$CRQ_ROOT/config.json" "$FROZEN/"
   cp -p "$CRQ_ROOT/state/queue.json" "$FROZEN/state/"
   test -e "$CRQ_ROOT/state/runner-disabled" && cp -p "$CRQ_ROOT/state/runner-disabled" "$FROZEN/state/"
   python3 -I -c 'import json,sys; q=json.load(open(sys.argv[1]))
   for i in q.get("items", []):
       r = i.get("run") or {}
       if i.get("state") == "reviewing" and i.get("kind") != "promotion" and r.get("run_id"):
           print(r["run_id"])' "$FROZEN/state/queue.json" |
     while read -r run; do cp -a "$CRQ_ROOT/state/runs/$run" "$FROZEN/state/runs/"; done
   sha256sum "$CRQ_ROOT/state/queue.json" "$FROZEN/state/queue.json"
   ```

   The two digests should match. If a tick replaced the queue meanwhile, start
   this step again.

3. Run the TypeScript dry run inside the frozen copy. `cwd` decides every
   path it reads and the one file it writes (`shadow/<uuid>.json`).

   - **Sample A (default, no vendor call).** Run without `coderabbit` on
     `PATH`: usage is unavailable on both sides, which exercises the hourly
     fallback and the held reservations.

     ```sh
     NODE=$(command -v node)
     env PATH=/usr/bin:/bin sh -c 'command -v coderabbit' && echo "coderabbit still on PATH: stop"
     (cd "$FROZEN" && env PATH=/usr/bin:/bin "$NODE" "$CRQ_JS" tick --dry-run)
     ```

   - **Sample B (one vendor read).** Run with the normal `PATH`. The plan then
     runs `coderabbit usage --agent` in `config.clone`. That is a quota read
     and spends no review. The comparator reuses that observation for Python,
     so the vendor is asked once.

4. Get the comparator from the same SHA, without fetching into the deploy
   clone. Either `scp` it from a workstation checkout of `$SHA`, or use any
   other clone that already has the commit:

   ```sh
   git -C <clone with $SHA> show "$SHA:apps/crq-python/tick_shadow_compare.py" > "$SCRATCH/tick_shadow_compare.py"
   ```

5. Compare. `--python-root` is the deployed tree whose `crq.py` is the
   oracle. The comparator copies its `.py` files into a temporary directory
   and links that copy's `state` to the FROZEN state, so the live tree is
   only read. It refuses `--runner-root` equal to `--python-root`.

   ```sh
   PLAN=$(ls -t "$FROZEN"/shadow/*.json | head -1)
   python3 -I "$SCRATCH/tick_shadow_compare.py" --python-root "$CRQ_ROOT" \
     --runner-root "$FROZEN" --ts-plan "$PLAN" | tee "$SCRATCH/out/compare.json"
   ```

   Exit codes: 0 identical, 1 differences listed in `diffs`, 2 unusable input
   (the reason is in `error`).

6. Confirm nothing live moved, then archive the evidence and remove the
   scratch tree.

   ```sh
   sha256sum "$CRQ_ROOT/state/queue.json"
   trash "$SCRATCH"
   ```

   The queue digest may differ from step 2 only because the live tick ran in
   between; the shadow itself never writes there. Keep `compare.json` and the
   plan with the deploy notes first.

Take a few samples across ordinary states: idle, reviews in flight, quota
cooldown or a paused queue when they occur, and the runner-disabled marker.
Do not create states to sample them.

## Which differences are acceptable

A difference is **explained** only in these cases, and must be recorded with
the explanation:

1. **A run changed between the two probes.** A review finished or started
   reporting progress between the TypeScript run and the comparator. This
   shows in `harvest.*`, `admission.reserved` or `slots`. Re-run steps 3 and 5
   on the same frozen copy: process probes are live, so a real timing
   difference moves or disappears, and a decision difference stays.
2. **The one-second clock boundary.** The TypeScript clock has millisecond
   precision; Python is pinned to the plan's whole-second `last_tick`. A start,
   hold or `cooldown_until` less than one second from a cutoff can land on
   either side.
3. **Pre-fix artifact.** On an artifact older than this PR,
   `normalized.boostsDropped` counts `boost` on retired promotion rows.
4. **`--live-usage`.** That mode re-reads vendor usage for Python, so
   `admission.usage` and anything derived from it may differ. The default does
   not use this mode.

Every other difference is a defect: the gate, slots, admissions, in-flight
count, hourly count, reservations, harvest classes, retirements, candidate
order or rank, or the background turn, if it persists on a re-run. Record it
and open an issue against the port. A TypeScript refusal (`status: failed`) of
a queue that Python loads, for example one needing admission-history
compaction, is also a finding to record, not an acceptable difference.

## Rollback

Nothing is switched, so nothing is rolled back. The procedure only creates a
scratch directory under `~/.local/state`, removed in step 6.
