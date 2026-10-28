#!/usr/bin/env python3
"""Minute entry: read the hint BEFORE runner imports, locks or network calls."""
import datetime as dt
import os


def future(path, at):
    try:
        with open(path) as hint:
            stamp = dt.datetime.strptime(hint.read(64).strip(), '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=dt.timezone.utc)
        return stamp > at
    except (OSError, ValueError):
        return False


def main(state_dir=None, clock=None, load_runner=None):
    clock = clock or (lambda: dt.datetime.now(dt.timezone.utc))
    state_dir = state_dir or os.path.join(os.path.dirname(os.path.realpath(__file__)), 'state')
    hint = os.path.join(state_dir, 'next-review-at')
    if future(hint, clock()):
        return 0
    # Even fcntl and the runner are lazy: idle timer invocations only read text.
    import fcntl
    os.makedirs(state_dir, exist_ok=True)
    with open(os.path.join(state_dir, 'tick.lock'), 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        if future(hint, clock()):
            return 0
        if load_runner is None:
            import crq
            runner = crq
        else:
            runner = load_runner()
        for line in runner.slot():
            print(line)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
