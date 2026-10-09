"""Tick-owned inbox, result harvesting and publication. No model dispatch."""
import copy
import json
from pathlib import Path
import re
from crq_repair import atomic, findings, git as wt_git, verify


def own_range(c, q, base, head):
    commits = c.git('rev-list', base + '..' + head).splitlines()
    owned = set(q.get('repair_own_commits', []))
    return bool(commits) and set(commits) <= owned


def enqueue(c, q, item, meta, rdir):
    existing = item.setdefault('repair_runs', {}).get(meta['run_id'])
    if existing:
        return True
    actionable = findings(rdir / 'review.ndjson')
    if not actionable:
        return False
    if own_range(c, q, meta['base'], meta.get('pr_head', meta['head'])):
        return False
    pin = meta.get('pr_head', meta['head'])
    count = sum(r.get('pin') == pin for r in item['repair_runs'].values())
    if count >= c.CONFIG['repair'].get('max_rounds_per_pin', 2):
        item['last_error'] = 'repair round ceiling reached; needs human'
        return False
    open_pr = item['kind'] == 'open' or item['kind'] == 'delta' and item.get('followup') != 'merged'
    base = pin if open_pr else c.git('rev-parse', 'origin/merge-queue')
    record = {'jobs': [], 'pin': pin, 'base': base, 'branch': meta.get('pr_branch'),
              'open_pr': open_pr, 'round': count + 1, 'state': 'queued'}
    reviewed_diff = c.git('diff', meta['base'], meta['head'])
    for n, finding in enumerate(actionable, 1):
        job_id = 'crq-' + meta['run_id'] + '-F' + str(n)
        prior = [v for r in item['repair_runs'].values() for v in r.get('verdicts', [])
                 if v.get('verdict') == 'NOT-FIXED' and v.get('finding', {}).get('path') == finding['path']
                 and v.get('finding', {}).get('severity') == finding['severity']]
        job = {'job': job_id, 'item': item['id'], 'kind': item['kind'], 'pr': item['pr'],
               'run': meta['run_id'], 'cycle': meta.get('cycle'), 'repair_base': base,
               'branch': record['branch'], 'finding': finding, 'repair_round': count + 1,
               'prior': prior[-1] if prior else None, 'recurrence': bool(prior),
               'review_diff': reviewed_diff}
        path = c.STATE / 'repair/inbox' / (job_id + '.json')
        if not path.exists():
            atomic(path, job)
        record['jobs'].append(job_id)
    item['repair_runs'][meta['run_id']] = record
    return True


def harvest(c, q, item, dry=False):
    messages = []
    for run, record in item.get('repair_runs', {}).items():
        if record['state'] not in ('queued', 'ready', 'publish_failed'):
            continue
        verdicts = []
        predecessor = record['base']
        for job_id in record['jobs']:
            path = c.STATE / 'repair' / job_id / 'result.json'
            if not path.exists():
                break
            result = json.loads(path.read_text())
            if result.get('retry_after'):
                break
            expected = json.loads((c.STATE / 'repair/inbox' / (job_id + '.json')).read_text())
            if result.get('job') != job_id or result.get('item') != item['id']:
                raise ValueError('repair result identity mismatch')
            if result.get('verdict') == 'FIXED':
                wt = Path(result['worktree']).resolve()
                root = c.WT_ROOT.resolve()
                if wt.parent != root or wt.name != 'crq-repair-' + item['id']:
                    raise ValueError('repair result worktree outside owned path')
                if result.get('repair_base') != predecessor:
                    raise ValueError('repair predecessor mismatch')
                # Later findings move the shared HEAD; validate each immutable
                # claimed range through a separate detached verification worktree.
                check_wt, branch = c.make_worktree('verify-' + job_id, result['commits'][-1])
                try:
                    verify(check_wt, predecessor, result['commits'], job_id)
                    from importlib import util
                    spec = util.spec_from_file_location('crq_repair_service', c.ROOT / 'crq_repair.py')
                    module = util.module_from_spec(spec)
                    spec.loader.exec_module(module)
                    module.mechanical(c.CONFIG, check_wt, predecessor, result['commits'], job_id, path.parent)
                finally:
                    c.remove_worktree(check_wt, branch)
                predecessor = result['commits'][-1]
            elif result.get('verdict') not in ('NOT-FIXED', 'FAILED'):
                raise ValueError('unknown repair verdict')
            verdicts.append({**result, 'finding': expected['finding']})
        if len(verdicts) != len(record['jobs']):
            continue
        if dry:
            messages.append('would harvest repair ' + run)
            continue
        record['verdicts'] = verdicts
        record['state'] = 'ready'
        if item['kind'] == 'promotion':
            for blocker in item.get('blocking', []):
                related = [v for v in verdicts if v['finding'].get('path') == blocker.get('file')]
                if related:
                    blocker['repair_advice'] = related[-1]['reason']
        fixed = [v for v in verdicts if v['verdict'] == 'FIXED']
        if not fixed:
            record['state'] = 'failed' if any(v['verdict'] == 'FAILED' for v in verdicts) else 'done'
            item['last_error'] = 'repair_failed; needs human' if record['state'] == 'failed' else None
        else:
            try:
                publish(c, q, item, run, record, fixed)
            except Exception as exc:
                record['state'] = 'publish_failed'
                record['error'] = str(exc)[:300]
                item['last_error'] = 'repair publish failed: ' + record['error']
        if item['kind'] != 'promotion':
            item['state'] = 'repair_failed' if record['state'] in ('failed', 'publish_failed') else 'done'
        messages.append(item['id'] + ': repair ' + record['state'])
    return messages


