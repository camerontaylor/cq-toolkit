"""One injective URL alias for canonical v1 promotion identities."""
import re


def record_id(item):
    if not isinstance(item, str) or not re.fullmatch(r'promo-[0-9a-f]{10}\+{0,9}', item):
        raise ValueError('record aliases require an exact canonical v1 promotion id')
    return item.replace('+', '_')


def canonical_id(alias):
    if not isinstance(alias, str) or not re.fullmatch(r'promo-[0-9a-f]{10}_{0,9}', alias):
        raise ValueError('invalid promotion record alias')
    item = alias.replace('_', '+')
    if record_id(item) != alias:
        raise ValueError('ambiguous promotion record alias')
    return item


def legacy_record_id(item):
    """Read compatibility only; legacy user-mode records never become aliases."""
    if not isinstance(item, str) or not re.fullmatch(r'promo-[0-9a-f]{10}(?:-delta)?\+*', item):
        raise ValueError('invalid legacy promotion record id')
    return item
