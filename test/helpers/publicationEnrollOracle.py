"""Differential oracle for fix-PR enrollment: the real `crq.new_item` and the real
`repair_tick.finalize_publication` (apps/crq-python) over a throwaway state tree.

Test tooling only. Usage: python3 -I publicationEnrollOracle.py <apps/crq-python dir>
Reads {"cases": [case]} on stdin and writes {"results": [result]}. Every effect is
a fixture: `iso` is a constant, `event` appends to a list (or raises `OSError`),
`gh_json` serves canned rows, `run` records the `gh pr create` argv and never
spawns, `save_queue` records a snapshot. No network, Git, forge, provider, child
process or queue file; the only disk is a tmp state tree for the fix-PR body, the
journal and the provenance inbox.

A case is one of

  {"op": "new_item", "q": <queue>, "fields": {..}, "now": str, "event_fails": bool}
  {"op": "finalize", "q": <queue>, "item": {..}, "run": str, "record": {..},
   "publication": {..}, "now": str, "repo": str, "fix_pr_cycles": int | null,
   "listed": [[row]], "create": "ok" | "runtime" | "timeout",
   "backlog": [open, limit] | null, "event_fails": bool,
   "files": {"<path under state/>": text}}

`listed` is the list of `gh pr list` results in call order, the last one repeating.

A result is {"error": null | "<exception family>", "out": {...}}. `out` always
holds the final `q` (and for "finalize" `item`, `record`, `publication`), because
Python mutates them in place even when it then raises. `log` is the ordered effect log:
["list", branch] | ["create", {base, head, title}] | ["save", <queue snapshot>] |
["event", id, reason]; `body` and `journal` are what the state tree holds after.
"""
import copy
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, sys.argv[1])
import crq  # noqa: E402
import repair_tick  # noqa: E402


def family(exc):
    for base in (OSError, ValueError, KeyError, TypeError, AttributeError, RuntimeError):
        if isinstance(exc, base):
            return base.__name__
    return type(exc).__name__


def patched(now, log, event_fails):
    def event(kind, **data):
        assert kind == 'enrolled'
        log.append(['event', data['item'], data['reason']])
        if event_fails:
            raise OSError('events.jsonl is not writable')

    crq.iso = lambda t=None: now
    crq.event = event


def new_item(case):
    log, q = [], case['q']
    patched(case['now'], log, case.get('event_fails', False))
    try:
        crq.new_item(q, [], False, **case['fields'])
        return {'error': None, 'out': {'q': q, 'log': log}}
    except Exception as exc:  # noqa: BLE001 - the exception family is the result
        return {'error': family(exc), 'out': {'q': q, 'log': log}}


def finalize(case):
    log, q = [], case['q']
    item, record, publication = case['item'], case['record'], case['publication']
    patched(case['now'], log, case.get('event_fails', False))
    listed, calls = case['listed'], [0]

    def gh_json(args):
        branch = args[args.index('--head') + 1]
        log.append(['list', branch])
        rows = listed[min(calls[0], len(listed) - 1)]
        calls[0] += 1
        return copy.deepcopy(rows)

    def run(argv):
        log.append(['create', {'base': argv[argv.index('--base') + 1], 'head': argv[argv.index('--head') + 1],
                               'title': argv[argv.index('--title') + 1]}])
        if case['create'] == 'runtime':
            raise RuntimeError('gh pr create failed')
        if case['create'] == 'timeout':
            raise subprocess.TimeoutExpired(argv, 1)

    with tempfile.TemporaryDirectory(prefix='crq-enroll-oracle-') as tmp:
        state = Path(tmp).resolve() / 'root' / 'state'
        state.mkdir(parents=True)
        for rel, text in case.get('files', {}).items():
            (state / rel).parent.mkdir(parents=True, exist_ok=True)
            (state / rel).write_text(text)
        (state / 'repair' / record['jobs'][0]).mkdir(parents=True, exist_ok=True)
        repair = {} if case['fix_pr_cycles'] is None else {'fix_pr_cycles': case['fix_pr_cycles']}
        c = SimpleNamespace(
            STATE=state, REPO=case['repo'], CONFIG={'repair': repair}, iso=lambda: case['now'],
            gh_json=gh_json, run=run, new_item=crq.new_item,
            save_queue=lambda queue: log.append(['save', copy.deepcopy(queue)]))
        backlog = case.get('backlog')
        repair_tick.TICK_BACKLOG.update(open=backlog[0] if backlog else None, limit=backlog[1] if backlog else None)
        out = {'q': q, 'item': item, 'record': record, 'publication': publication, 'log': log}
        error = None
        try:
            repair_tick.finalize_publication(c, q, item, case['run'], record, publication)
        except Exception as exc:  # noqa: BLE001 - the exception family is the result
            error = family(exc)
        out['backlog'] = dict(repair_tick.TICK_BACKLOG)
        job_dir = state / 'repair' / record['jobs'][0]
        body, journal = job_dir / 'fix-pr.md', job_dir / 'publication.json'
        out['body'] = body.read_text() if body.exists() else None
        out['journal'] = json.loads(journal.read_text()) if journal.exists() else None
        return {'error': error, 'out': out}


def main():
    results = []
    for case in json.load(sys.stdin)['cases']:
        results.append(new_item(case) if case['op'] == 'new_item' else finalize(case))
    json.dump({'results': results}, sys.stdout)


main()
