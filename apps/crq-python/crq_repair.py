#!/usr/bin/env python3
"""Detached repair drain. Never writes queue.json or calls GitHub/push."""
import argparse
import contextlib
import copy
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import random
from zoneinfo import ZoneInfo
from crq_repair import atomic, command, git, utc, verify
from crq_repair.drivers import cq, codex, paseo
from crq_repair.bounded import select_job, source_snapshot

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
    value = data.get('value')
    if p.returncode or data.get('status') != 'ok' or not isinstance(value, list) or value:
        raise ValueError('hack detector did not pass')
    return {'verify': 'ok', 'hack': 'ok', 'tests': 'suspended'}


@contextlib.contextmanager
def correlation(job, judge):
    """Session-log preservation (item 2.5): pin the drivers' CQ_* identity
    to the SELECTED job, not the invoking shell. The work id is the review
    run's (`crq:<run_id>`, the same value launch() writes into meta.json), so
    every repair/judge session links back to the review that produced its
    finding even on the standalone `crq_repair.py --job ...` path. Restored on
    exit so serial jobs never inherit each other's identity."""
    values = {'CQ_WORK_ID': 'crq:' + str(job['run']), 'CQ_RUN_ID': str(job['job']),
              'CQ_ROLE': 'judge' if judge else 'fixer', 'CQ_TASK': 'crq-repair'}
    # The repair job IS the review's work, so no parent: a stale shell
    # CQ_PARENT_WORK_ID must not leak into the drivers.
    saved = {k: os.environ.get(k) for k in (*values, 'CQ_PARENT_WORK_ID')}
    os.environ.pop('CQ_PARENT_WORK_ID', None)
    os.environ.update(values)
    try:
        yield
    finally:
        for key, old in saved.items():
            if old is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = old


def dispatch(config, role, job, wt, directory, judge=False):
    with correlation(job, judge):
        return _dispatch(config, role, job, wt, directory, judge)


