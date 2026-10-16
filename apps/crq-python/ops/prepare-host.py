#!/usr/bin/env python3
"""Recorded, policy-free host rendering and stopped-runner checkout switches.

Nothing starts a unit. The overlay and deploy records must live outside Git.
See HOST-DEPLOY.md before using this on an approved deployment.
"""
import argparse
import contextlib
import copy
import datetime as dt
import fcntl
import hashlib
import json
import os
import plistlib
from pathlib import Path
import re
import subprocess
import tempfile
import uuid

CONFIG = 'apps/crq-python/config.json'
POLICY_FLOOR = 'f748fd43e75505f4e89098a4ffe28fa2a179a50c'  # import C
LEGACY_SHA = '0e35cd11153fc7ad681f002d580b9b22feb22092'
# A closed leaf allowlist, NOT arbitrary recursive config.update().
CONFIG_KEYS = {
    'clone', 'worktree_root', 'timeout_bin', 'paseo_hosts',
    'promotion.record_url_template', 'promotion.alert_agent_host',
    'promotion.signer.spool.dir', 'promotion.signer.spool.ssh_alias',
    'promotion.signer.spool.ssh_key', 'repair.enabled', 'repair.cq_bin',
    'repair.paseo_host',
}
HOST_KEYS = {'schema_version', 'deploy_root', 'record_dir', 'config', 'fleet_reader'}
PATH_KEYS = {'clone', 'worktree_root', 'timeout_bin', 'repair.cq_bin',
             'promotion.signer.spool.dir', 'promotion.signer.spool.ssh_key'}


def run(argv):
    return subprocess.run(argv, check=True, capture_output=True, text=True).stdout


def git(root, *args):
    return run(['git', '-C', str(root), *args]).rstrip('\n')


def encode(value):
    # Same config serialization as crq_repair.atomic; no wire/state changes.
    return (json.dumps(value, indent=2) + '\n').encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def outside(path, root):
    return not path.resolve().is_relative_to(root.resolve())


def host_path(value):
    # No systemd specifiers, whitespace, shell syntax or traversal in unit paths.
    if not isinstance(value, str) or not re.fullmatch(r'/[A-Za-z0-9_./-]+', value):
        raise ValueError('host paths must be absolute, without whitespace or specifiers')
    if '..' in Path(value).parts:
        raise ValueError('parent traversal is not a host path')
    return Path(value)


def leaves(value, prefix=''):
    if not isinstance(value, dict) or not value:
        raise ValueError('overlay config must contain only allowlisted leaves')
    for key, item in value.items():
        name = prefix + key
        if name in CONFIG_KEYS:
            yield name, item
        elif isinstance(item, dict) and item:
            yield from leaves(item, name + '.')
        else:
            raise ValueError('overlay key refused: ' + name)


def validate(overlay):
    if not isinstance(overlay, dict) or set(overlay) != HOST_KEYS:
        raise ValueError('overlay top-level keys must match the fixed schema')
    if type(overlay['schema_version']) is not int or overlay['schema_version'] != 1:
        raise ValueError('unsupported overlay schema_version')
    deploy = host_path(overlay['deploy_root'])
    records = host_path(overlay['record_dir'])
    if not outside(records, deploy):
        raise ValueError('deploy records must be outside the checkout')
    for name, value in leaves(overlay['config']):
        if name == 'repair.enabled':
            if value is not False:
                raise ValueError('overlay cannot enable repair')
        elif name == 'paseo_hosts':
            if not isinstance(value, list) or len(value) < 2 or any(not isinstance(v, str) or not v for v in value):
                raise ValueError('paseo_hosts must contain at least two nonempty endpoint strings')
        elif name in PATH_KEYS:
            # The accepted legacy renderer records a literal ~/ key path.
            # CRQ expands it only at SSH invocation; retain those config bytes.
            checked = value[1:] if name == 'promotion.signer.spool.ssh_key' and isinstance(value, str) and value.startswith('~/') else value
            host_path(checked)
        elif name == 'promotion.signer.spool.ssh_alias':
            if not isinstance(value, str) or not re.fullmatch(
                    r'[A-Za-z0-9_][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.:-]*', value):
                raise ValueError('spool ssh_alias must be a literal user@host')
        elif not isinstance(value, str) or not value or any(c in value for c in '\n\r\x00'):
            raise ValueError('overlay host values must be nonempty strings')
    # Paths/endpoints needed by the model-free runner must be explicit.
    supplied = dict(leaves(overlay['config']))
    required = CONFIG_KEYS - {'promotion.signer.spool.dir'}
    if not required <= supplied.keys():
        raise ValueError('missing host config keys: ' + ', '.join(sorted(required - supplied.keys())))
    try:
        supplied['promotion.record_url_template'].format(item='record-validation')
    except (ValueError, KeyError, IndexError, AttributeError, TypeError):
        raise ValueError('invalid promotion record URL template') from None
    for name in ('clone', 'worktree_root'):
        path = Path(supplied[name])
        if not outside(path, deploy) or not outside(deploy, path):
            raise ValueError('review clone/worktrees must be separate from deployment clone')
    fleet = overlay['fleet_reader']
    if not isinstance(fleet, dict) or set(fleet) != {'ssh_host', 'source'}:
        raise ValueError('fleet_reader accepts only ssh_host and source')
    if not isinstance(fleet['ssh_host'], str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@-]*', fleet['ssh_host']):
        raise ValueError('invalid fleet-reader ssh host')
    host_path(fleet['source'])
    return overlay


