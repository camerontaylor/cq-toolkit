# CRQ TypeScript runner

The runner entry point is `src/queue-runner/crq.ts`, built as
`dist/queue-runner/crq.js` and exposed as `crq`. Run `crq tick --dry-run` from
its state directory (containing `queue.json`) to write a unique file under
`shadow/`. The recorded plan currently covers only the queue's `last_tick`
update; it explicitly marks itself incomplete because discovery, harvest and
admission are not ported. A `runner-disabled` marker produces an empty plan.
Incomplete plans exit 1 with an indeterminate result and must not be used as
parity or C2 comparison evidence.

Other commands and live execution refuse until their Python equivalents are
ported. No heartbeat is emitted. Planners must not perform mutations themselves;
later ports must preserve the shared locking contract.
