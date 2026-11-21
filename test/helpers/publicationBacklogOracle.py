"""Differential oracle for the fix-PR publication flow over one shared backlog: the
real `repair_tick.refresh_fix_pr_backlog`, `publish` (initial), `recover_publication`
and `finalize_publication` (apps/crq-python) driven through several ticks.

Test tooling only. Usage: python3 -I publicationBacklogOracle.py <apps/crq-python dir>
Reads {"cases": [case]} on stdin and writes {"results": [result]}.

`c.new_item` only logs the item id: enrollment is not exercised here (see
publicationEnrollOracle.py).

Everything is a fixture. There is no Git, forge, network, provider, child process or
queue host: `c.git`, `wt_git`, `verify`, `hack_detector`, `c.secret_scan`,
`c.make_worktree`, `c.gh_json` and `c.run` are scripted over an in-memory
world (remote refs and PR rows). The only disk is a tmp state tree holding
`events.jsonl`, the journals (`crq_repair.atomic`), the patch and body files and
`queue.json`.

A case is

  {"queue": {"items": [..]}, "events": str | null, "external": [headRefName],
   "pubs": {"<name>": {"item": index, "run": str}},
   "ticks": [{"gh_open": "ok" | "fail", "refresh": bool,
              "external_open": [..], "external_close": [..], "close": [branch],
              "create": {"<name>": "ok" | "runtime" | "timeout-landed" | "timeout-lost"},
              "push_fail": [name], "publish": [name]}]}

`pubs[name].item` indexes `queue.items`; the run record is that item's
`repair_runs[run]`, as in the runtime. A tick runs `reset_fix_pr_backlog` (what
`crq.tick` does before its harvest pass), the refresh, each publish in order (an
exception ends only that publish, as harvest records `publish_failed`), then the
reset again.

A result is {"log": [..], "q": <final queue>, "files": {"<path under state/>": text}}.
The ordered `log` holds every effect and every observed backlog view; `at` stamps are
dropped because the clock is real.
"""
import copy
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, sys.argv[1])
import repair_tick  # noqa: E402
from crq_repair import atomic  # noqa: E402

APPS = Path(sys.argv[1]).resolve()


def family(exc):
    for base in (OSError, ValueError, KeyError, TypeError, AttributeError, RuntimeError):
        if isinstance(exc, base):
            return base.__name__
    return type(exc).__name__


