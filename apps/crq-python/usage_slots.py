"""Offline slot arithmetic and bounded, repository-scoped vendor observations."""
import datetime as dt
import json
import math
import subprocess
import time


def parse_usage(stream):
    """Partial usage is useful only with a trustworthy included remaining count."""
    for line in stream.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        included = event.get('includedReviews') if isinstance(event, dict) else None
        if not isinstance(included, dict):
            continue
        if included.get('state') not in (None, 'available'):
            continue
        remaining = included.get('remaining')
        limit = included.get('limit')
        if type(remaining) is not int or remaining < 0:
            continue
        if limit is not None and (type(limit) is not int or limit < remaining or limit <= 0):
            continue
        result = {'remaining': remaining}
        for key in ('limit', 'rollingWindowMs', 'fullCapacityInMs'):
            value = included.get(key)
            if type(value) is int and value >= 0:
                result[key] = value
        return result
    return None


def read_usage(clone):
    try:
        result = subprocess.run(['coderabbit', 'usage', '--agent'], cwd=clone,
                                capture_output=True, text=True, timeout=20)
        return parse_usage(result.stdout) if result.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def next_slot(starts, at, usage):
    """Known starts give the earliest candidate, never permission to spend.

    fullCapacityInMs is when ALL slots recover, not the next slot. It is an
    upper-bound fallback when other consumers have used slots we cannot date.
    Every wake reads usage again before admitting new work.
    """
    window = dt.timedelta(milliseconds=(usage or {}).get('rollingWindowMs') or 3600000)
    candidates = [s + window for s in starts if at - window < s <= at]
    full = (usage or {}).get('fullCapacityInMs')
    if full and (usage or {}).get('remaining') == 0:
        candidates.append(at + dt.timedelta(milliseconds=full))
    return min(candidates) if candidates else None


def schedule_wake(deadline, at, previous, run):
    """One fixed transient timer; failed probes/creation remain retryable.

    The persistent calendar timer is always the recovery fallback. Only create
    a wake earlier than its next twelve-minute boundary. State is advisory;
    systemd's active check prevents stale state from suppressing recreation.
    """
    boundary = (int(at.timestamp()) // 720 + 1) * 720
    if deadline is None or deadline.timestamp() >= boundary:
        return previous
    target = deadline.strftime('%Y-%m-%dT%H:%M:%SZ')
    unit = 'crq-slot-wake'
    began = time.monotonic()
    try:
        active = run(['systemctl', '--user', 'is-active', unit + '.timer'],
                     check=False, timeout=10).returncode == 0
        if active and previous and previous <= target and previous > at.strftime('%Y-%m-%dT%H:%M:%SZ'):
            return previous
        # Stop both halves so an elapsed but not yet collected service cannot
        # collide with the fixed transient name on recreation.
        run(['systemctl', '--user', 'stop', unit + '.timer', unit + '.service'],
            check=False, timeout=10)
        delay = max(1, math.ceil((deadline - at).total_seconds() - (time.monotonic() - began)))
        result = run(['systemd-run', '--user', '--collect', '--unit=' + unit,
                      '--on-active=' + str(delay) + 's', '--timer-property=AccuracySec=1s',
                      '/usr/bin/systemctl', '--user', '--no-block', 'start', 'crq-tick.service'],
                     check=False, timeout=10)
        return target if result.returncode == 0 else None
    except (OSError, RuntimeError, subprocess.TimeoutExpired):
        return None
