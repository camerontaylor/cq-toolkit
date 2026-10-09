#!/usr/bin/env python3
"""Detached repair drain. Never writes queue.json or calls GitHub/push."""
import concurrent.futures
import copy
import datetime as dt
import fcntl
import json
from pathlib import Path
import random
import shutil
import subprocess
from zoneinfo import ZoneInfo
from crq_repair import atomic, command, git, utc, verify
from crq_repair.drivers import cq, codex, paseo

ROOT = Path(__file__).resolve().parent


def window(repair):
    peak = repair['peak']
    t = dt.datetime.now(ZoneInfo(peak['tz']))
    return 'peak' if t.isoweekday() in peak['days'] and peak['start'] <= t.strftime('%H:%M') < peak['end'] else 'default'


def mechanical(config, wt, base, commits, job, directory):
    verify(wt, base, commits, job)
    patch = Path(directory) / 'repair.patch'
    patch.write_text(git(wt, 'diff', base + '..HEAD'))
    p = command(['node', config['repair']['cq_bin'], 'gates.hackDetector', '--diff=@' + str(patch), '--json'], cwd=wt)
    data = json.loads(p.stdout)
    value = data.get('value') or {}
    if p.returncode or data.get('status') != 'ok' or value.get('findings') or value.get('verdict') not in ('pass', 'passed', 'ok', 'clean'):
        raise ValueError('hack detector did not pass')
    return {'verify': 'ok', 'hack': 'ok', 'tests': 'suspended'}


def dispatch(config, role, job, wt, directory, judge=False):
    directory.mkdir(parents=True, exist_ok=True)
    if role['driver'] == 'cq':
        if judge:
            # cq fixItem is a fixer, never a read-only judge. Fail closed until
            # a configured read-only cq judge operation is available.
            raise RuntimeError('read-only cq judge operation not configured')
        return cq.invoke(config, role, job, wt, directory)
    if role['driver'] == 'codex':
        return codex.invoke(config, role, job, wt, directory, judge=judge)
    if role['driver'] == 'paseo' and judge:
        return paseo.invoke(config, role, job, wt, directory)
    raise ValueError('unsupported role driver')


