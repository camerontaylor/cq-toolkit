"""UTC timestamp parsing for scheduling and its public preview."""
import datetime as dt


def parse_utc(value):
    """Accept ISO timestamps (including compact run suffixes); naive means UTC.

    Missing, non-string and malformed values return None, never local time.
    """
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.timezone.utc)
        return parsed.astimezone(dt.timezone.utc)
    except (ValueError, TypeError, OverflowError):
        return None
