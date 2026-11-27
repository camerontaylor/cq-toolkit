#!/usr/bin/env python3
"""Read-only queue-host summary mirror for existing worker-host fleet readers. No tick."""
import argparse
import datetime as dt
import importlib.util
import shlex
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

def source_settings(path):
    spec = importlib.util.spec_from_file_location('crq_host', Path(__file__).with_name('prepare-host.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    overlay, _ = module.load_overlay(path)
    return overlay['fleet_reader']


def _machine_error(kind, subcommand, message, exit_code, machine=True):
    """One JSON error artifact on stdout in every mode (doctrine I1).

    Machine mode keeps stderr empty; otherwise a one-line narration goes to
    stderr. The exit code is unchanged: 2 for usage, 1 for operation failure.
    """
    artifact = {'error': {'kind': kind, 'subcommand': subcommand,
                          'message': message, 'exitCode': exit_code}}
    sys.stdout.write(json.dumps(artifact, sort_keys=True, indent=2) + '\n')
    if not machine:
        sys.stderr.write(subcommand + ': ' + message + '\n')
    raise SystemExit(exit_code)


class _MachineArgumentParser(argparse.ArgumentParser):
    """Argument parser whose usage errors honor machine mode (doctrine I1).

    `--json` is detected in argv before parsing. A usage error always writes
    one JSON error artifact to stdout and exits 2; narration goes to stderr
    only outside machine mode. In machine mode `--help` prints one JSON help
    artifact instead of argparse's plain text.
    """

    def __init__(self, *args, machine=False, subcommand=None, **kwargs):
        # Abbreviations are off: argparse would otherwise accept `--js` as
        # --json while the literal argv check below missed it, so the parse
        # and the output mode could disagree.
        kwargs.setdefault('allow_abbrev', False)
        super().__init__(*args, **kwargs)
        self._machine = machine
        self._subcommand = subcommand

    def error(self, message):
        _machine_error('usage', self._subcommand, message, 2, self._machine)

    def print_help(self, file=None):
        if not self._machine:
            return super().print_help(file)
        artifact = {'help': {'subcommand': self._subcommand,
                             'usage': self.format_usage().strip(),
                             'description': self.description}}
        (file or sys.stdout).write(json.dumps(artifact, sort_keys=True, indent=2) + '\n')


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]
    # Machine mode is needed before the parse, because a usage error is the
    # one failure that never produces a namespace to read --json from.
    machine = '--json' in argv
    parser = _MachineArgumentParser(description=__doc__, machine=machine,
                                    subcommand='fleet-reader')
    parser.add_argument('--json', action='store_true')
    parser.add_argument("--overlay", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        settings = source_settings(args.overlay)
        # SSH transport only reads the allow-listed fleet summary, never queue,
        # secrets, arbitrary commands, reviews, gates or model endpoints.
        result = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
                                 settings['ssh_host'], 'cat -- ' + shlex.quote(settings['source'])], capture_output=True, text=True, timeout=30)
        if result.returncode:
            raise RuntimeError('queue-host summary unavailable; previous snapshot remains stale')
        summary = json.loads(result.stdout)
        if not isinstance(summary, dict) or not summary.get('last_tick') \
                or not isinstance(summary['last_tick'], str) or summary.get('schema_version') != 2:
            raise ValueError('queue-host has not published a valid completed tick summary')
        dt.datetime.fromisoformat(summary['last_tick'].replace('Z', '+00:00'))
        summary['source_host'] = settings['ssh_host']
        summary['source_path'] = settings['source']
        # Preserve source last_tick/generated_at; mirroring never claims a new tick.
        for directory in (Path.home() / 'Library/Application Support/crq',
                          Path(os.environ.get('XDG_STATE_HOME', str(Path.home() / '.local/state'))) / 'crq'):
            directory.mkdir(parents=True, exist_ok=True)
            fd, name = tempfile.mkstemp(prefix='.summary-', dir=directory)
            try:
                with os.fdopen(fd, 'w') as out:
                    json.dump(summary, out, separators=(',', ':'))
                    out.write('\n')
                    out.flush()
                    os.fsync(out.fileno())
                os.replace(name, directory / 'summary.json')
            finally:
                Path(name).unlink(missing_ok=True)
    except (RuntimeError, ValueError, OSError, KeyError,
            subprocess.TimeoutExpired) as exc:
        _machine_error('failed', 'fleet-reader', str(exc)[:400], 1, machine)
    print(json.dumps(summary, sort_keys=True, indent=2))
    if not machine:
        print('queue-host summary mirrored; completed tick ' + summary['last_tick'], file=sys.stderr)


if __name__ == '__main__':
    main()