def require_outside_git(path):
    parent = Path(path).resolve()
    while not parent.is_dir():
        parent = parent.parent
    result = subprocess.run(['git', '-C', str(parent), 'rev-parse', '--show-toplevel'],
                            capture_output=True, text=True)
    if result.returncode == 0:
        raise ValueError('private host artifacts must be outside every Git checkout')


def load_overlay(path):
    path = Path(path).resolve()
    require_outside_git(path)
    if path.stat().st_mode & 0o077:
        raise ValueError('private overlay must have mode 0600')
    raw = path.read_bytes()
    overlay = validate(json.loads(raw))
    if not outside(path, Path(overlay['deploy_root'])):
        raise ValueError('overlay must be outside the checkout')
    return overlay, raw


def apply(config, overlay):
    config = copy.deepcopy(config)
    for name, value in leaves(overlay['config']):
        dest = config
        parts = name.split('.')
        for part in parts[:-1]:
            dest = dest[part]
        dest[parts[-1]] = value
    # Spend authorization is policy, not an overlay escape hatch.
    if config['repair']['enabled'] is not False:
        raise ValueError('repair must remain disabled')
    return config


def committed(root, sha='HEAD', path=CONFIG):
    return json.loads(run(['git', '-C', str(root), 'show', f'{sha}:{path}']))


def render(root, overlay, sha='HEAD'):
    return encode(apply(committed(root, sha), overlay))


def changed_fields(left, right, prefix=''):
    """Report field names, never private values."""
    if isinstance(left, dict) and isinstance(right, dict):
        result = []
        for key in sorted(left.keys() | right.keys()):
            name = prefix + str(key)
            if key not in left or key not in right:
                result.append(name)
            else:
                result.extend(changed_fields(left[key], right[key], name + '.'))
        return result
    return [] if left == right else [prefix.rstrip('.') or '<serialization>']


def drift_check(expected, live):
    # Materialize the candidate separately. Never render over live before comparison.
    with tempfile.TemporaryFile() as temp:
        temp.write(expected)
        temp.seek(0)
        candidate = temp.read()
    actual = Path(live).read_bytes()
    if actual != candidate:
        try:
            names = changed_fields(json.loads(candidate), json.loads(actual))
        except (ValueError, UnicodeError):
            names = ['<invalid JSON>']
        raise ValueError('config drift; refusing switch: ' + ', '.join(names or ['<serialization>']))


