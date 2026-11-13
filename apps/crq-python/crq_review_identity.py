"""Acyclic App transport through cq-review-post's token-only interface.

Deployment requires the agents helper's repo-scoped-v1 capability. No runtime
helper imports and no posting/findings invocation: that mode would invoke this
publisher recursively. Neither captured stream may enter a log or receipt.
"""
import datetime as dt
import json
import os
import subprocess
import time


class IdentityUnavailable(RuntimeError):
    """Safe reason code only: never include helper output or exception detail."""


def _helper(args):
    try:
        return subprocess.run(['cq-review-post', *args], capture_output=True, text=True, timeout=60)
    except FileNotFoundError:
        raise IdentityUnavailable('helper-missing') from None
    except (OSError, subprocess.SubprocessError):
        raise IdentityUnavailable('helper-unavailable') from None


def authenticated_gh(repo):
    """Capture credentials privately; once selected never switch identity on POST.

    The helper fails closed and cannot post. The caller may explicitly select an
    unattested host identity only before making any App publication request.
    """
    probe = _helper(['--capabilities'])
    try:
        supported = json.loads(probe.stdout).get('installation_token') == 'repo-scoped-v1'
    except (ValueError, AttributeError):
        supported = False
    if probe.returncode or not supported:
        raise IdentityUnavailable('helper-capability-missing')
    result = _helper(['--installation-token', '--repo', repo])
    if result.returncode:
        raise IdentityUnavailable('app-credentials-unavailable')
    token = result.stdout.strip()
    try:
        expiry = dt.datetime.fromisoformat(json.loads(result.stderr)['expires_at'].replace('Z', '+00:00'))
        if expiry.tzinfo is None or expiry.timestamp() <= time.time() + 10:
            raise ValueError()
        if not token or any(c.isspace() for c in token):
            raise ValueError()
    except (ValueError, KeyError, TypeError, AttributeError):
        raise IdentityUnavailable('invalid-credential-response') from None
    env = {**os.environ, 'GH_TOKEN': token}

    def gh(argv, *, input_text=None):
        if time.time() + 10 >= expiry.timestamp():
            raise RuntimeError('App credentials expired; retry with the same identity')
        result = subprocess.run(argv, capture_output=True, text=True, input=input_text,
                                timeout=60, env=env)
        # Even a diagnostic/debug response must not carry the child credential
        # back into the queue's ordinary API-error reporting path.
        result.stdout = (result.stdout or '').replace(token, '[redacted]')
        result.stderr = (result.stderr or '').replace(token, '[redacted]')
        return result
    return gh