def _dispatch(config, role, job, wt, directory, judge=False):
    directory.mkdir(parents=True, exist_ok=True)
    job = copy.deepcopy(job)
    job['source_snapshot'] = source_snapshot(config, job)
    atomic(directory / 'source-snapshot.json', job['source_snapshot'])
    if role['driver'] == 'cq':
        if judge:
            return cq.judge(config, role, job, wt, directory)
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
    saved_job = directory / 'job.json'
    if saved_job.exists():
        saved = json.loads(saved_job.read_text())
        job['window'] = saved['window']
    selected = job.get('window') or window(repair)
    job['window'] = selected
    roles = {name: copy.deepcopy(values[selected]) for name, values in repair['roles'].items()}
    result = {'job': job['job'], 'item': job['item'], 'repair_base': job['repair_base'],
              'source_sha': job['source_sha'], 'finding_sha256': job['finding_sha256'],
              'origin_job': job['origin_job'],
              'verdict': 'FAILED', 'reason': '', 'commits': [], 'attempts': [], 'judge': None,
              'worktree': str(wt), 'started_at': utc(), 'window': selected}
    if result_path.exists():
        result = json.loads(result_path.read_text())
        result.pop('retry_after', None)
    progress_path = directory / 'progress.json'
    if progress_path.exists() and (not result_path.exists() or progress_path.stat().st_mtime_ns > result_path.stat().st_mtime_ns):
        result = json.loads(progress_path.read_text())
        if result.get('dispatch_pending'):
            result.update(verdict='FAILED', reason='worker interrupted with unknown outcome; needs human', finished_at=utc())
            result.pop('dispatch_pending', None)
            atomic(result_path, result)
            return result
    atomic(directory / 'job.json', job)
    base = job['repair_base']
    evidence = result.get('evidence', '')
    rung = result.get('next_rung', max((int(a['rung'][1:]) + 1 for a in result['attempts']), default=0))
    def defer(reason):
        result['retry_after'] = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=30)).strftime('%Y-%m-%dT%H:%M:%SZ')
        result['reason'] = reason
        atomic(result_path, result)
        return result
    while rung < 3:
        role = roles['fixer' if rung < 2 else 'fixer_escalation']
        attempt_dir = directory / ('A' + str(rung))
        current = copy.deepcopy(job)
        current['mechanical_evidence'] = evidence
        try:
            if result.get('pending_judge'):
                reason = result['pending_judge']['fixer_reason']
            else:
                if rung == 2:
                    # Escalation gets a fresh worktree, not A0/A1 files or harness state.
                    git(config['clone'], 'worktree', 'remove', '--force', str(wt))
                    git(config['clone'], 'worktree', 'add', '--detach', str(wt), base)
                else:
                    git(wt, 'reset', '--hard', base)
                    git(wt, 'clean', '-fd')
                result['dispatch_pending'] = {'rung': 'A' + str(rung), 'role': role}
                atomic(progress_path, result)
                report = dispatch(config, role, current, wt, attempt_dir)
                result.pop('dispatch_pending', None)
                if report.get('stop') == 'rate-limit':
                    result['next_rung'] = rung
                    return defer('provider rate limit; attempt deferred')
                attempt = {'rung': 'A' + str(rung), 'role': 'fixer' if rung < 2 else 'fixer_escalation',
                           'driver': role['driver'], 'model': role['model'], 'stop': report.get('stop'),
                           'changed': report.get('changed', False)}
                result['attempts'].append(attempt)
                if report.get('stop') == 'configuration':
                    result['reason'] = report.get('summary', 'driver prerequisite missing; needs human')
                    break
                if report.get('stop') != 'ok' or report.get('truncated'):
                    raise ValueError('driver failure or truncated context')
                if report.get('changed'):
                    attempt['mechanical'] = mechanical(config, wt, base, report.get('commits'), job['job'], attempt_dir)
                    result.update(verdict='FIXED', reason=report.get('summary', ''), commits=report['commits'])
                    break
                if git(wt, 'status', '--porcelain') or git(wt, 'rev-parse', 'HEAD') != base:
                    raise ValueError('unchanged report left repository changes')
                reason = report.get('summary') or 'no change proposed'
            judge_required = bool(result.get('pending_judge')) or job['finding']['severity'] == 'critical' or job.get('recurrence') or random.random() < repair.get('judge_sample_rate', 0)
            if judge_required and result['judge'] is None:
                judge_role = roles['judge_critical' if job['finding']['severity'] == 'critical' else 'judge']
                current['fixer_reason'] = reason
                current['review_diff'] = job.get('review_diff', '')
                result['pending_judge'] = {'fixer_reason': reason, 'rung': rung}
                result['next_rung'] = rung
                result['dispatch_pending'] = {'rung': 'J', 'role': judge_role}
                atomic(progress_path, result)
                try:
                    judged = dispatch(config, judge_role, current, wt, directory / 'J', judge=True)
                except Exception:
                    # Unknown outcome cannot be retried as a fresh paid judgement.
                    result['judge'] = {'stop': 'error', 'verdict': 'unsure', 'reason': 'judge dispatch failed; needs human'}
                    raise
                finally:
                    result.pop('dispatch_pending', None)
                if judged.get('stop') == 'rate-limit':
                    return defer('judge rate limit; resume judge without repeating fixer')
                result.pop('pending_judge', None)
                result['judge'] = judged
                if judged.get('verdict') == 'valid' and judged.get('stop') == 'ok':
                    if rung == 2:
                        result.update(verdict='FAILED', reason='judge-confirmed defect; escalation already exhausted; needs human')
                        break
                    evidence = judged.get('reason', '')
                    result['evidence'] = evidence
                    result['next_rung'] = 2
                    atomic(progress_path, result)
                    rung = 2
                    continue
                result.update(verdict='NOT-FIXED' if judged.get('verdict') == 'invalid' and judged.get('stop') == 'ok' else 'FAILED',
                              reason=judged.get('reason') or 'judge unsure; needs human')
                break
            confirmed = (result.get('judge') or {}).get('verdict') == 'valid'
            result.update(verdict='FAILED' if confirmed else 'NOT-FIXED',
                          reason='judge-confirmed defect unresolved after A2; needs human' if confirmed else reason)
            break
        except Exception as exc:
            result.pop('dispatch_pending', None)
            evidence = str(exc)[:1000]
            result['reason'] = evidence
            if result.get('pending_judge'):
                result.pop('pending_judge', None)
                result['reason'] = 'judge outcome unavailable; needs human'
                break
            if not result['attempts'] or result['attempts'][-1]['rung'] != 'A' + str(rung):
                result['attempts'].append({'rung': 'A' + str(rung), 'driver': role['driver'],
                                           'model': role['model'], 'stop': 'error', 'changed': False})
            else:
                result['attempts'][-1]['mechanical'] = {'failure': evidence, 'tests': 'suspended'}
        result['evidence'] = evidence
        result['next_rung'] = rung + 1
        atomic(progress_path, result)
        rung += 1
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
    jobs.sort(key=lambda j: (j['run'], int(j['job'].rsplit('-F', 1)[1])))
    last_run = None
    for job in jobs:
        if job['run'] != last_run:
            base = job['repair_base']
            last_run = job['run']
        job['repair_base'] = base
        res = process(config, job, wt)
        if res.get('retry_after'):
            break
        if res['verdict'] == 'FIXED':
            base = res['commits'][-1]


def main(argv=None):
    parser = argparse.ArgumentParser(description='Explicit one-job repair only; never drain the inbox')
    parser.add_argument('--job')
    parser.add_argument('--source-sha')
    parser.add_argument('--finding-sha256')
    args = parser.parse_args(argv)
    config = json.loads((ROOT / 'config.json').read_text())
    repair = config.get('repair', {})
    if not repair.get('enabled') or not repair.get('spend_authorization'):
        print('repair dispatch disabled: existing spend authorization not verified')
        return
    if not args.job or not args.source_sha or not args.finding_sha256:
        print('repair dispatch disabled: explicit job/source/finding selection required; no automatic inbox drain')
        return
    # Validate all configured paid lanes before any A0 spend. Missing hard
    # budget support is an activation prerequisite, never a soft prompt promise.
    drivers = {role['driver'] for windows in repair['roles'].values() for role in windows.values()}
    for driver in ('codex', 'paseo'):
        if driver in drivers and (not repair.get(driver + '_budget_launcher') or
                                  not repair.get(driver + '_budget_launcher_verified')):
            print('repair dispatch disabled: verified ' + driver + ' budget launcher required')
            return
    if 'paseo' in drivers and (not repair.get('paseo_host') or not repair.get('paseo_read_only_mode')):
        print('repair dispatch disabled: verified Paseo endpoint and read-only mode required')
        return
    directory = ROOT / 'state/repair'
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / 'service.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        job = select_job(ROOT, config, args.job, args.source_sha, args.finding_sha256)
        process_item(config, [job])


if __name__ == '__main__':
    main()
