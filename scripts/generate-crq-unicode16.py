#!/usr/bin/env python3
"""Generate compact Python 3.14 / Unicode 16.0 word and whitespace ranges.

Run: python3.14 scripts/generate-crq-unicode16.py
The JSON on stdout is the canonical pair of base64 unsigned-varint range streams.
Each range is encoded as (start minus previous end minus one, length minus one),
with the initial previous end equal to -1. No runtime Python dependency.
"""
import base64
import json
import sys
import unicodedata

if sys.version_info[:2] != (3, 14) or unicodedata.unidata_version != "16.0.0":
    raise SystemExit("requires Python 3.14 with Unicode 16.0.0")


def varint(value):
    result = bytearray()
    while value >= 128:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return result


def encode(predicate):
    result = bytearray()
    previous = -1
    start = None
    for code in range(0x110001):
        selected = code < 0x110000 and predicate(chr(code))
        if selected and start is None:
            start = code
        elif not selected and start is not None:
            end = code - 1
            result.extend(varint(start - previous - 1))
            result.extend(varint(end - start))
            previous = end
            start = None
    return base64.b64encode(result).decode("ascii")


print(json.dumps({"word": encode(lambda ch: ch.isalnum() or ch == "_"), "space": encode(str.isspace)}, separators=(",", ":")))
