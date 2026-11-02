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
from crq_repair.bounded import drain_job, drain_order, select_job, source_snapshot

ROOT = Path(__file__).resolve().parent
DEFAULT_RATE_LIMIT_PAUSE = dt.timedelta(minutes=30)
MAX_RATE_LIMIT_PAUSE = dt.timedelta(hours=24)


def pause_path():
    return ROOT / 'state/repair/rate-limited-until'


def rate_limit_pause(report, job_id):
    """Any provider rate limit pauses ALL repair dispatch until the provider's
    retry time (30 minutes if it gives none). Nothing is counted against jobs."""
    retry_ms = report.get('retry_after_ms')
    if retry_ms is None:
        retry_ms = (report.get('providerSignals') or {}).get('retryAfterMs')
    wait = DEFAULT_RATE_LIMIT_PAUSE
    if isinstance(retry_ms, (int, float)) and not isinstance(retry_ms, bool) and retry_ms > 0:
        wait = min(dt.timedelta(milliseconds=retry_ms), MAX_RATE_LIMIT_PAUSE)
    until = (dt.datetime.now(dt.timezone.utc) + wait).strftime('%Y-%m-%dT%H:%M:%SZ')
    current = paused()
    if current and current > until:
        until = current  # never shorten an existing pause
    atomic(pause_path(), {'until': until, 'job': job_id, 'at': utc()})
    return until


def paused(now=None):
    """The pause end (ISO UTC) while it is in the future, else None."""
    path = pause_path()
    if not path.exists():
        return None
    try:
        until = json.loads(path.read_text())['until']
        end = dt.datetime.fromisoformat(until.replace('Z', '+00:00'))
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        # Unreadable marker: fail closed for one default window from its mtime.
        end = dt.datetime.fromtimestamp(path.stat().st_mtime, dt.timezone.utc) + DEFAULT_RATE_LIMIT_PAUSE
        until = end.strftime('%Y-%m-%dT%H:%M:%SZ')
    return until if end > (now or dt.datetime.now(dt.timezone.utc)) else None


def blackout(repair, now=None):
    """GLM peak hours: no repair dispatch at all (no peak role switch)."""
    window = repair.get('blackout')
    if not window:
        return False
    t = (now or dt.datetime.now(dt.timezone.utc)).astimezone(ZoneInfo(window['tz']))
    return t.isoweekday() in window['days'] and window['start'] <= t.strftime('%H:%M') < window['end']


def blocked(repair, now=None):
    """No dispatch inside the blackout, nor one whose wall clock would reach it.
    Checking both ends suffices while wall_clock_min is shorter than the window."""
    now = now or dt.datetime.now(dt.timezone.utc)
    reach = dt.timedelta(minutes=repair.get('budget', {}).get('wall_clock_min', 0))
    return blackout(repair, now) or blackout(repair, now + reach)


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
    roles = copy.deepcopy(repair['roles'])
    result = {'job': job['job'], 'item': job['item'], 'repair_base': job['repair_base'],
              'source_sha': job['source_sha'], 'finding_sha256': job['finding_sha256'],
              'origin_job': job.get('origin_job'),
              'verdict': 'FAILED', 'reason': '', 'commits': [], 'attempts': [], 'judge': None,
              'worktree': str(wt), 'started_at': utc()}
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
    def defer(reason, rate_limit=None):
        if rate_limit is not None:
            # Global pause marker first: no model call anywhere until it expires.
            result['retry_after'] = rate_limit_pause(rate_limit, job['job'])
        else:
            result['retry_after'] = (dt.datetime.now(dt.timezone.utc) + DEFAULT_RATE_LIMIT_PAUSE).strftime('%Y-%m-%dT%H:%M:%SZ')
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
                if blocked(repair):
                    result['next_rung'] = rung
                    return defer('GLM peak blackout; attempt deferred')
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
                    return defer('provider rate limit; attempt deferred', rate_limit=report)
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
                if blocked(repair):
                    return defer('GLM peak blackout; judge deferred without repeating fixer')
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
                    return defer('judge rate limit; resume judge without repeating fixer', rate_limit=judged)
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


def finding_order(job):
    # Review jobs end in -F<n>; backfill jobs (crq-backfill-<key>) carry none.
    suffix = job['job'].rsplit('-F', 1)
    return job['run'], int(suffix[1]) if len(suffix) == 2 and suffix[1].isdigit() else 0


def pending(job_id):
    """True unless the job already has a terminal (non-deferred) result."""
    path = ROOT / 'state/repair' / job_id / 'result.json'
    if not path.exists():
        return True
    prior = json.loads(path.read_text())
    return bool(prior.get('retry_after'))


def mark_stale(job, reason):
    """Terminal, spend-free verdict for a superseded job; the tick harvests it."""
    directory = ROOT / 'state/repair' / job['job']
    atomic(directory / 'result.json', {
        'job': job['job'], 'item': job['item'], 'repair_base': job.get('repair_base'),
        'source_sha': job.get('source_sha'), 'finding_sha256': job.get('finding_sha256'),
        'origin_job': job.get('origin_job'), 'verdict': 'STALE', 'reason': reason,
        'commits': [], 'attempts': [], 'judge': None, 'started_at': utc(), 'finished_at': utc()})


