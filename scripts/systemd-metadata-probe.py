#!/usr/bin/env python3
"""Bounded synthetic systemd-user metadata and recovery interruption probe."""
import base64
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile


def ctl(*args):
    return subprocess.run(['systemctl', '--user', *args], check=True, timeout=20)


def atomic(path, data, mode=0o600):
    fd, temp = tempfile.mkstemp(prefix='.metadata-probe-', dir=path.parent)
    with os.fdopen(fd, 'wb') as out:
        out.write(data)
        os.fchmod(out.fileno(), mode)
        out.flush()
        os.fsync(out.fileno())
    os.replace(temp, path)
    syncdir(path.parent)


def syncdir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    os.fsync(fd)
    os.close(fd)


def mask(path):
    temp = path.with_name(path.name + '.tmp')
    temp.unlink(missing_ok=True)
    temp.symlink_to('/dev/null')
    os.replace(temp, path)
    syncdir(path.parent)


def recover(journal, phase):
    rec = json.loads(journal.read_text())
    service, backing = Path(rec['service']), Path(rec['backing'])
    def die(name):
        if phase == name:
            os.kill(os.getpid(), signal.SIGKILL)
    mask(service)
    die('mask')
    ctl('daemon-reload')
    die('reload-mask')
    ctl('stop', rec['timer'], rec['unit'])
    die('stop')
    atomic(backing, base64.b64decode(rec['bytes']), rec['mode'])
    os.chown(backing, rec['uid'], rec['gid'])
    temp = service.with_name(service.name + '.tmp')
    temp.unlink(missing_ok=True)
    temp.symlink_to(rec['target'])
    os.replace(temp, service)
    syncdir(service.parent)
    die('restore')
    ctl('daemon-reload')
    die('reload-restore')
    ctl('start', rec['timer'])
    die('activation')


if len(sys.argv) > 1:
    recover(Path(sys.argv[1]), sys.argv[2])
    sys.exit(0)

try:
    subprocess.run(['systemctl', '--user', 'show-environment'], check=True,
                   timeout=20, stdout=subprocess.DEVNULL)
except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
    print('UNSUPPORTED: booted CI user manager unavailable', flush=True)
    sys.exit(1)

name = 'cq-metadata-' + str(os.getpid())
unit, timer = name + '.service', name + '.timer'
unit_dir = Path(os.environ.get('XDG_CONFIG_HOME', str(Path.home() / '.config'))) / 'systemd/user'
unit_dir.mkdir(parents=True, exist_ok=True)
service, timer_file = unit_dir / unit, unit_dir / timer
assert not service.exists() and not service.is_symlink() and not timer_file.exists()
with tempfile.TemporaryDirectory(prefix=name + '-') as work:
    work = Path(work)
    backing, journal = work / 'service', work / 'intent.json'
    content = b'[Service]\nType=oneshot\nExecStart=/bin/true\n'
    atomic(backing, content, 0o640)
    service.symlink_to(backing)
    atomic(timer_file, ('[Timer]\nOnActiveSec=1h\nUnit=' + unit + '\n[Install]\nWantedBy=timers.target\n').encode(), 0o644)
    try:
        ctl('daemon-reload')
        ctl('enable', timer)
        ctl('start', timer)
        wants = unit_dir / 'timers.target.wants' / timer
        link = os.readlink(wants)
        before = backing.stat()
        link_stat = service.lstat()
        rec = {'service': str(service), 'backing': str(backing), 'unit': unit, 'timer': timer,
               'bytes': base64.b64encode(content).decode(), 'mode': stat.S_IMODE(before.st_mode),
               'uid': before.st_uid, 'gid': before.st_gid, 'target': os.readlink(service)}
        atomic(journal, json.dumps(rec).encode())
        for boundary in ('mask', 'reload-mask', 'stop', 'restore', 'reload-restore', 'activation'):
            child = subprocess.run([sys.executable, __file__, str(journal), boundary])
            assert child.returncode == -signal.SIGKILL, (boundary, child.returncode)
            for _ in range(2):
                recover(journal, '')
                actual = backing.stat()
                assert backing.read_bytes() == content
                assert (stat.S_IMODE(actual.st_mode), actual.st_uid, actual.st_gid) == (rec['mode'], rec['uid'], rec['gid'])
                assert service.is_symlink() and os.readlink(service) == rec['target']
                assert (service.lstat().st_uid, service.lstat().st_gid) == (link_stat.st_uid, link_stat.st_gid)
                assert wants.is_symlink() and os.readlink(wants) == link
                ctl('is-active', '--quiet', timer)
                ctl('is-enabled', '--quiet', timer)
            print('PASS interrupted recovery:', boundary, flush=True)
        print('PASS original bytes/mode/owner and service/enablement symlinks', flush=True)
    finally:
        subprocess.run(['systemctl', '--user', 'stop', timer, unit], timeout=20, check=False)
        subprocess.run(['systemctl', '--user', 'disable', timer], timeout=20, check=False)
        service.unlink(missing_ok=True)
        timer_file.unlink(missing_ok=True)
        subprocess.run(['systemctl', '--user', 'daemon-reload'], timeout=20, check=False)
