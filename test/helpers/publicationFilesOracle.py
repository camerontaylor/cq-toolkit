"""Differential oracle for the repair publication file seams: the journal, patch,
fix-PR body and queue writes of apps/crq-python/repair_tick.py against an isolated
temporary state directory.

Test tooling only. Usage: python3 -I publicationFilesOracle.py <apps/crq-python dir>
Reads {"cases": [case]} on stdin and writes {"results": [result]}. A case is
{"op": "read_journal" | "write_journal" | "write_patch" | "write_fix_pr" | "save_queue",
 "files": {"<path under state/>": text | {"hex": "<bytes>"} | {"dir": true}},
 "modes": {"<path>": octal int}, "job": "<job id>", "value": "<JSON text>", "text": "<str>"}.
A result is {"ok": value, "files": {path: [latin-1 bytes, mode]}} or
{"error": "<exception class>", "files": ...}. No network, git or child process.

`atomic` is the real `crq_repair.atomic` (what `repair_tick.atomic` and `c.save_queue`
call). The read and the two `write_text` calls are the one-liners of
`repair_tick.publish` (665-669, 712-714) and `finalize_publication` (849-850), which
are inline there and so cannot be imported.
"""
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, sys.argv[1])
from crq_repair import atomic  # noqa: E402


def lay_out(state, case):
    for rel, content in case.get('files', {}).items():
        path = state / rel
        if isinstance(content, dict) and content.get('dir'):
            path.mkdir(parents=True, exist_ok=True)
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, dict):
            path.write_bytes(bytes.fromhex(content['hex']))
        else:
            path.write_text(content)
    for rel, mode in case.get('modes', {}).items():
        os.chmod(state / rel, mode)


def snapshot(state):
    out = {}
    for path in sorted(state.rglob('*')):
        if path.is_file():
            try:
                content = path.read_bytes().decode('latin-1')
            except PermissionError:
                content = '<unreadable>'
            out[str(path.relative_to(state))] = [content, path.stat().st_mode & 0o777]
    return out


def run(state, case):
    op = case['op']
    job = case.get('job', 'crq-job')
    repair = state / 'repair' / job
    if op == 'read_journal':
        journal = repair / 'publication.json'
        if not journal.exists():
            return None
        publication = json.loads(journal.read_text())
        if not isinstance(publication, dict):
            publication['head']  # recover_publication's first subscript: TypeError
        return json.dumps(publication, indent=2)
    if op == 'write_journal':
        atomic(repair / 'publication.json', json.loads(case['value']))
    elif op == 'write_patch':
        (repair / 'publication.patch').write_text(case['text'])
    elif op == 'write_fix_pr':
        (repair / 'fix-pr.md').write_text(case['text'])
    elif op == 'save_queue':
        atomic(state / 'queue.json', json.loads(case['value']))
    else:
        raise SystemExit('unknown op ' + op)
    return None


def main():
    cases = json.load(sys.stdin)['cases']
    results = []
    for case in cases:
        with tempfile.TemporaryDirectory(prefix='crq-publication-oracle-') as tmp:
            state = Path(tmp) / 'state'
            state.mkdir()
            lay_out(state, case)
            try:
                result = {'ok': run(state, case)}
            except Exception as exc:  # noqa: BLE001 - the class name is the result
                result = {'error': type(exc).__name__}
            result['files'] = snapshot(state)
            results.append(result)
    json.dump({'results': results}, sys.stdout)


main()
