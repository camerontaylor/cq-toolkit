"""Differential oracle for the composed S6 repair-harvest shadow: the real
`repair_tick.harvest` driving the real `publish`, `recover_publication`,
`finalize_publication`, `crq.new_item` and `crq_repair.retain.cleanup_harvested`
(apps/crq-python) over a fixed synthetic world, restarted between ticks.

Test tooling only. Usage: python3 -I repairHarvestShadowOracle.py <apps/crq-python dir>
Reads {"root": <laid-out tmp tree>, "spec": <spec>[, "segment": {"ticks": [..], "offset": n}]}
on stdin and writes the outcome.

Everything effectful is a fixture and nothing leaves the process:

* Git, `wt_git`, `verify`, `hack_detector`, `secret_scan`, `make_worktree`,
  `gh_json`, `pr_info` and `run` (the `gh pr create` argv) are scripted over an
  in-memory world: remote refs and PR rows. A push moves a ref in that dict only.
* `retain.command` and `retain.git` are replaced: `git status` and `rev-parse`
  are answered from the fixture, and `git worktree remove` is only RECORDED. A
  removal adds the tree to an in-memory `removed` set that a `Path` subclass
  reports as not-a-directory; no directory is deleted and a restart keeps the set.
* `finding_inbox`, `mark_finding_outcome` and `require_canonical_delivery` are
  recording stubs (as in repairHarvest.test.ts); `crq.iso` and `crq.event` are
  constants and a recorder. There is no network, provider, queue host or live data.

The only disk is `root`, a throwaway tree. TS lays out the inputs the code under
test reads (state files, result and inbox files, retained snapshots, empty
worktree directories); the oracle writes the journal, patch, fix-PR body and
`queue.json` into it through the real writers.

By default a restart is an in-memory queue JSON round trip plus
`reset_fix_pr_backlog()`, within the same process: it does NOT re-read
`state/queue.json`. The world (remote refs, PRs, removed trees, files) persists.
What it exercises from disk is the publication journal
(`state/repair/<job>/publication.json`) that `recover_publication` reads back,
and the result/inbox/snapshot files.

With a "segment" in the payload this process is one durable segment of a run
whose restarts are real process boundaries: the queue is reloaded from
`state/queue.json` with the real `crq.load_queue` (after the first tick's files
are laid down), and the in-memory world (remote refs, PRs, removed trees, the
PR counter) is read from and written back to `root/world.json`, a scratch file
outside `state/`. The caller runs one process per segment and concatenates the
outcomes. A tick's "save_fail": N makes the N-th `save_queue` made through the harvest
effect seam raise OSError before anything is written; the durable tick-end write
below is not counted. A live durable tick also does what `crq.tick` does around
`harvest`: an exception is caught into `item['last_error'] = 'repair harvest
failed: ' + str(exc)[:300]` and the queue is saved at the end of the tick. A dry
durable tick does not call `harvest` at all and saves nothing (`crq.tick(dry=True)`
does neither); non-durable ticks still call `harvest(dry=True)` directly. A tick's "crash": true
is the process dying right after `harvest`, so neither happens (it must be the
last tick of its segment).

Spec: {"item": {..}, "extra": [{..}], "ticks": [{"restart": bool, "files": {rel: json|str},
 "create": "ok"|"runtime"|"timeout-landed"|"timeout-lost", "push_fail": bool,
 "outcome": {job: "<directive>"}, "stale": {job: "<directive>"},
 "head_error": str|null, "dry": bool, "save_fail": int, "crash": bool}],
 "remote": {branch: sha}, "prs": {branch: [row]}, "pr_info": row|null,
 "trees": {name: {"head": sha, "status": str}}, "ancestor": bool}

The result is {"log": [..], "ticks": [{"messages"|"error", "queue", "files"}],
"files": {..}, "removed": [..]}; the ordered `log` holds every effect. `files`
(journal, patch, body, `queue.json`) is snapshotted after every tick and once
more at the end.
"""
import builtins
import copy
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, sys.argv[1])
import crq  # noqa: E402
import crq_repair  # noqa: E402
import crq_repair.retain as retain  # noqa: E402
import repair_tick  # noqa: E402


def family(exc):
    for base in (OSError, ValueError, KeyError, TypeError, AttributeError, RuntimeError):
        if isinstance(exc, base):
            return base.__name__
    return type(exc).__name__


def raiser(directive):
    if not directive:
        return
    kind, _, msg = directive.partition(':')
    exc = {'value': ValueError, 'runtime': RuntimeError, 'os': OSError, 'key': KeyError,
           'type': TypeError}[kind]
    raise exc(msg)


