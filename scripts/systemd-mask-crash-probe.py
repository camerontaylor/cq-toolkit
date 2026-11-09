#!/usr/bin/env python3
"""Synthetic durable-intent crash/recovery experiment on a disposable VM user."""
import base64
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile

root, user, uid, phase = sys.argv[1:]
root = Path(root)
unit_dir = root / '.config/systemd/user'
unit = unit_dir / 'probe.service'
journal = root / 'state/intent.json'
env = dict(os.environ, XDG_RUNTIME_DIR='/run/user/' + uid,
           DBUS_SESSION_BUS_ADDRESS='unix:path=/run/user/' + uid + '/bus')


def ctl(*args):
    return subprocess.run(['runuser', '-u', user, '--', 'systemctl', '--user', *args],
                          env=env, check=True, stdout=subprocess.DEVNULL)


def durable(path, data):
    fd, name = tempfile.mkstemp(dir=path.parent, prefix='.probe-')
    with os.fdopen(fd, 'wb') as out:
        out.write(data)
        out.flush()
        os.fsync(out.fileno())
    if path == unit:
        os.chmod(name, 0o644)
    os.replace(name, path)
    fd = os.open(path.parent, os.O_DIRECTORY)
    os.fsync(fd)
    os.close(fd)


def mask():
    temp = unit_dir / '.crash-mask'
    temp.unlink(missing_ok=True)
    temp.symlink_to('/dev/null')
    os.replace(temp, unit)
    fd = os.open(unit_dir, os.O_DIRECTORY)
    os.fsync(fd)
    os.close(fd)


def kill_at(name):
    if phase == name:
        os.kill(os.getpid(), signal.SIGKILL)


if phase == 'recover':
    record = json.loads(journal.read_text())
    mask()
    ctl('daemon-reload')
    ctl('stop', 'probe.path', 'probe.timer', 'probe.service')
    durable(unit, base64.b64decode(record['unit']))
    ctl('daemon-reload')
    if record['path_active']:
        ctl('start', 'probe.path')
    if record['timer_active']:
        ctl('start', 'probe.timer')
    print('RECOVERED', flush=True)
else:
    record = {'unit': base64.b64encode(unit.read_bytes()).decode(),
              'path_active': subprocess.run(['runuser', '-u', user, '--', 'systemctl', '--user', 'is-active', '--quiet', 'probe.path'], env=env).returncode == 0,
              'timer_active': subprocess.run(['runuser', '-u', user, '--', 'systemctl', '--user', 'is-active', '--quiet', 'probe.timer'], env=env).returncode == 0}
    durable(journal, json.dumps(record).encode())
    kill_at('intent')
    mask()
    kill_at('mask')
    ctl('daemon-reload')
    kill_at('reload')
    ctl('stop', 'probe.path', 'probe.timer', 'probe.service')
    kill_at('drain')
    durable(unit, base64.b64decode(record['unit']))
    kill_at('restore')
    ctl('daemon-reload')
    kill_at('unmask')
    raise SystemExit('unknown phase')
