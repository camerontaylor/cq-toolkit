"""Retain a repair attempt's Git and untracked state before reusing its tree."""
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tarfile
import tempfile

from crq_repair import atomic, command, git


def cleanup_harvested(clone, wt_root, directory, item, job_id, result, *, alternate=False):
    """Remove only a clean, job-owned tree whose current commit is archived."""
    if result.get('verdict') not in ('FIXED', 'NOT-FIXED'):
        return False  # Failed results still need their original tree for recovery.
    root = Path(wt_root).resolve()
    raw = Path(result.get('worktree', ''))
    if raw.is_symlink():
        return False
    wt = raw.resolve()
    name = 'crq-repair-' + item + '-' + job_id
    if wt.parent != root or wt.name not in (name, name + '-A2'):
        return False
    if alternate:
        wt = root / (name if wt.name.endswith('-A2') else name + '-A2')
    if wt.is_symlink() or not wt.is_dir():
        return False
    status = command(['git', 'status', '--porcelain', '--untracked-files=all', '--ignored'], cwd=wt)
    if status.returncode or status.stdout:
        return False
    head = git(wt, 'rev-parse', 'HEAD')
    for path in Path(directory).glob('**/retained-*/manifest.json'):
        try:
            manifest = json.loads(path.read_text())
            token = hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            if path.parent.name != 'retained-' + token or manifest['head'] != head or manifest['base'] != result['repair_base']:
                continue
            for name in ('staged.patch', 'unstaged.patch', 'committed.patch', 'untracked.tar', 'commits.bundle'):
                with (path.parent / name).open('rb') as stream:
                    if hashlib.file_digest(stream, 'sha256').hexdigest() != manifest['sha256'][name]:
                        raise ValueError('archive digest mismatch')
        except (OSError, ValueError, KeyError, TypeError):
            continue
        return command(['git', 'worktree', 'remove', str(wt)], cwd=clone).returncode == 0
    return False


def retain(wt, base, directory, *, include_clean=False):
    """Capture staged, unstaged, untracked and committed work without changing it.

    A failed or interrupted capture raises before the caller may reset. Each
    immutable snapshot has a content-derived directory, so repeated captures
    cannot overwrite earlier evidence.
    """
    wt = Path(wt)
    head = git(wt, 'rev-parse', 'HEAD')
    if command(['git', 'merge-base', '--is-ancestor', base, head], cwd=wt).returncode:
        raise ValueError('cannot retain worktree with unrelated HEAD')
    def raw(*args):
        return subprocess.run(['git', *args], cwd=wt, check=True, capture_output=True, timeout=120).stdout
    staged = raw('diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary', '--')
    unstaged = raw('diff', '--no-ext-diff', '--no-textconv', '--binary', '--')
    committed = raw('diff', '--no-ext-diff', '--no-textconv', '--binary', base, head, '--')
    names = raw('ls-files', '--others', '--exclude-standard', '-z').split(b'\0')
    names = [os.fsdecode(name) for name in names if name]
    commits = git(wt, 'rev-list', '--reverse', base + '..' + head).splitlines()
    if not include_clean and not staged and not unstaged and not names and not commits:
        return None
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.capture-', dir=directory) as temp:
        temp = Path(temp)
        (temp / 'staged.patch').write_bytes(staged)
        (temp / 'unstaged.patch').write_bytes(unstaged)
        (temp / 'committed.patch').write_bytes(committed)
        bundle = temp / 'commits.bundle'
        if commits:
            subprocess.run(['git', 'bundle', 'create', str(bundle), 'HEAD', '^' + base],
                           cwd=wt, check=True, capture_output=True, timeout=120)
        else:
            bundle.write_bytes(b'')
        with tarfile.open(temp / 'untracked.tar', 'w', dereference=False) as archive:
            for name in names:
                path = wt / name
                mode = path.lstat().st_mode
                if not (stat.S_ISREG(mode) or stat.S_ISLNK(mode)):
                    raise ValueError('unsupported untracked file type; worktree retained')
                archive.add(path, arcname=name, recursive=False)
        hashes = {}
        for name in ('staged.patch', 'unstaged.patch', 'committed.patch', 'untracked.tar', 'commits.bundle'):
            with (temp / name).open('rb') as stream:
                hashes[name] = hashlib.file_digest(stream, 'sha256').hexdigest()
        manifest = {'base': base, 'head': head, 'commits': commits, 'untracked': names, 'sha256': hashes}
        token = hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        atomic(temp / 'manifest.json', manifest)
        target = directory / ('retained-' + token)
        if not target.exists():
            os.rename(temp, target)
        return target