def scenario(case):
    log = []
    world = {'prs': {}, 'remote': {}, 'external': list(case.get('external', [])), 'n': 0}
    current = {'run': None, 'name': None, 'tick': {}, 'picked': False}
    q = case['queue']

    def open_rows():
        rows = [{'headRefName': b} for b in world['external']]
        for branch, prs in world['prs'].items():
            rows.extend({'headRefName': branch} for pr in prs if pr['state'] == 'OPEN')
        return rows

    def gh_json(args):
        if '--head' in args:
            branch = args[args.index('--head') + 1]
            log.append(['list', branch])
            return copy.deepcopy(world['prs'].get(branch, []))
        log.append(['list-open'])
        if current['tick'].get('gh_open') == 'fail':
            raise RuntimeError('gh pr list failed')
        return open_rows()

    def git(*args, cwd=None):
        if args[:2] == ('rev-parse', repair_tick.DEFAULT_REF):
            return 'target-main'
        if args[0] == 'update-ref':
            log.append(['update-ref', args[1], args[2]])
            return ''
        if args[0] == 'ls-remote':
            branch = args[3][len('refs/heads/'):]
            log.append(['ls-remote', branch])
            return f"{world['remote'][branch]}\trefs/heads/{branch}" if branch in world['remote'] else ''
        if args[0] == 'push':
            lease, refspec = args[2], args[3]
            branch_expected = lease[len('--force-with-lease=refs/heads/'):]
            branch, expected = branch_expected.split(':', 1)
            src = refspec.split(':', 1)[0]
            sha = 'head-' + current['run'] if src == 'HEAD' else src
            log.append(['push', branch, expected, sha])
            if current['name'] in current['tick'].get('push_fail', []):
                raise RuntimeError('git push failed: network')
            world['remote'][branch] = sha
            return ''
        raise AssertionError(args)

    def wt_git(wt, *args):
        if args == ('rev-parse', 'HEAD'):
            return 'head-' + current['run'] if current['picked'] else 'base-' + current['run']
        if args[0] == 'cherry-pick':
            current['picked'] = True
            return ''
        if args[0] == 'rev-list':
            return 'claim-' + current['run']
        if args[0] == 'diff':
            return 'diff-' + current['run']
        raise AssertionError(args)

    def run(argv):
        branch = argv[argv.index('--head') + 1]
        mode = current['tick'].get('create', {}).get(current['name'], 'ok')
        log.append(['create', branch, mode])
        if mode == 'runtime':
            raise RuntimeError('gh pr create failed')
        if mode != 'timeout-lost':
            world['n'] += 1
            world['prs'].setdefault(branch, []).append(
                {'number': 100 + world['n'], 'url': 'u' + str(world['n']), 'state': 'OPEN',
                 'headRefOid': 'head-' + current['run']})
        if mode.startswith('timeout'):
            raise subprocess.TimeoutExpired(argv, 600)

    with tempfile.TemporaryDirectory(prefix='crq-backlog-oracle-') as tmp:
        state = Path(tmp).resolve() / 'root' / 'state'
        state.mkdir(parents=True)
        if case.get('events') is not None:
            (state / 'events.jsonl').write_text(case['events'])
        for spec in case['pubs'].values():
            item = q['items'][spec['item']]
            job = item['repair_runs'][spec['run']]['jobs'][0]
            (state / 'repair' / job).mkdir(parents=True, exist_ok=True)

        def save_queue(queue):
            log.append(['save', copy.deepcopy(queue)])
            atomic(state / 'queue.json', queue)

        def pr_info(pr):
            log.append(['pr-info', pr])
            return {'state': 'OPEN', 'headRefName': 'fix-branch', 'headRefOid': 'target-open'}

        def is_ancestor(older, newer):
            log.append(['ancestor', older, newer])
            return True

        def secret_scan(target, head, path):
            log.append(['secret-scan', target, head])
            return True, None

        def make_worktree(name, sha):
            log.append(['worktree', name, sha])
            return '/wt/' + name, 'wtb-' + name

        c = SimpleNamespace(
            STATE=state, EVENTS=state / 'events.jsonl', ROOT=APPS, REPO='o/r',
            CONFIG={'repair': {'cq_bin': 'cq'}}, iso=lambda: 'now', gh_json=gh_json, git=git,
            run=run, pr_info=pr_info, is_ancestor=is_ancestor, secret_scan=secret_scan,
            make_worktree=make_worktree,
            remove_worktree=lambda wt, branch: log.append(['remove-worktree']),
            save_queue=save_queue,
            new_item=lambda queue, old, flag, **fields: log.append(['new-item', fields['id']]))

        def verify(wt, before, claims, job):
            log.append(['verify', before, list(claims), job])

        def hack(cq_bin, diff, wt):
            log.append(['hack', diff])

        patches = [
            mock.patch.object(repair_tick, 'wt_git', wt_git),
            mock.patch.object(repair_tick, 'verify', verify),
            mock.patch.object(repair_tick, 'hack_detector', hack),
            mock.patch.object(repair_tick, 'repair_provenance', lambda *a: []),
        ]
        for patch in patches:
            patch.start()
        try:
            for index, tick in enumerate(case['ticks']):
                current['tick'] = tick
                log.append(['tick', index])
                repair_tick.reset_fix_pr_backlog()
                for branch in tick.get('close', []):
                    for pr in world['prs'].get(branch, []):
                        pr['state'] = 'MERGED'
                world['external'] = [b for b in world['external'] if b not in tick.get('external_close', [])]
                world['external'].extend(tick.get('external_open', []))
                if tick.get('refresh', True):
                    view = repair_tick.refresh_fix_pr_backlog(c, q)
                    log.append(['refresh', None if view is None else dict(view)])
                    file = state / 'repair' / 'fix-pr-backlog.json'
                    doc = json.loads(file.read_text()) if file.exists() else None
                    if doc is not None:
                        doc.pop('at')
                    log.append(['file', doc])
                for name in tick['publish']:
                    spec = case['pubs'][name]
                    item = q['items'][spec['item']]
                    run_id = spec['run']
                    record = item['repair_runs'][run_id]
                    fixed = [{'job': record['jobs'][0], 'verdict': 'FIXED', 'reason': 'ok',
                              'commits': ['src-' + run_id]}]
                    current.update(run=run_id, name=name, picked=False)
                    log.append(['publish', name])
                    error = None
                    try:
                        repair_tick.publish(c, q, item, run_id, record, fixed)
                    except Exception as exc:  # noqa: BLE001 - the exception family is the result
                        error = family(exc)
                    log.append(['result', name, error, record.get('state'),
                                dict(repair_tick.TICK_BACKLOG)])
                repair_tick.reset_fix_pr_backlog()
                log.append(['reset', dict(repair_tick.TICK_BACKLOG)])
        finally:
            for patch in patches:
                patch.stop()
        files = {}
        for path in sorted(state.rglob('*')):
            if path.is_file() and path.name in ('publication.json', 'queue.json', 'fix-pr-backlog.json'):
                text = path.read_text()
                if path.name == 'fix-pr-backlog.json':
                    doc = json.loads(text)
                    doc.pop('at')
                    text = json.dumps(doc, separators=(',', ':'))
                files[str(path.relative_to(state))] = text
        return {'log': log, 'q': q, 'files': files}


def main():
    json.dump({'results': [scenario(case) for case in json.load(sys.stdin)['cases']]}, sys.stdout)


main()