def publish(c, q, item, run, record, fixed):
    commits = [sha for v in fixed for sha in v['commits']]
    # Re-read GitHub pin immediately before publishing; never force push.
    info = c.pr_info(item['pr']) if record['open_pr'] else None
    if info and info['state'] != 'OPEN':
        record.update(state='stale', error='PR closed or merged before repair publication')
        return
    target = info['headRefOid'] if info else c.git('rev-parse', 'origin/merge-queue')
    if info and not c.is_ancestor(record['base'], target):
        record.update(state='stale', error='head moved non-fast-forward; await new pin review')
        return
    wt, branch = c.make_worktree('publish-' + run, target)
    try:
        translated = []
        for v in fixed:
            before = wt_git(wt, 'rev-parse', 'HEAD')
            for sha in v['commits']:
                wt_git(wt, 'cherry-pick', sha)
            claims = wt_git(wt, 'rev-list', '--reverse', before + '..HEAD').splitlines()
            verify(wt, before, claims, v['job'])
            translated.extend(claims)
        # Re-run content scan and secret scan over final rebased publication.
        from importlib import util
        spec = util.spec_from_file_location('crq_repair_service', c.ROOT / 'crq_repair.py')
        module = util.module_from_spec(spec)
        spec.loader.exec_module(module)
        patch = c.STATE / 'repair' / record['jobs'][0] / 'publication.patch'
        patch.write_text(wt_git(wt, 'diff', target + '..HEAD'))
        scan = c.run(['node', c.CONFIG['repair']['cq_bin'], 'gates.hackDetector', '--diff=@' + str(patch), '--json'], cwd=wt)
        data = json.loads(scan.stdout)
        if data.get('status') != 'ok' or data.get('value') != []:
            raise ValueError('publication hack detector failed')
        head = wt_git(wt, 'rev-parse', 'HEAD')
        ok, _ = c.secret_scan(target, head, patch.parent / 'publication-secret-scan.json')
        if not ok:
            raise ValueError('publication secret scan failed')
        if info:
            # A concurrent restack must not slip past the ancestry check.
            latest = c.pr_info(item['pr'])
            if latest['state'] != 'OPEN' or latest['headRefOid'] != target or latest['headRefName'] != record['branch']:
                raise ValueError('PR moved during publication; retry on fresh head')
            remote_branch = record['branch']
        else:
            remote_branch = 'crq/fix-' + run
        c.git('push', 'origin', 'HEAD:refs/heads/' + remote_branch, cwd=wt)
        q.setdefault('repair_own_commits', []).extend(sha for sha in translated if sha not in q.get('repair_own_commits', []))
        record['published_commits'] = translated
        if info:
            item['last_push'] = {'sha': head, 'shas': translated, 'at': c.iso()}
        else:
            prs = c.gh_json(['pr', 'list', '--repo', c.REPO, '--head', remote_branch, '--state', 'all', '--json', 'number,url,state'])
            if not prs:
                body = ['Verified CodeRabbit repairs from ' + run, '', '| finding | verdict | reason |', '|---|---|---|']
                for v in record['verdicts']:
                    body.append('| ' + v['job'] + ' | ' + v['verdict'] + ' | ' + v['reason'].replace('|', '\\|').replace('\n', ' ') + ' |')
                body_path = patch.parent / 'fix-pr.md'
                body_path.write_text('\n'.join(body) + '\n')
                c.run(['gh', 'pr', 'create', '--repo', c.REPO, '--base', 'merge-queue', '--head', remote_branch,
                       '--title', 'fix: Address CodeRabbit findings from ' + run, '--body-file', str(body_path)], cwd=wt)
                prs = c.gh_json(['pr', 'list', '--repo', c.REPO, '--head', remote_branch, '--state', 'all', '--json', 'number,url,state'])
            pr = prs[0]
            record['fix_pr'] = pr
            if not any(i['pr'] == pr['number'] and i['kind'] == 'open' for i in q['items']):
                c.new_item(q, [], False, id='pr' + str(pr['number']), pr=pr['number'], kind='open', tier=1,
                           prior_cycles=2 - c.CONFIG['repair'].get('fix_pr_cycles', 1), repair_origin=run,
                           why='verified repair fix PR')
        record['state'] = 'published'
    finally:
        c.remove_worktree(wt, branch)