def process(config, job, wt):
    repair = config['repair']
    directory = ROOT / 'state/repair' / job['job']
    directory.mkdir(parents=True, exist_ok=True)
    result_path = directory / 'result.json'
    if result_path.exists():
        prior = json.loads(result_path.read_text())
        if not prior.get('retry_after') or dt.datetime.fromisoformat(prior['retry_after'].replace('Z', '+00:00')) > dt.datetime.now(dt.timezone.utc):
            return prior
    selected = job.get('window') or window(repair)
    job['window'] = selected
    roles = {name: copy.deepcopy(values[selected]) for name, values in repair['roles'].items()}
    result = {'job': job['job'], 'item': job['item'], 'repair_base': job['repair_base'],
              'verdict': 'FAILED', 'reason': '', 'commits': [], 'attempts': [], 'judge': None,
              'worktree': str(wt), 'started_at': utc(), 'window': selected}
    if result_path.exists():
        result = json.loads(result_path.read_text())
        result.pop('retry_after', None)
    atomic(directory / 'job.json', job)
    base = job['repair_base']
    evidence = ''
    start_rung = len(result['attempts'])
    for rung in range(start_rung, 3):
        role = roles['fixer' if rung < 2 else 'fixer_escalation']
        attempt_dir = directory / ('A' + str(rung))
        git(wt, 'reset', '--hard', base)
        git(wt, 'clean', '-fd')
        current = copy.deepcopy(job)
        current['finding']['body'] += '\nMechanical evidence / judge rationale: ' + evidence
        try:
            report = dispatch(config, role, current, wt, attempt_dir)
            if report.get('stop') == 'rate-limit':
                result['retry_after'] = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=30)).strftime('%Y-%m-%dT%H:%M:%SZ')
                result['reason'] = 'provider rate limit; attempt deferred'
                atomic(result_path, result)
                return result
            attempt = {'rung': 'A' + str(rung), 'role': 'fixer' if rung < 2 else 'fixer_escalation',
                       'driver': role['driver'], 'model': role['model'], 'stop': report.get('stop'),
                       'changed': report.get('changed', False)}
            result['attempts'].append(attempt)
            if report.get('stop') != 'ok' or report.get('truncated'):
                raise ValueError('driver failure or truncated context')
            if report.get('changed'):
                attempt['mechanical'] = mechanical(config, wt, base, report.get('commits'), job['job'], attempt_dir)
                result.update(verdict='FIXED', reason=report.get('summary', ''), commits=report['commits'])
                break
            if git(wt, 'status', '--porcelain') or git(wt, 'rev-parse', 'HEAD') != base:
                raise ValueError('unchanged report left repository changes')
            reason = report.get('summary') or 'no change proposed'
            judge_required = job['finding']['severity'] == 'critical' or job.get('recurrence') or random.random() < repair.get('judge_sample_rate', 0)
            if judge_required and result['judge'] is None:
                judge_role = roles['judge_critical' if job['finding']['severity'] == 'critical' else 'judge']
                current['fixer_reason'] = reason
                current['review_diff'] = job.get('review_diff', '')
                judged = dispatch(config, judge_role, current, wt, directory / 'J', judge=True)
                result['judge'] = judged
                if judged.get('stop') == 'rate-limit':
                    result['attempts'].pop()
                    result['judge'] = None
                    result['retry_after'] = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=30)).strftime('%Y-%m-%dT%H:%M:%SZ')
                    atomic(result_path, result)
                    return result
                if judged.get('verdict') == 'valid' and judged.get('stop') == 'ok':
                    evidence = judged.get('reason', '')
                    # Skip same-worker retry: judge-directed refix gets A2 only.
                    result['attempts'].append({'rung': 'A1', 'stop': 'skipped', 'reason': 'judge-directed A2'})
                    continue
                result.update(verdict='NOT-FIXED' if judged.get('verdict') == 'invalid' and judged.get('stop') == 'ok' else 'FAILED',
                              reason=judged.get('reason') or 'judge unsure; needs human')
                break
            result.update(verdict='NOT-FIXED', reason=reason)
            break
        except Exception as exc:
            evidence = str(exc)[:1000]
            result['reason'] = evidence
            if len(result['attempts']) <= rung:
                result['attempts'].append({'rung': 'A' + str(rung), 'driver': role['driver'],
                                           'model': role['model'], 'stop': 'error', 'changed': False})
            else:
                result['attempts'][-1]['mechanical'] = {'failure': evidence, 'tests': 'suspended'}
        atomic(directory / 'progress.json', result)
    result['finished_at'] = utc()
    atomic(result_path, result)
    return result


def process_item(config, jobs):
    # One item worktree, serial findings; each successful commit range is pinned
    # and the next finding starts at its verified predecessor.
    item = jobs[0]['item']
    wt = Path(config['worktree_root']) / ('crq-repair-' + item)
    base = jobs[0]['repair_base']
    if not wt.exists():
        p = command(['git', 'worktree', 'add', '--detach', str(wt), base], cwd=config['clone'])
        if p.returncode:
            raise RuntimeError('repair worktree creation failed')
    for job in jobs:
        res = process(config, job, wt)
        if res.get('retry_after'):
            break
        if res['verdict'] == 'FIXED':
            base = res['commits'][-1]
        job_base = base
        # Each following job's base must preserve already verified earlier fixes.
        index = jobs.index(job)
        if index + 1 < len(jobs):
            jobs[index + 1]['repair_base'] = job_base


def main():
    config = json.loads((ROOT / 'config.json').read_text())
    repair = config.get('repair', {})
    if not repair.get('enabled') or not repair.get('spend_authorization'):
        print('repair dispatch disabled: existing spend authorization not verified')
        return
    directory = ROOT / 'state/repair'
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / 'service.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        groups = {}
        for path in sorted((directory / 'inbox').glob('*.json')):
            job = json.loads(path.read_text())
            groups.setdefault(job['item'], []).append(job)
        with concurrent.futures.ThreadPoolExecutor(max_workers=repair.get('max_concurrent', 3)) as executor:
            futures = [executor.submit(process_item, config, jobs) for jobs in groups.values()]
            for future in futures:
                future.result()


if __name__ == '__main__':
    main()
