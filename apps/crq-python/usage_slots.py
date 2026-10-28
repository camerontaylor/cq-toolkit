"""Offline slot arithmetic and bounded, repository-scoped vendor observations."""
import datetime as dt
import json
import os
import tempfile
import subprocess


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


def vendor_progress(path):
    """Bounded positive evidence; context/launch/claim alone cannot release a hold."""
    try:
        with path.open(errors='replace') as stream:
            lines = stream.read(65536).splitlines()
    except OSError:
        return False
    for line in lines:
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict) and (
                event.get('type') == 'status' and event.get('status') in ('reviewing', 'writing') or
                event.get('type') == 'heartbeat' and event.get('status') == 'reviewing'):
            return True
    return False


def next_slot(starts, at, usage):
    """Known starts give the earliest candidate, never permission to spend.

    fullCapacityInMs is when ALL slots recover, not the next slot. It is an
    upper-bound fallback when other consumers have used slots we cannot date.
    Every wake reads usage again before admitting new work.
    """
    window = dt.timedelta(milliseconds=(usage or {}).get('rollingWindowMs') or 3600000)
    known = [s for s in starts if at - window < s <= at]
    candidates = [s + window for s in known]
    full = (usage or {}).get('fullCapacityInMs')
    if full and (usage or {}).get('remaining') == 0:
        candidates.append(at + dt.timedelta(milliseconds=full))
    used = ((usage or {}).get('limit', 10) - (usage or {}).get('remaining', 0))
    if not known or usage is not None and used > len(known):
        # Unknown external starts, or local reservations that precede vendor
        # admission: full-capacity recovery cannot date the FIRST slot.
        candidates.append(at + dt.timedelta(seconds=60))
    return min(candidates) if candidates else None


def write_next(path, deadline):
    """A tiny atomic hint, separate from authoritative queue state."""
    path.parent.mkdir(parents=True, exist_ok=True)
    stamp = deadline.strftime('%Y-%m-%dT%H:%M:%SZ')
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as out:
        out.write(stamp + '\n')
        temporary = out.name
    os.replace(temporary, path)
