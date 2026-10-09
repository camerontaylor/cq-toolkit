"""Detached repair contracts. Queue ownership remains in crq.py."""
import datetime as dt
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


def utc():
    return dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def atomic(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(value, out, indent=2)
            out.write('\n')
            out.flush()
            os.fsync(out.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def command(argv, cwd=None, env=None, timeout=1200):
    return subprocess.run(argv, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)


def git(wt, *args):
    p = command(['git', *args], cwd=wt)
    if p.returncode:
        raise RuntimeError('git ' + args[0] + ' failed: ' + p.stderr[:200])
    return p.stdout.strip()


def verify(wt, base, commits, job):
    if not commits or len(set(commits)) != len(commits):
        raise ValueError('missing or duplicate claimed commits')
    head = git(wt, 'rev-parse', 'HEAD')
    for sha in commits:
        if not re.fullmatch('[0-9a-fA-F]{40}', sha):
            raise ValueError('claimed commit is not 40-hex')
        git(wt, 'cat-file', '-e', sha + '^{commit}')
        if sha == base or command(['git', 'merge-base', '--is-ancestor', base, sha], cwd=wt).returncode:
            raise ValueError('commit is not a strict descendant of base')
        if command(['git', 'merge-base', '--is-ancestor', sha, head], cwd=wt).returncode:
            raise ValueError('commit is not an ancestor of HEAD')
        if not git(wt, 'diff-tree', '--root', '--no-commit-id', '--name-only', '-r', sha):
            raise ValueError('empty commit')
        if not re.search(re.escape(job) + r'(?!\d)', git(wt, 'show', '-s', '--format=%B', sha)):
            raise ValueError('commit message missing finding id')
    if set(git(wt, 'rev-list', base + '..HEAD').splitlines()) != set(commits):
        raise ValueError('unclaimed commits in repair range')
    if git(wt, 'status', '--porcelain'):
        raise ValueError('dirty repair tree')
    return head


def findings(path):
    result = []
    for line in Path(path).read_text().splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get('type') != 'finding' or e.get('severity') not in ('critical', 'major'):
            continue
        body = e.get('codegenInstructions') or e.get('comment') or ''
        suggestion = e.get('suggestions')
        if suggestion:
            body += '\n' + (suggestion if isinstance(suggestion, str) else json.dumps(suggestion))
        match = re.search(r'(?:around lines?|at line)\s+(\d+)', body, re.I)
        result.append({'severity': e['severity'], 'path': e.get('fileName'),
                       'line': int(match[1]) if match else None, 'body': body})
    return result