def fetch_clone(config):
    """`git fetch --prune` under the tick's own lock (crq.with_lock: the same
    state/tick.lock file, flock LOCK_EX|LOCK_NB). If the tick holds it, skip
    this pass rather than race its fetch. Returns an error string, or None."""
    lock_path = ROOT / 'state/tick.lock'
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 'crq tick holds tick.lock'
        try:
            # Under tick.lock: stay below the tick's 90 s lock wait so a hung fetch
            # skips this drain pass instead of making a tick exit.
            fetched = command(['git', 'fetch', '--prune', '--quiet', 'origin'], cwd=config['clone'], timeout=60)
            return 'clone fetch failed: ' + fetched.stderr.strip() if fetched.returncode else None
        except Exception as exc:  # timeout: command() already killed its process group
            return 'clone fetch failed: ' + str(exc)
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def drain(config):
    """Automatic inbox drain, oldest first. Items run serially: one item
    worktree at a time, serial findings within it (see README for why)."""
    repair = config['repair']
    until = paused()
    if until:
        print('repair drain paused: provider rate limit until ' + until)
        return
    # Stale checks read origin refs; refresh them first. Fetch only: the worker
    # never pushes or calls the GitHub API. A failed fetch skips this pass.
    error = fetch_clone(config)
    if error is not None:
        print('repair drain skipped: ' + error[:200])
        return
    groups = {}  # item -> job ids, items in order of their oldest job
    for job_id in drain_order(ROOT):
        try:
            item = json.loads((ROOT / 'state/repair/inbox' / (job_id + '.json')).read_text()).get('item')
        except (OSError, ValueError, AttributeError):
            continue
        if isinstance(item, str):
            groups.setdefault(item, []).append(job_id)
    for item, job_ids in groups.items():
        if blocked(repair):
            print('repair drain paused: GLM peak blackout')
            return
        # Re-read the queue per item: the tick may harvest or the tip may move
        # while an earlier item runs.
        queue_path = ROOT / 'state/queue.json'
        queue = json.loads(queue_path.read_text()) if queue_path.exists() else {'items': []}
        jobs = []
        for job_id in job_ids:
            status, job, reason = drain_job(ROOT, config, queue, job_id)
            if not job or job.get('item') != item:
                continue
            if status == 'stale':
                mark_stale(job, reason)
                print('repair ' + job_id + ': stale, not dispatched: ' + reason)
                # It stays in its run's chain; process() returns the terminal result.
                jobs.append(job)
            elif status == 'run':
                jobs.append(job)
            elif reason != 'no queued tick-owned repair run':
                print('repair ' + job_id + ': skipped: ' + reason)
        if not any(pending(job['job']) for job in jobs):
            continue
        try:
            outcome = process_item(config, jobs)
        except Exception as exc:  # one bad item must not stop the drain
            print('repair item ' + item + ' failed: ' + str(exc)[:300])
            continue
        if outcome == 'rate-limit':
            print('repair drain stopped: provider rate limit until ' + str(paused()))
            return


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
    jobs.sort(key=finding_order)
    last_run = None
    for job in jobs:
        if blocked(config['repair']):
            break  # never start a new finding inside the GLM peak window
        if paused():
            return 'rate-limit'  # no model call anywhere while the pause marker is live
        if job['run'] != last_run:
            base = job['repair_base']
            last_run = job['run']
        job['repair_base'] = base
        res = process(config, job, wt)
        if paused():
            return 'rate-limit'
        if res.get('retry_after'):
            break
        if res['verdict'] == 'FIXED':
            base = res['commits'][-1]
    return None


def main(argv=None):
    parser = argparse.ArgumentParser(description='Drain eligible repair inbox jobs, or repair one explicit prepared job')
    parser.add_argument('--job')
    parser.add_argument('--source-sha')
    parser.add_argument('--finding-sha256')
    args = parser.parse_args(argv)
    config = json.loads((ROOT / 'config.json').read_text())
    repair = config.get('repair', {})
    authorization = repair.get('spend_authorization')
    if repair.get('enabled') is not True or not isinstance(authorization, str) or not authorization.strip():
        print('repair dispatch disabled: repair.enabled and a recorded spend_authorization are required')
        return
    selectors = (args.job, args.source_sha, args.finding_sha256)
    if any(selectors) and not all(selectors):
        print('repair dispatch refused: --job, --source-sha and --finding-sha256 go together')
        return
    # Validate all configured paid lanes before any A0 spend. Missing hard
    # budget support is an activation prerequisite, never a soft prompt promise.
    drivers = {role['driver'] for role in repair['roles'].values()}
    for driver in ('codex', 'paseo'):
        if driver in drivers and (not repair.get(driver + '_budget_launcher') or
                                  not repair.get(driver + '_budget_launcher_verified')):
            print('repair dispatch disabled: verified ' + driver + ' budget launcher required')
            return
    if 'paseo' in drivers and (not repair.get('paseo_host') or not repair.get('paseo_read_only_mode')):
        print('repair dispatch disabled: verified Paseo endpoint and read-only mode required')
        return
    # A missing key would otherwise turn every attempt into a FAILED verdict.
    if any(role['driver'] == 'cq' and role['model'].startswith('zai/') for role in repair['roles'].values()) \
            and not os.environ.get('ZAI_API_KEY'):
        print('repair dispatch disabled: ZAI_API_KEY is not in the service environment')
        return
    if blocked(repair):
        print('repair dispatch paused: GLM peak blackout')
        return
    directory = ROOT / 'state/repair'
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / 'service.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        if all(selectors):
            job = select_job(ROOT, config, args.job, args.source_sha, args.finding_sha256)
            process_item(config, [job])
            return
        drain(config)


if __name__ == '__main__':
    main()
