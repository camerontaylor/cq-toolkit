Private slot lock contract for review.address and review-loop integration

Use only on local Linux/macOS disks. The caller must establish that storage is
local; the adapter does not identify network, FUSE, or shared VM mounts.

Keep the returned slot object until actual writer drain and call `close()` in
cleanup. `slot.fd` is borrowed solely for controlled subprocess inheritance:
never close or unlock it directly. A module-level strong reference pins each
FileHandle until explicit close, preventing Node's GC finalizer from silently
releasing exclusion if a caller retains only the fd. Dropping the slot without
closing leaks exclusion until process exit. No timeout reclaims it.

Acquire the original-repo PR slot before clone creation, fetch, or worktree
add/remove; acquire the canonical checkout key afterwards, in that order.
Call `assertReusable()` before reuse/dispatch. Acquisition permits inspection
and reconciliation, not reuse of incomplete work. Persist `incomplete: true`
before opaque writer dispatch and clear only after actual drain. An unbound
record has no checkout identity; a bound record stores canonical paths.

Never rename or unlink lock files. External replacement is detected at API
boundaries, not continuously; arbitrary same-user writers are not excluded by
an advisory protocol. An inherited fd remains locked after the parent closes
its reference. Unsupported platform/addon/syscall failures use UnsupportedLockError;
contention uses SlotBusyError. Ordinary lock-open filesystem failures preserve
their errno (including ELOOP for a symlink). Other filesystem/identity/metadata errors
propagate and must also refuse dispatch.

Metadata uses a unique temporary file, fsync, rename, and directory fsync. A
SIGKILL before rename can leave a temporary file; readers ignore these files.
They are retained for inspection, with no automatic age-based cleanup. Only the
exact slot JSON file is metadata. Recovery must reconcile incomplete state and
contents under the held lock; clean Git status alone does not prove quiescence.