def main():
    payload = json.load(sys.stdin)
    root, spec = Path(payload['root']), payload['spec']
    state, wt_root = root / 'state', root / 'wt'
    segment = payload.get('segment')
    world_path = root / 'world.json'
    log = []
    builtins.SHADOW_LOG = log  # the stub crq_repair.py records `mechanical` here
    if segment and world_path.exists():
        world = json.loads(world_path.read_text())
    else:
        world = {'prs': copy.deepcopy(spec.get('prs', {})), 'remote': dict(spec.get('remote', {})),
                 'removed': [], 'n': 0}
    cur = {'tick': {}, 'run': None, 'picked': False, 'saves': 0}
    trees = spec.get('trees', {})

    # --- the in-memory removal overlay over retain's `Path` -------------------
    base_path = type(Path())

    class Overlay(base_path):
        def is_dir(self, **kwargs):
            if self.name in world['removed'] and self.parent == wt_root.resolve():
                return False
            return super().is_dir(**kwargs)

    def fake_command(argv, cwd=None, env=None, timeout=1200):
        if argv[:3] == ['git', 'worktree', 'remove']:
            name = Path(argv[3]).name
            log.append(['wt-remove', name])  # recorded; the removal is the overlay below
            world['removed'].append(name)
            return SimpleNamespace(returncode=0, stdout='', stderr='')
        if argv[:2] == ['git', 'status']:
            name = Path(cwd).name
            log.append(['wt-status', name])
            return SimpleNamespace(returncode=0, stdout=trees.get(name, {}).get('status', ''), stderr='')
        raise AssertionError(argv)

    def fake_retain_git(wt, *args):
        assert args == ('rev-parse', 'HEAD'), args
        name = Path(wt).name
        log.append(['wt-head', name])
        if cur['tick'].get('head_error'):
            raise RuntimeError(cur['tick']['head_error'])
        return trees[name]['head']

    # --- the in-memory git / forge world -------------------------------------
    def gh_json(args):
        branch = args[args.index('--head') + 1]
        log.append(['list', branch])
        return copy.deepcopy(world['prs'].get(branch, []))

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
            branch, expected = lease[len('--force-with-lease=refs/heads/'):].split(':', 1)
            src = refspec.split(':', 1)[0]
            sha = 'head-' + cur['run'] if src == 'HEAD' else src
            log.append(['push', branch, expected, sha])
            if cur['tick'].get('push_fail'):
                raise RuntimeError('git push failed: network')
            world['remote'][branch] = sha
            return ''
        raise AssertionError(args)

    def wt_git(wt, *args):
        if args == ('rev-parse', 'HEAD'):
            return 'head-' + cur['run'] if cur['picked'] else 'base-' + cur['run']
        if args[0] == 'cherry-pick':
            cur['picked'] = True
            return ''
        if args[0] == 'rev-list':
            return 'claim-' + cur['run']
        if args[0] == 'diff':
            return 'diff-' + cur['run']
        raise AssertionError(args)

    def run(argv):
        branch = argv[argv.index('--head') + 1]
        mode = cur['tick'].get('create', 'ok')
        log.append(['create', branch, mode, argv[argv.index('--title') + 1]])
        if mode == 'runtime':
            raise RuntimeError('gh pr create failed')
        if mode != 'timeout-lost':
            world['n'] += 1
            world['prs'].setdefault(branch, []).append(
                {'number': 100 + world['n'], 'url': 'u' + str(world['n']), 'state': 'OPEN',
                 'headRefOid': 'head-' + cur['run']})
        if mode.startswith('timeout'):
            raise subprocess.TimeoutExpired(argv, 600)

    def pr_info(pr):
        log.append(['pr-info', pr])
        return copy.deepcopy(spec['pr_info'])

    def is_ancestor(older, newer):
        log.append(['ancestor', older, newer])
        return spec.get('ancestor', True)

    def secret_scan(target, head, path):
        log.append(['secret-scan', target, head])
        return True, None

    def make_worktree(name, sha):
        log.append(['worktree', name, sha])
        return wt_root / ('x-' + name), 'wtb-' + name

    def save_queue(q):
        cur['saves'] += 1
        if cur['tick'].get('save_fail') == cur['saves']:
            log.append(['save-fail', cur['saves']])
            raise OSError('disk full')
        log.append(['save', copy.deepcopy(q)])
        crq_repair.atomic(state / 'queue.json', q)

    c = SimpleNamespace(
        STATE=state, ROOT=root, WT_ROOT=wt_root, CLONE=root / 'clone', REPO='o/r',
        CONFIG={'repair': {'cq_bin': 'cq'}}, iso=lambda: 'now', gh_json=gh_json, git=git, run=run,
        pr_info=pr_info, is_ancestor=is_ancestor, secret_scan=secret_scan,
        make_worktree=make_worktree,
        remove_worktree=lambda wt, branch: log.append(['remove-worktree', Path(wt).name, branch]),
        save_queue=save_queue, new_item=crq.new_item)

    def event(kind, **data):
        assert kind == 'enrolled'
        log.append(['event', data['item'], data['reason']])

    def canonical(_root, job, **_kwargs):
        log.append(['canonical', job['job']])
        raiser(cur['tick'].get('stale', {}).get(job['job']))

    def verify(wt, before, claims, job):
        log.append(['verify', Path(wt).name, before, list(claims), job])

    def mark(_c, job, result, merge=None, fix_pr=None):
        log.append(['mark', job.get('job'), json.dumps(result, separators=(',', ':'))])
        raiser(cur['tick'].get('outcome', {}).get(job.get('job')))

    class Inbox:
        def repair_outcome(self, fid, job_id, action, reason, now, **kw):
            log.append(['sibling', fid, job_id, action, reason, kw.get('repair_base'), kw.get('failure_class')])

    def hack(cq_bin, diff, wt):
        log.append(['hack', diff])

    def cleanup_wrapper(original):
        def wrapped(clone, wt_root_, directory, item_id, job_id, result, alternate=False):
            log.append(['cleanup', item_id, job_id, alternate])
            return original(clone, wt_root_, directory, item_id, job_id, result, alternate=alternate)
        return wrapped

    patches = [
        mock.patch.object(crq, 'iso', lambda t=None: 'now'),
        mock.patch.object(crq, 'event', event),
        mock.patch.object(repair_tick, 'wt_git', wt_git),
        mock.patch.object(repair_tick, 'verify', verify),
        mock.patch.object(repair_tick, 'hack_detector', hack),
        mock.patch.object(repair_tick, 'repair_provenance', lambda *a: []),
        mock.patch.object(repair_tick, 'require_canonical_delivery', canonical),
        mock.patch.object(repair_tick, 'mark_finding_outcome', mark),
        mock.patch.object(repair_tick, 'finding_inbox', lambda _c: Inbox()),
        mock.patch.object(retain, 'command', fake_command),
        mock.patch.object(retain, 'git', fake_retain_git),
        mock.patch.object(retain, 'Path', Overlay),
        mock.patch.object(retain, 'cleanup_harvested', cleanup_wrapper(retain.cleanup_harvested)),
    ]
    if segment:
        patches.append(mock.patch.object(crq, 'QUEUE', state / 'queue.json'))
    for patch in patches:
        patch.start()

    def snapshot_files():
        found = {}
        for path in sorted(state.rglob('*')):
            if path.is_file() and path.name in ('publication.json', 'queue.json', 'publication.patch', 'fix-pr.md'):
                found[str(path.relative_to(state))] = path.read_text()
        return found

    ticks = []
    try:
        q = {'items': [spec['item'], *copy.deepcopy(spec.get('extra', []))]}
        for index, tick in enumerate(segment['ticks'] if segment else spec['ticks']):
            cur['tick'] = tick
            cur['saves'] = 0
            log.append(['tick', index + (segment['offset'] if segment else 0)])
            for rel_path, doc in tick.get('files', {}).items():
                path = state / rel_path
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(doc if isinstance(doc, str) else json.dumps(doc, separators=(',', ':')))
            if segment and index == 0:
                q = crq.load_queue()  # a fresh process: the queue is only what is on disk
            if tick.get('restart'):
                if not segment:
                    q = json.loads(json.dumps(q))  # in-memory round trip; queue.json is not re-read
                    repair_tick.reset_fix_pr_backlog()
                log.append(['restart'])
            item = q['items'][0]
            for run_id, record in item.get('repair_runs', {}).items():
                cur['run'] = run_id
                cur['picked'] = False
            out = {}
            # crq.tick(dry=True) never calls harvest: a durable dry tick does not either.
            skip_harvest = bool(segment) and bool(tick.get('dry'))
            if not skip_harvest:
                try:
                    out['messages'] = repair_tick.harvest(c, q, item, dry=bool(tick.get('dry')))
                except Exception as exc:  # noqa: BLE001 - the exception family is the result
                    out['error'] = family(exc)
                    if segment and not tick.get('crash'):
                        item['last_error'] = 'repair harvest failed: ' + str(exc)[:300]
            if segment and not tick.get('crash') and not skip_harvest:
                log.append(['tick-save'])
                crq_repair.atomic(state / 'queue.json', q)
            out['queue'] = copy.deepcopy(q)
            out['files'] = snapshot_files()
            ticks.append(out)
            log.append(['backlog', dict(repair_tick.TICK_BACKLOG)])
    finally:
        for patch in patches:
            patch.stop()
    if segment:
        world_path.write_text(json.dumps(world))
    json.dump({'log': log, 'ticks': ticks, 'files': snapshot_files(), 'removed': world['removed']}, sys.stdout)


main()