def backfill(c, q):
    if q.get('legacy_repair_backfilled'):
        return
    for item in q['items']:
        for cycle in item.get('cycles', []):
            run = cycle['run_id']
            path = c.RUNS / run
            if not (path / 'meta.json').exists() or not (path / 'review.ndjson').exists():
                continue
            meta = json.loads((path / 'meta.json').read_text())
            enqueue(c, q, item, meta, path)
    q['legacy_repair_backfilled'] = c.iso()
    # Archive only when all backfilled findings have terminal verdicts.


def archive_legacy(c, q):
    records = [r for i in q['items'] for r in i.get('repair_runs', {}).values()]
    if any(r['state'] in ('queued', 'ready', 'publish_failed') for r in records):
        return
    if q.get('legacy_ledger_archived'):
        return
    archive = c.LEDGER / 'archive'
    archive.mkdir(parents=True, exist_ok=True)
    for path in c.LEDGER.glob('*-findings.md'):
        path.rename(archive / path.name)
    q['legacy_ledger_archived'] = c.iso()


def reconcile_fix_prs(c, q):
    for item in q['items']:
        if item['kind'] != 'promotion':
            continue
        for record in item.get('repair_runs', {}).values():
            pr = record.get('fix_pr')
            if not pr or record.get('fix_merged'):
                continue
            info = c.pr_info(pr['number'])
            pr['state'] = info['state']
            if info['state'] == 'MERGED':
                merge = (info.get('mergeCommit') or {}).get('oid')
                if not merge or not c.is_ancestor(merge, c.git('rev-parse', 'origin/merge-queue')):
                    continue
                fixed = {v['job'] for v in record.get('verdicts', []) if v['verdict'] == 'FIXED'}
                for index, job in enumerate(record['jobs'], 1):
                    if job in fixed:
                        for blocker in item.get('blocking', []):
                            if blocker.get('run') == next((r for r, rr in item['repair_runs'].items() if rr is record), None) and blocker.get('n') == index:
                                blocker['resolution'] = {'fix_pr': pr['number'], 'merge': merge, 'at': c.iso()}
                record['fix_merged'] = c.iso()


def digest(root, queue):
    from crq_repair import utc
    import datetime as dt
    counts = {k: 0 for k in ('fixed@A0', 'fixed@A1', 'fixed@A2', 'not-fixed', 'judged-valid', 'judged-invalid', 'failed')}
    fix_prs = []
    consumed = set()
    for item in queue['items']:
        for record in item.get('repair_runs', {}).values():
            if record.get('fix_pr'):
                fix_prs.append(record['fix_pr'])
            for value in record.get('verdicts', []):
                consumed.add(value['job'])
                if value['verdict'] == 'FIXED':
                    counts['fixed@' + value['attempts'][-1]['rung']] += 1
                else:
                    counts['not-fixed' if value['verdict'] == 'NOT-FIXED' else 'failed'] += 1
                judged = (value.get('judge') or {}).get('verdict')
                if judged in ('valid', 'invalid'):
                    counts['judged-' + judged] += 1
    inbox = Path(root) / 'state/repair/inbox'
    pending, deferred, running = [], 0, 0
    for path in inbox.glob('*.json'):
        if path.stem in consumed:
            continue
        job = json.loads(path.read_text())
        result = inbox.parent / path.stem / 'result.json'
        if result.exists():
            data = json.loads(result.read_text())
            if data.get('retry_after'):
                deferred += 1
            else:
                continue
        elif (inbox.parent / path.stem / 'progress.json').exists():
            running += 1
        pending.append(path.stat().st_mtime)
    return {'verdicts': counts, 'inbox': len(pending), 'oldest_age_minutes':
            max(0, (dt.datetime.now(dt.timezone.utc).timestamp() - min(pending)) / 60) if pending else 0,
            'jobs_in_flight': running, 'rate_limit_deferred': deferred, 'fix_prs': fix_prs}