def atomic_bytes(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(data)
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


def record(root, overlay, raw, config, operation, **extra):
    directory = Path(overlay['record_dir'])
    require_outside_git(directory)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.stat().st_mode & 0o077:
        raise ValueError('private record directory must have mode 0700')
    data = dict(schema_version=1, operation=operation,
                at=dt.datetime.now(dt.timezone.utc).isoformat(),
                record_type='render-intent',
                sha=git(root, 'rev-parse', 'HEAD'), overlay_sha256=digest(raw),
                config_sha256=digest(config), **extra)
    atomic_bytes(directory / (uuid.uuid4().hex + '.json'), encode(data))
    return data


def unit_files(root):
    return sorted((root / 'apps/crq-python/ops/systemd').glob('crq-*'))


def inactive(root):
    names = {path.name for path in unit_files(root)}
    # Include obsolete installed files and loaded units whose files were removed.
    for command in ('list-unit-files', 'list-units'):
        args = ['systemctl', '--user', command, '--no-legend', '--no-pager', '--plain']
        if command == 'list-units':
            args.append('--all')
        for line in run([*args, 'crq-*']).splitlines():
            name = line.split()[0] if line.split() else ''
            if not name.startswith('crq-') or not re.fullmatch(r'[A-Za-z0-9_.@:-]+', name):
                raise ValueError('unrecognized CRQ unit listing')
            names.add(name)
    for name in sorted(names):
        state = run(['systemctl', '--user', 'show', '--property=ActiveState', '--value', name]).strip()
        if state not in {'inactive', 'failed'}:
            raise ValueError('refusing active or unknown unit: ' + name)


@contextlib.contextmanager
def tick_lock(root):
    state = root / 'apps/crq-python/state'
    state.mkdir(exist_ok=True)
    with (state / 'tick.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def root_check(root, overlay):
    if root.resolve() != Path(overlay['deploy_root']).resolve():
        raise ValueError('not the overlay deployment checkout')
    if git(root, 'rev-parse', '--show-toplevel') != str(root.resolve()):
        raise ValueError('deploy_root must be the full monorepo checkout')
    if git(root, 'rev-parse', '--abbrev-ref', 'HEAD') != 'HEAD':
        raise ValueError('deployment checkout must be detached')


def validate_unit_template(name, text):
    if Path(name).suffix in {'.service', '.path'} and '@CRQ_ROOT@' not in text:
        raise ValueError('unit lacks monorepo root placeholder: ' + name)


def render_units(root, output):
    templates = [(source, source.read_text()) for source in unit_files(root)]
    for source, text in templates:
        validate_unit_template(source.name, text)
    output.mkdir(parents=True, exist_ok=True)
    runner = str(host_path(str(root)) / 'apps/crq-python')
    paths = []
    for source, text in templates:
        text = text.replace('@CRQ_ROOT@', runner)
        if '@CRQ_ROOT@' in text:
            raise ValueError('unexpanded runner root')
        target = output / source.name
        atomic_bytes(target, text.encode())
        paths.append(str(target))
    return paths



def render_plists(root, output, overlay_path):
    output.mkdir(parents=True, exist_ok=True)
    replacements = {'@CRQ_ROOT@': str(root / 'apps/crq-python'),
                    '@OVERLAY@': str(Path(overlay_path).resolve()), '@HOME@': str(Path.home())}
    def replace(value):
        if isinstance(value, str):
            for key, item in replacements.items():
                value = value.replace(key, item)
            return value
        if isinstance(value, list):
            return [replace(v) for v in value]
        if isinstance(value, dict):
            return {k: replace(v) for k, v in value.items()}
        return value
    for source in (root / 'apps/crq-python/ops').glob('com.crq.*.plist'):
        value = replace(plistlib.loads(source.read_bytes()))
        atomic_bytes(output / source.name, plistlib.dumps(value))


def live_render(root, overlay, raw):
    root_check(root, overlay)
    with tick_lock(root):
        data = render(root, overlay)
        # Write the audit before mutation; failures leave no unrecorded config.
        record(root, overlay, raw, data, 'live-config')
        atomic_bytes(root / CONFIG, data)


def prepare(root, overlay, raw, output):
    root_check(root, overlay)
    inactive(root)
    with tick_lock(root):
        inactive(root)
        data = render(root, overlay)
        with tempfile.TemporaryDirectory(prefix='crq-units-') as temporary:
            paths = render_units(root, Path(temporary))
            run(['systemd-analyze', '--user', 'verify', *paths])
            record(root, overlay, raw, data, 'prepare', unit_sha256={Path(p).name: digest(Path(p).read_bytes()) for p in paths})
            output.mkdir(parents=True, exist_ok=True)
            for path in paths:
                atomic_bytes(output / Path(path).name, Path(path).read_bytes())
        atomic_bytes(root / CONFIG, data)
        atomic_bytes(root / 'apps/crq-python/state/runner-disabled', b'Prepared inert; owner approval required to start.\n')
    run(['systemctl', '--user', 'daemon-reload'])
    # Deliberately no start or enable here.


def verify_target(root, target, tag):
    if not re.fullmatch(r'[0-9a-f]{40}', target):
        raise ValueError('target must be a full commit SHA')
    if not re.fullmatch(r'crq-runner/[0-9]{8}-[0-9]+', tag):
        raise ValueError('runner annotated tag required')
    ref = 'refs/tags/' + tag
    if git(root, 'cat-file', '-t', ref) != 'tag' or git(root, 'rev-parse', ref + '^{commit}') != target:
        raise ValueError('annotated tag does not name target')
    git(root, 'merge-base', '--is-ancestor', target, 'refs/remotes/origin/main')
    git(root, 'merge-base', '--is-ancestor', POLICY_FLOOR, target)
    if git(root, 'ls-tree', '-r', '--name-only', target, 'apps/crq-python/state/'):
        raise ValueError('target must not track runner state')
    # Targets before import C have a different configuration/state contract.
    config = committed(root, target)
    if config['promotion']['merges_trigger'] != 1 or config['promotion']['dispatch_after_min'] != 0:
        raise ValueError('target predates the every-green-tip policy floor')
    if not git(root, 'ls-tree', target, 'apps/crq-python/ops/prepare-host.py'):
        raise ValueError('target lacks monorepo deploy helper')
    templates = git(root, 'ls-tree', '-r', '--name-only', target,
                    'apps/crq-python/ops/systemd/').splitlines()
    templates = [path for path in templates if Path(path).name.startswith('crq-')]
    if not templates:
        raise ValueError('target lacks CRQ unit templates')
    for path in templates:
        validate_unit_template(Path(path).name, git(root, 'show', f'{target}:{path}'))


def switch(root, overlay, raw, target, tag):
    root_check(root, overlay)
    verify_target(root, target, tag)
    # Validate the destination config before changing anything.
    destination = render(root, overlay, target)
    inactive(root)
    with tick_lock(root):
        inactive(root)
        current = render(root, overlay)
        drift_check(current, root / CONFIG)
        changes = git(root, 'status', '--porcelain', '--untracked-files=all').splitlines()
        if any(line != ' M ' + CONFIG for line in changes):
            raise ValueError('checkout has changes other than rendered config')
        previous = git(root, 'rev-parse', 'HEAD')
        record(root, overlay, raw, current, 'switch-before', target=target, tag=tag)
        git(root, 'restore', '--', CONFIG)
        if git(root, 'status', '--porcelain', '--untracked-files=all'):
            raise ValueError('checkout not clean after config restore')
        git(root, 'checkout', '--detach', target)
        # Same tick lock spans drift check, checkout, render and audit.
        record(root, overlay, raw, destination, 'switch-render', previous_sha=previous, tag=tag)
        atomic_bytes(root / CONFIG, destination)
        if git(root, 'status', '--porcelain', '--untracked-files=all') != ' M ' + CONFIG:
            raise ValueError('post-switch status must contain only rendered config')
    return target


def legacy_check(root, overlay, raw):
    """Read-only first-deploy fence: accepted source + host overrides + 5→1 only."""
    if git(root, 'rev-parse', 'HEAD') != LEGACY_SHA:
        raise ValueError('legacy checkout HEAD must match the accepted baseline')
    config = apply(committed(root, LEGACY_SHA, 'config.json'), overlay)
    if config['promotion']['merges_trigger'] != 5:
        raise ValueError('unexpected accepted baseline policy')
    config['promotion']['merges_trigger'] = 1
    data = encode(config)
    drift_check(data, root / 'config.json')
    # No live file/marker/lock writes on the old checkout, including no render.
    record(root, overlay, raw, data, 'legacy-drift-check', baseline_sha=LEGACY_SHA)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--overlay', required=True, type=Path)
    sub = parser.add_subparsers(dest='operation', required=True)
    sub.add_parser('live-config')
    preparation = sub.add_parser('prepare')
    preparation.add_argument('--units-output', required=True, type=Path)
    preparation.add_argument('--tag', required=True)
    preview = sub.add_parser('preview')
    preview.add_argument('--output', required=True, type=Path)
    switching = sub.add_parser('switch')
    switching.add_argument('--sha', required=True)
    switching.add_argument('--tag', required=True)
    legacy = sub.add_parser('legacy-check')
    legacy.add_argument('--legacy-root', required=True, type=Path)
    if argv is None:
        import sys
        argv = sys.argv[1:]
    args = parser.parse_args(['live-config' if arg == '--live-config' else arg for arg in argv])
    overlay, raw = load_overlay(args.overlay)
    root = Path(overlay['deploy_root'])
    if args.operation == 'legacy-check':
        legacy_check(args.legacy_root, overlay, raw)
    elif args.operation == 'switch':
        switch(root, overlay, raw, args.sha, args.tag)
    elif args.operation == 'prepare':
        require_outside_git(args.units_output)
        if not outside(args.units_output, root):
            raise ValueError('rendered units must be outside checkout')
        verify_target(root, git(root, 'rev-parse', 'HEAD'), args.tag)
        prepare(root, overlay, raw, args.units_output)
    elif args.operation == 'preview':
        root_check(root, overlay)
        require_outside_git(args.output)
        if not outside(args.output, root):
            raise ValueError('preview output must be outside checkout')
        data = render(root, overlay)
        record(root, overlay, raw, data, 'preview')
        atomic_bytes(args.output / 'config.json', data)
        render_units(root, args.output / 'systemd')
        render_plists(root, args.output / 'launchd', args.overlay)
    else:
        live_render(root, overlay, raw)
    print('completed ' + args.operation + '; no units started')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        # CalledProcessError text only contains argv, not private captured output.
        raise SystemExit(str(exc)) from None
