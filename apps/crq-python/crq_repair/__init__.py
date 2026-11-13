"""Detached repair contracts. Queue ownership remains in crq.py."""
import datetime as dt
import json
import os
from pathlib import Path
import re
import subprocess
import signal
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
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(name).unlink(missing_ok=True)


def command(argv, cwd=None, env=None, timeout=1200):
    with subprocess.Popen(argv, cwd=cwd, env=env, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True, start_new_session=True) as process:
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            # Only this command's owned process group, never unrelated workers.
            os.killpg(process.pid, signal.SIGTERM)
            try:
                stdout, stderr = process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                stdout, stderr = process.communicate()
            # Keep the partial output: the caller must still be able to write
            # the timed-out invocation to driver.log.
            raise subprocess.TimeoutExpired(argv, timeout, output=stdout, stderr=stderr)
        return subprocess.CompletedProcess(argv, process.returncode, stdout, stderr)


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
        if not re.search(r'(?<!\d)' + re.escape(job) + r'(?!\d)', git(wt, 'show', '-s', '--format=%B', sha)):
            raise ValueError('commit message missing finding id')
    if set(git(wt, 'rev-list', base + '..HEAD').splitlines()) != set(commits):
        raise ValueError('unclaimed commits in repair range')
    if git(wt, 'status', '--porcelain'):
        raise ValueError('dirty repair tree')
    return head


# One argv string is capped by the kernel (Linux MAX_ARG_STRLEN, 128 KiB);
# stay below it so an oversized repair fails closed with a clear reason.
MAX_HACK_DETECTOR_DIFF_BYTES = 120_000


class DetectorRejection(ValueError):
    """The detector rendered a verdict over this exact diff.

    Findings, an oversized diff or an unparseable diff are properties of the
    repair itself, so the same verdict returns on every later tick."""


class DetectorUnavailable(ValueError):
    """The detector produced no verdict, so a later tick may succeed.

    A CliErrorArtifact means the CLI never ran the op; that cause is
    environmental. Retrying is the documented behaviour for such failures."""


def hack_detector(cq_bin, diff, cwd):
    """Run `cq gates.hackDetector` over the diff TEXT. Fail closed: raise
    ValueError unless the op returns status ok with no findings.

    The cq CLI has no `@file` expansion. `--diff=@<path>` scanned the literal
    path string, which never parses as a diff, so every repair commit was
    rejected as `indeterminate`. Pass the diff itself."""
    if len(diff.encode()) > MAX_HACK_DETECTOR_DIFF_BYTES:
        raise DetectorRejection('hack detector did not pass: repair diff too large to scan (%d bytes)'
                                % len(diff.encode()))
    p = command(['node', cq_bin, 'gates.hackDetector', '--diff=' + diff, '--json'], cwd=cwd)
    try:
        data = json.loads(p.stdout)
    except ValueError:
        raise DetectorUnavailable('hack detector did not pass: unreadable output (exit %s): %s'
                                  % (p.returncode, (p.stderr or p.stdout)[:300])) from None
    if not isinstance(data, dict):
        raise DetectorUnavailable('hack detector did not pass: unexpected output shape: '
                                  + str(p.stdout)[:300])
    value = data.get('value')
    if p.returncode or data.get('status') != 'ok' or not isinstance(value, list) or value:
        detail = (json.dumps([{k: f.get(k) for k in ('kind', 'file', 'message')} for f in value
                              if isinstance(f, dict)])
                  if isinstance(value, list) and value else
                  str(data.get('detail') or data.get('error') or data.get('status')))
        # `{"error": {...}}` is the CLI's CliErrorArtifact: the op never ran.
        unavailable = isinstance(data.get('error'), dict)
        raise (DetectorUnavailable if unavailable else DetectorRejection)(
            'hack detector did not pass: ' + detail[:600])
    return data


def findings(path, *, provenance=False):
    result = []
    if provenance:
        import pr_review_findings
        published = pr_review_findings.load_findings(path)
    for line in Path(path).read_text(errors="replace").splitlines():
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
        finding = {'severity': e['severity'], 'path': e.get('fileName'),
                   'line': int(match[1]) if match else None, 'body': body}
        if provenance:
            source = {key: e[key] for key in ('id', 'source_id', 'review_id', 'thread_id', 'source_thread_id')
                      if e.get(key) is not None}
            # Use the publisher's deduplicated ordinal, including lower severities.
            start, end = pr_review_findings._line(e.get('startLine')), pr_review_findings._line(e.get('endLine'))
            start, end = start or end, end or start
            if start and end and start > end:
                start, end = end, start
            matches = [n for n, f in enumerate(published, 1)
                       if (f['path'], f['start'], f['end'], f['title'], f['text']) ==
                       (e.get('fileName'), start, end, str(e.get('title') or '').strip(),
                        str(e.get('comment') or e.get('title') or '').strip())]
            if len(matches) == 1:
                source['finding_number'] = matches[0]
            finding['_source'] = source
        result.append(finding)
    return result
