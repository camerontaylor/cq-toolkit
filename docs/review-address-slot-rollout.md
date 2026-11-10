# Review-address slot rollout

This is the D6 deployment sequence for the slot ownership redesign. Merging D
is a code change; it does not authorize starting the new selfhost sweep over
old state. D retains the D2 stat-only refusal for every applicable legacy
registry. D never parses, imports or deletes that registry.

## Selected sequence: E before the first slot-based selfhost sweep

1. Stop the dispatcher's owned old address/review/selfhost admissions and timers.
   Let actual runs and writer process groups drain. Inspect partial work; an old
   PID's absence or a clean status alone does not prove writer quiescence.
2. Keep the self-review workflow/schedules stopped through the cache transition.
   Its cache restores `.selfhost/journal`, including `worktree-registry.json`,
   and saves that directory even after a failed sweep. Moving a file only from
   a host checkout does not remove it from the next restored cache.
3. Preserve the restored journal and all applicable legacy registry bytes,
   dispatch logs, sessions, audit reports, worktrees, indexes and failed-attempt
   refs. Keep the cache contents available for E's requested-key import; do not
   clear ownership pointers while losing the work they name.
4. Merge/deploy E before enabling the first slot-based selfhost invocation.
   Use the binary containing E against the freshly restored journal. E owns the
   bounded requested-PR import under the same slot locks, current Git identity
   and dirty/unpushed checks. It preserves legacy files; valid new per-slot
   metadata then takes precedence. An uncertain checkout stays incomplete and
   goes through E's operator reconciliation procedure.
5. Resume only after old-writer quiescence and the cache/import sequence are
   established. Do not run a D-only sweep as a migration attempt, then let the
   workflow save the unchanged legacy file and repeat the refusal. Do not run
   the old binary over switched slot state.

Thus cached `worktree-registry.json` is handled **before the first D selfhost
sweep by sequencing E first**, rather than changing D's mandatory refusal.
There is no D importer, automatic cache deletion or migration-complete marker.

## Settled refusals are not crash recovery

The owner's D5.4 ruling permits the current admission to complete after a pure
check refusal or a failed fetch observed through actual child close, with no
checkout/ref mutator or opaque writer dispatched and unchanged identities.
Reports and all tracked work must settle before flags clear. A failure after
worktree add/remove, config/ref writes, writer dispatch, incomplete metadata
persistence, or unaccounted writer state retains `incomplete=true`. E still owns
operator reconciliation of those incomplete predecessors.
