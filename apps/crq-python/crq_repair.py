#!/usr/bin/env python3
"""Detached repair drain. Backfill delivery uses the tick lock; no GitHub/push."""
import argparse
import contextlib
import copy
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import random
import re
import sys
import time
from zoneinfo import ZoneInfo
from crq_repair import atomic, command, git, hack_detector, utc, verify
from crq_repair.drivers import cq, codex, paseo
from crq_repair.retain import retain
from crq_repair.bounded import drain_job, drain_order, require_canonical_delivery, select_job, source_snapshot

ROOT = Path(__file__).resolve().parent
DEFAULT_RATE_LIMIT_PAUSE = dt.timedelta(minutes=30)
MAX_RATE_LIMIT_PAUSE = dt.timedelta(hours=24)
TICK_LOCK_WAIT_S = 300


@contextlib.contextmanager
def cooldown_write():
    # Same canonical state/tick.lock used by fetch_clone and the tick. Never
    # hold it while waiting for workers or calling providers.
    path = ROOT / 'state/tick.lock'
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


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
    with cooldown_write():
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
    # `enabled: false` suspends the window (owner switch, e.g. when GLM quota is
    # plentiful); a missing flag keeps the window in force.
    if not window or window.get('enabled', True) is False:
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
    diff = git(wt, 'diff', base + '..HEAD')
    patch.write_text(diff + '\n')  # evidence copy; the detector scans the text itself
    hack_detector(config['repair']['cq_bin'], diff, wt)
    return {'verify': 'ok', 'hack': 'ok', 'tests': 'suspended'}


def failure_class_for_stop(config, job, report):
    """Classify from the driver's typed stop, never from error prose."""
    if report.get('stop') in ('rate-limit', 'configuration'):
        return 'transient'
    return 'exhausted'


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


def fallback_roles(config, role):
    return [role] + [{**role, 'driver': 'cq', 'model': model}
                     for model in config['repair'].get('fallback_models', [])
                     if role['driver'] == 'cq' and model != role['model']]


def provider_ready(role):
    provider = role['model'].split('/', 1)[0]
    keys = {'zai': ('ZAI_API_KEY',), 'opencode-go': ('OPENCODE_GO_API_KEY', 'OPENCODE_GO_BASE_URL'),
            'deepseek': ('DEEPSEEK_API_KEY',)}
    return all(os.environ.get(key) for key in keys.get(provider, ()))


def provider_cooldowns():
    path = ROOT / 'state/repair/provider-cooldowns.json'
    if not path.exists():
        return {}
    # Corrupt state must not silently spend against a known exhausted provider.
    return json.loads(path.read_text())


def remember_provider_limit(provider, report):
    now = dt.datetime.now(dt.timezone.utc)
    retry_ms = report.get('retry_after_ms') or (report.get('providerSignals') or {}).get('retryAfterMs')
    wait = dt.timedelta(milliseconds=retry_ms) if isinstance(retry_ms, (int, float)) and retry_ms > 0 else DEFAULT_RATE_LIMIT_PAUSE
    until = now + min(wait, dt.timedelta(days=7))
    # Only parse the vendor's explicit reset phrase, never arbitrary dates in
    # finding text. An unzoned date is conservatively treated as UTC, avoiding
    # an early retry against a provider whose local timezone is east of UTC.
    text = str(report.get('summary') or report.get('reason') or '')
    reset = re.search(r'limit will reset at (\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)', text, re.I)
    if reset:
        try:
            end = dt.datetime.fromisoformat(reset[1].replace('Z', '+00:00'))
            if end.tzinfo is None:
                end = end.replace(tzinfo=dt.timezone.utc)
            until = max(until, min(end, now + dt.timedelta(days=7)))
        except ValueError:
            pass
    with cooldown_write():
        state = provider_cooldowns()
        stamp = until.astimezone(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        state[provider] = max(state.get(provider, ''), stamp)
        atomic(ROOT / 'state/repair/provider-cooldowns.json', state)
        return state[provider]


def dispatch_paused(config):
    if config['repair'].get('fallback_models'):
        state = provider_cooldowns()
        now = utc()
        roles = [candidate for role in config['repair']['roles'].values()
                 for candidate in fallback_roles(config, role) if provider_ready(candidate)]
        if any(state.get(role['model'].split('/', 1)[0], '') <= now for role in roles):
            return None
    return paused()


def dispatch(config, role, job, wt, directory, judge=False):
    if role['driver'] != 'cq' or not config.get('repair', {}).get('fallback_models'):
        with correlation(job, judge):
            return _dispatch(config, role, job, wt, directory, judge)
    deadline = time.monotonic() + config['repair']['budget']['wall_clock_min'] * 60
    waits = []
    baseline = git(wt, 'rev-parse', 'HEAD') if not judge else None
    attempted = False
    seen = set()
    previous_directory = None
    with correlation(job, judge):
        for candidate in fallback_roles(config, role):
            provider = candidate['model'].split('/', 1)[0]
            if provider in seen or not provider_ready(candidate):
                continue
            seen.add(provider)
            state = provider_cooldowns()  # another item may have exhausted it
            if state.get(provider, '') > utc():
                waits.append(state[provider])
                continue
            # Separate sessions and logs for each provider, including judges.
            remaining = deadline - time.monotonic()
            if remaining < 0.001:
                return {'stop': 'budget', 'summary': 'repair dispatch wall-clock deadline reached'}
            if attempted and not judge:
                retain(wt, baseline, previous_directory)
                git(wt, 'reset', '--hard', baseline)
                git(wt, 'clean', '-fd')
            attempted = True
            bounded_config = copy.deepcopy(config)
            bounded_config['repair']['budget']['wall_clock_min'] = remaining / 60
            previous_directory = directory / provider
            report = _dispatch(bounded_config, candidate, job, wt, previous_directory, judge)
            report.update(driver=candidate['driver'], model=candidate['model'])
            if report.get('stop') != 'rate-limit':
                return report
            waits.append(remember_provider_limit(provider, report))
    if not waits:
        return {'stop': 'configuration', 'summary': 'no configured repair provider is available'}
    end = dt.datetime.fromisoformat(min(waits).replace('Z', '+00:00'))
    return {'stop': 'rate-limit', 'retry_after_ms': max(1000, (end - dt.datetime.now(dt.timezone.utc)).total_seconds() * 1000)}


def _dispatch(config, role, job, wt, directory, judge=False):
    directory.mkdir(parents=True, exist_ok=True)
    job = copy.deepcopy(job)
    if job.get('triage_context') is not None:
        return cq.judge(config, role, job, wt, directory)
    require_canonical_delivery(ROOT, job)
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


def resume_worktree(result, wt):
    """Resume states record the rung's worktree (A2 is a suffixed checkout),
    but process_item passes the original worktree on restart. Validate the
    recorded tree and restore it before handling either resume state so
    interrupted retention and deferred judging use the tree the result names."""
    recorded = result.get('worktree')
    if not recorded:
        return wt
    recorded = Path(recorded).resolve()
    if recorded != Path(wt).resolve() and recorded.is_dir() and (recorded / '.git').exists():
        return recorded
    return wt


def process(config, job, wt):
    repair = config['repair']
    directory = ROOT / 'state/repair' / job['job']
    directory.mkdir(parents=True, exist_ok=True)
    result_path = directory / 'result.json'
    if result_path.exists():
        prior = json.loads(result_path.read_text())
        if not prior.get('retry_after') or (not repair.get('fallback_models') and dt.datetime.fromisoformat(prior['retry_after'].replace('Z', '+00:00')) > dt.datetime.now(dt.timezone.utc)):
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
    resume_progress = progress_path.exists() and (not result_path.exists() or progress_path.stat().st_mtime_ns > result_path.stat().st_mtime_ns)
    if resume_progress:
        result = json.loads(progress_path.read_text())
    if result.get('dispatch_pending') or result.get('pending_judge'):
        wt = resume_worktree(result, wt)
    if resume_progress:
        if result.get('dispatch_pending'):
            saved_wt = Path(result.get('worktree', '')).resolve()
            if saved_wt == Path(wt).resolve():
                try:
                    retain(saved_wt, job['repair_base'], directory / 'interrupted')
                except Exception as exc:
                    result.update(verdict='FAILED', reason='interrupted worktree retention failed: ' + str(exc)[:600], finished_at=utc())
                    result.pop('dispatch_pending', None)
                    atomic(result_path, result)
                    return result
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
                retain(wt, base, directory / ('before-A' + str(rung)))
                if rung == 2:
                    # Preserve the previous tree (including ignored files) and
                    # give escalation a separate fresh checkout.
                    wt = Path(str(wt) + '-A2')
                    if wt.exists():
                        retain(wt, base, directory / 'before-A2-existing')
                        git(wt, 'reset', '--hard', base)
                        git(wt, 'clean', '-fd')
                    else:
                        git(config['clone'], 'worktree', 'add', '--detach', str(wt), base)
                    result['worktree'] = str(wt)
                else:
                    git(wt, 'reset', '--hard', base)
                    git(wt, 'clean', '-fd')
                result['worktree'] = str(wt)
                result['dispatch_pending'] = {'rung': 'A' + str(rung), 'role': role}
                atomic(progress_path, result)
                report = dispatch(config, role, current, wt, attempt_dir)
                result.pop('dispatch_pending', None)
                disposition = report.get('worker_disposition') or report.get('disposition')
                if (report.get('stop') in ('ok', 'error') and disposition == 'needs_human'
                        and str(report.get('summary') or '').strip()):
                    result.update(verdict='FAILED', failure_class='owner-decision', reason=report.get('summary') or 'worker requested owner decision')
                    break
                result['failure_class'] = failure_class_for_stop(config, job, report)
                if (report.get('stop') not in ('rate-limit', 'configuration', 'budget')
                        and disposition in ('no_outcome', 'unchanged_with_reason') and not report.get('evidence')):
                    result['failure_class'] = 'exhausted'
                result.pop('unchanged_evidence', None)
                if report.get('stop') == 'rate-limit':
                    retain(wt, base, attempt_dir)
                    result['next_rung'] = rung
                    return defer('provider rate limit; attempt deferred', rate_limit=report)
                attempt = {'rung': 'A' + str(rung), 'role': 'fixer' if rung < 2 else 'fixer_escalation',
                           'driver': report.get('driver', role['driver']), 'model': report.get('model', role['model']), 'stop': report.get('stop'),
                           'changed': report.get('changed', False)}
                result['attempts'].append(attempt)
                if report.get('stop') == 'configuration':
                    result['reason'] = report.get('summary', 'driver prerequisite missing; needs human')
                    break
                if report.get('stop') != 'ok':
                    raise ValueError('driver stop ' + str(report.get('stop')) + ': '
                                     + str(report.get('summary') or 'no detail')[:600])
                if report.get('truncated'):
                    raise ValueError('driver failure or truncated context')
                if report.get('changed'):
                    attempt['mechanical'] = mechanical(config, wt, base, report.get('commits'), job['job'], attempt_dir)
                    result.update(verdict='FIXED', reason=report.get('summary', ''), commits=report['commits'])
                    break
                if git(wt, 'status', '--porcelain') or git(wt, 'rev-parse', 'HEAD') != base:
                    raise ValueError('unchanged report left repository changes')
                reason = report.get('summary') or 'no change proposed'
                if report.get('disposition') == 'unchanged_with_reason':
                    citations = report.get('evidence')
                    if not isinstance(citations, list) or not citations:
                        raise ValueError('unchanged outcome requires source evidence')
                    verified = []
                    for citation in citations:
                        path, line = citation['path'], citation['line']
                        if (not isinstance(path, str) or path.startswith('/') or '..' in path.split('/')
                                or not isinstance(line, int) or isinstance(line, bool) or line < 1):
                            raise ValueError('invalid unchanged evidence anchor')
                        blob = command(['git', 'cat-file', 'blob', base + ':' + path], cwd=wt)
                        if blob.returncode:
                            raise ValueError('unchanged evidence blob absent')
                        source = blob.stdout.splitlines()
                        if line > len(source):
                            raise ValueError('unchanged evidence line absent')
                        verified.append({'path': path, 'line': line, 'quoted_text': source[line - 1], 'target': base})
                    result['unchanged_evidence'] = verified

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
                if (judged.get('stop') == 'ok' and judged.get('verdict') == 'unsure'
                        and judged.get('reason') and rung < 2):
                    evidence = judged['reason']
                    result['evidence'] = evidence
                    result['next_rung'] = 2
                    atomic(progress_path, result)
                    rung = 2
                    continue
                result.update(verdict='NOT-FIXED' if judged.get('verdict') == 'invalid' and judged.get('stop') == 'ok' else 'FAILED',
                              reason=judged.get('reason') or 'judge unsure; needs human')
                if judged.get('stop') in ('rate-limit', 'configuration'):
                    result['failure_class'] = 'transient'
                else:
                    result['failure_class'] = 'evidence' if judged.get('stop') == 'ok' and judged.get('verdict') == 'unsure' else 'exhausted'
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
            # If capture fails, never advance to a reset that could erase work.
            try:
                retain(wt, base, attempt_dir)
            except Exception as capture_error:
                result['reason'] = 'worktree retention failed: ' + str(capture_error)[:600]
                break
        result['evidence'] = evidence
        result['next_rung'] = rung + 1
        atomic(progress_path, result)
        rung += 1
    try:
        # Even a clean, unchanged terminal tree needs a verifiable snapshot:
        # harvest may retire it only after this capture succeeds.
        retain(wt, base, directory / 'final', include_clean=True)
    except Exception as exc:
        result['verdict'] = 'FAILED'
        result['reason'] = 'worktree retention failed: ' + str(exc)[:600]
    result['finished_at'] = utc()
    atomic(result_path, result)
    return result


def finding_order(job):
    # Review jobs end in -F<n>; backfill jobs (crq-backfill-<key>) carry none.
    suffix = job['job'].rsplit('-F', 1)
    number = int(suffix[1]) if len(suffix) == 2 and suffix[1].isdigit() else 0
    return job.get('finding', {}).get('severity') == 'minor', job['run'], number


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


def fetch_clone(config, lock_wait=None):
    """`git fetch --prune` under the tick's own lock (crq.with_lock: the same
    state/tick.lock file, flock LOCK_EX|LOCK_NB). If the tick holds it, poll
    for up to `lock_wait` seconds (repair.tick_lock_wait_s, default 300), then
    skip this pass rather than race its fetch. Ticks hold the lock for ~1-7
    minutes every 12, so an instant skip dropped about one pass in five.
    The wait stays below the 10-minute drain timer. Returns an error string,
    or None."""
    if lock_wait is None:
        lock_wait = config.get('repair', {}).get('tick_lock_wait_s', TICK_LOCK_WAIT_S)
    lock_path = ROOT / 'state/tick.lock'
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open('w') as lock:
        deadline = time.monotonic() + lock_wait
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                remaining = deadline - time.monotonic()
                if remaining < 0.001:
                    return 'crq tick holds tick.lock'
                time.sleep(min(5.0, remaining))
        try:
            # Under tick.lock: stay below the tick's 90 s lock wait so a hung fetch
            # skips this drain pass instead of making a tick exit.
            fetched = command(['git', 'fetch', '--prune', '--quiet', 'origin'], cwd=config['clone'], timeout=60)
            return 'clone fetch failed: ' + fetched.stderr.strip() if fetched.returncode else None
        except Exception as exc:  # timeout: command() already killed its process group
            return 'clone fetch failed: ' + str(exc)
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def triage_context_safe(c, context, output):
    """Scan unescaped string values before serialization or any model upload."""
    def strings(value):
        if isinstance(value, str):
            yield value
        elif isinstance(value, dict):
            for item in value.values():
                yield from strings(item)
        elif isinstance(value, list):
            for item in value:
                yield from strings(item)
    content = '\n'.join(strings(context))
    path = context.get('current_path') or context['finding'].get('path') or 'triage-context.txt'
    diff = 'diff --git a/' + path + ' b/' + path + '\n@@ -0,0 +1 @@\n'
    diff += '\n'.join('+' + line for line in content.splitlines()) + '\n'
    return c.secret_scan_diff(diff, output)[0]


def triage_context_scan(c, context, output):
    """A scan policy read or parse failure must defer with its cause intact."""
    from crq_repair.triage import ContextScanError
    try:
        return triage_context_safe(c, context, output)
    except (OSError, RuntimeError) as exc:
        raise ContextScanError(exc) from exc


def triage_phase(config, dry_run=False):
    import crq as c
    import backfill_runtime as runtime
    import finding_delivery
    from crq_repair.triage import phase
    from runtime_target import DEFAULT_REF
    state = ROOT / 'state'
    if not (state / 'backfill/findings/triage').exists():
        return None
    rollout = runtime.settings(state)
    if not rollout:
        return None
    repo, _, outbox, _ = runtime.services(c, rollout)
    inbox = finding_delivery.Inbox(state / 'backfill/findings', outbox)
    tip = git(config['clone'], 'rev-parse', DEFAULT_REF)
    options = config['repair'].get('triage', {})
    role = options.get('role', {'driver': 'cq', 'model': 'opencode-go/deepseek-v4.1-flash'})
    if role.get('driver') != 'cq':
        raise ValueError('triage requires cq structured judge bridge')
    def judge(row, context, remaining):
        job = {'job': 'crq-triage-' + row['finding']['id'], 'run': row['review_id'],
               'triage_context': context}
        directory = state / 'repair/triage' / row['finding']['id']
        directory.mkdir(parents=True, exist_ok=True)
        if not triage_context_scan(c, context, directory / 'context-scan.json'):
            return {'stop': 'ok', 'verdict': 'unsure', 'context_scan_refused': True, 'reason': 'triage context secret scan rejected'}
        bounded_config = copy.deepcopy(config)
        bounded_config['repair']['budget']['wall_clock_min'] = remaining / 60
        selected = options.get('escalation_role', config['repair']['roles']['judge_critical']) if row.get('_escalate') else role
        return dispatch(bounded_config, selected, job, config['clone'],
                        state / 'repair/triage' / row['finding']['id'], judge=True)
    def transport(key, request):
        receipt = []
        def deliver_locked():
            queue = c.load_queue()
            accept = finding_delivery.configured_repair_transport(c, repo, queue, runtime)
            receipt.append(accept(key, request))
        if not c.ran_locked(deliver_locked):
            raise RuntimeError('tick busy; confirmed delivery will retry')
        return receipt[0]
    result = phase(inbox, repo, tip, judge, transport, utc(),
                   maximum=max(0, min(6, int(options.get('max_per_pass', 6)))),
                   seconds=config['repair']['budget']['wall_clock_min'] * 60, dry_run=dry_run)
    print('backfill triage: ' + json.dumps(result))
    if result.get('stopped') == 'rate-limit' and not dry_run:
        rate_limit_pause(result.get('stop_report', {}), 'backfill-triage')
    return result


def drain(config):
    """Automatic inbox drain, minor-only items after critical/major items. Items use isolated worker
    processes up to the configured cap, with serial findings within each item."""
    repair = config['repair']
    worker_limit(config)  # validate before triage or any provider spend
    until = dispatch_paused(config)
    if until:
        print('repair drain paused: provider rate limit until ' + until)
        return
    # Stale checks read origin refs; refresh them first. Fetch only: the worker
    # never pushes or calls the GitHub API. A failed fetch skips this pass.
    error = fetch_clone(config)
    if error is not None:
        print('repair drain skipped: ' + error[:200])
        return
    try:
        triage_phase(config)
    except Exception as exc:  # backfill deferral must not starve existing repair jobs
        print('backfill triage deferred: ' + str(exc)[:300])
    if dispatch_paused(config):
        return
    groups = {}  # item -> job ids, items in order of their oldest job
    for job_id in drain_order(ROOT):
        try:
            job = json.loads((ROOT / 'state/repair/inbox' / (job_id + '.json')).read_text())
            item = job.get('item')
        except (OSError, ValueError, AttributeError):
            continue
        if isinstance(item, str):
            groups.setdefault(item, []).append(job_id)
    # Classify against the queue before sorting. Skipped, stale and completed
    # jobs cannot promote a minor-only item; stable sort retains inbox order.
    queue_path = ROOT / 'state/queue.json'
    queue = json.loads(queue_path.read_text()) if queue_path.exists() else {'items': []}
    def priority(item):
        for job_id in groups[item]:
            status, job, _ = drain_job(ROOT, config, queue, job_id)
            if (status == 'run' and job and job.get('item') == item
                    and pending(job_id) and job.get('finding', {}).get('severity') in ('critical', 'major')):
                return 0
        return 1
    drain_items(config, groups, sorted(groups, key=priority))


def drain_item(config, item, job_ids):
    if blocked(config['repair']) or dispatch_paused(config):
        return 'rate-limit'
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
        return None
    try:
        return process_item(config, jobs)
    except Exception as exc:  # a failed item must not stop other items
        print('repair item ' + item + ' failed: ' + str(exc)[:300], flush=True)
        return None


def worker_limit(config):
    limit = config['repair'].get('max_concurrent_items', 1)
    if type(limit) is not int or not 1 <= limit <= 10:
        raise ValueError('repair.max_concurrent_items must be an integer from 1 to 10')
    return limit


def drain_items(config, groups, order):
    """One coordinator owns admission; forked items have private CQ_* environments.

    Never kill paid workers: on abort or admission failure, reap admitted children
    before releasing service.lock. The service's existing systemd cgroup remains
    the owner of emergency shutdown and its existing drain deadline.
    """
    limit = worker_limit(config)
    active = {}
    stopped = False
    try:
        for item in order:
            while len(active) >= limit:
                stopped = reap_item(active) or stopped
            stopped = reap_completed(active)[0] or stopped
            if stopped or blocked(config['repair']) or dispatch_paused(config):
                break
            if limit == 1:
                if drain_item(config, item, groups[item]) == 'rate-limit':
                    break
                continue
            # Linearize admission against provider pause writes under the same
            # existing lock. Neither parent nor child retains it during work.
            with cooldown_write():
                if dispatch_paused(config):
                    break
                pid = os.fork()
            if pid == 0:
                try:
                    outcome = drain_item(config, item, groups[item])
                    code = 2 if outcome == 'rate-limit' else 0
                except BaseException:
                    code = 1
                # Do not run the coordinator's finally/atexit handlers in a child.
                try:
                    sys.stdout.flush()
                    sys.stderr.flush()
                finally:
                    os._exit(code)
            active[pid] = item
    finally:
        while active:
            try:
                reap_item(active)
            except KeyboardInterrupt:
                continue  # keep ownership until every admitted child has exited


def reap_completed(active):
    """Collect every currently completed owned child before new admission."""
    failed, reaped = False, False
    for pid, item in list(active.items()):
        found, status = os.waitpid(pid, os.WNOHANG)
        if found:
            del active[pid]
            reaped = True
            if status:
                code = os.waitstatus_to_exitcode(status)
                message = ('provider pause; stopping new admission' if code == 2 else
                           'worker exited with code ' + str(code) if code >= 0 else
                           'worker terminated by signal ' + str(-code))
                print('repair item ' + item + ': ' + message, flush=True)
                failed = True
    return failed, reaped


def reap_item(active):
    """Wait for owned children only; aggregate failures from the whole poll."""
    while True:
        failed, reaped = reap_completed(active)
        if reaped:
            return failed
        time.sleep(0.1)


def process_item(config, jobs):
    # Each finding has its own worktree; successful commits chain by base.
    item = jobs[0]['item']
    base = jobs[0]['repair_base']
    jobs.sort(key=finding_order)
    last_run = None
    for job in jobs:
        if blocked(config['repair']):
            break  # never start a new finding inside the GLM peak window
        if dispatch_paused(config):
            return 'rate-limit'  # no model call anywhere while the pause marker is live
        try:
            require_canonical_delivery(ROOT, job)
        except ValueError as exc:
            print('repair ' + job['job'] + ': skipped: ' + str(exc))
            continue
        if job['run'] != last_run:
            base = job['repair_base']
            last_run = job['run']
        job['repair_base'] = base
        wt = Path(config['worktree_root']) / ('crq-repair-' + item + '-' + job['job'])
        if not wt.exists():
            p = command(['git', 'worktree', 'add', '--detach', str(wt), base], cwd=config['clone'])
            if p.returncode:
                raise RuntimeError('repair worktree creation failed')
        res = process(config, job, wt)
        if dispatch_paused(config):
            return 'rate-limit'
        if res.get('retry_after'):
            break
        if res['verdict'] == 'FIXED':
            base = res['commits'][-1]
    return None


def recover_job(config, job_id):
    """Revalidate one failed job; the tick still owns preparation and handoff."""
    import crq as c
    import repair_tick
    from crq_repair import recovery
    from crq_repair.bounded import job_path
    if config['repair']['roles']['judge_critical'].get('driver') != 'cq':
        raise ValueError('recovery requires the CQ structured critical judge')
    job = json.loads(job_path(ROOT, job_id).read_text())
    def check_owner():
        queue = c.load_queue()
        item = next((i for i in queue.get('items', []) if i.get('id') == job.get('item')), None)
        record = (item or {}).get('repair_runs', {}).get(job.get('run'))
        if not record or job_id not in record.get('jobs', []):
            raise ValueError('job lacks tick-owned repair record')
        if record.get('fix_pr') or record.get('state') in ('published', 'done'):
            raise ValueError('repair already published or superseded')
        fid = job.get('canonical_finding_id')
        if fid:
            if not isinstance(fid, str) or not re.fullmatch(r'[0-9a-f]{64}', fid):
                raise ValueError('invalid canonical finding identity')
            row = json.loads((ROOT / 'state/backfill/findings/triage' / (fid + '.json')).read_text())
            current = row.get('receipt', {}).get('repair_task')
            if row.get('status') == 'needs-human':
                events = repair_tick.finding_inbox(c).publication.retained()
                event = next((e for e in events if e.get('id') == row.get('previous_event_id')), None)
                payload = (event or {}).get('payload', {})
                if (payload.get('actor') != 'crq-repair' or payload.get('finding_id') != fid
                        or payload.get('evidence', {}).get('repair_task') != job_id):
                    raise ValueError('finding requires an explicit owner decision')
            successor = None
            if current and current != job_id:
                try:
                    successor = json.loads(job_path(ROOT, current).read_text())
                except (OSError, ValueError):
                    pass
            if (row.get('status') not in ('delivered', 'needs-human')
                    or (current != job_id and not (successor and successor.get('origin_job') == job_id
                        and successor.get('recovery_worktree') is True))):
                raise ValueError('canonical finding no longer belongs to this repair')
        if record.get('state') == 'stale':
            prefix = 'superseded by prepared retry '
            note = record.get('error', '')
            candidate = None
            if isinstance(note, str) and note.startswith(prefix):
                try:
                    candidate = json.loads(job_path(ROOT, note[len(prefix):]).read_text())
                except (OSError, ValueError):
                    pass
            if not (candidate and candidate.get('origin_job') == job_id
                    and candidate.get('recovery_worktree') is True):
                raise ValueError('repair already superseded')
    if not c.ran_locked(check_owner):
        raise RuntimeError('tick busy; recovery deferred')
    def judge(old, context, directory):
        request = {'job': old['job'], 'run': old['run'], 'triage_context': context}
        return dispatch(config, config['repair']['roles']['judge_critical'], request,
                        config['clone'], directory / 'recovery-judge', judge=True)
    def prepare(old_id, tip, evidence):
        output = []
        def locked():
            check_owner()
            output.append(repair_tick.prepare_current_job(c, c.load_queue(), old_id, tip, evidence,
                                                          preserve_worktree=True))
        if not c.ran_locked(locked):
            raise RuntimeError('tick busy; recovery preparation deferred')
        return output[0]
    def scan(context, output):
        patch = context['retained_patch']
        if patch and not c.secret_scan_diff(patch, output.with_name('recovery-patch-scan.json'))[0]:
            return False
        for index, retained in enumerate(context['retained_attempts']):
            for part, patch in enumerate(retained['patches']):
                if patch and not c.secret_scan_diff(patch, output.with_name(
                        'recovery-attempt-' + str(index) + '-' + str(part) + '-scan.json'))[0]:
                    return False
        contract = context['current_contract']
        if contract['text']:
            path = contract['path']
            diff = 'diff --git a/' + path + ' b/' + path + '\n@@ -0,0 +1 @@\n'
            diff += '\n'.join('+' + line for line in contract['text'].splitlines()) + '\n'
            if not c.secret_scan_diff(diff, output.with_name('recovery-contract-scan.json'))[0]:
                return False
        return triage_context_safe(c, context, output)
    return recovery.recover(ROOT, config, job_id, scan, judge, prepare)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Drain eligible repair inbox jobs, or repair one explicit prepared job')
    parser.add_argument('--triage-dry-run', action='store_true')
    parser.add_argument('--job')
    parser.add_argument('--source-sha')
    parser.add_argument('--finding-sha256')
    parser.add_argument('--recover-job')
    args = parser.parse_args(argv)
    config = json.loads((ROOT / 'config.json').read_text())
    repair = config.get('repair', {})
    authorization = repair.get('spend_authorization')
    if repair.get('enabled') is not True or not isinstance(authorization, str) or not authorization.strip():
        print('repair dispatch disabled: repair.enabled and a recorded spend_authorization are required')
        return
    if args.triage_dry_run:
        triage_phase(config, dry_run=True)
        return
    selectors = (args.job, args.source_sha, args.finding_sha256)
    if args.recover_job and (any(selectors) or args.triage_dry_run):
        print('repair dispatch refused: recovery selects exactly one job')
        return
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
            and not os.environ.get('ZAI_API_KEY') and not any(
                provider_ready(candidate) for role in repair['roles'].values()
                for candidate in fallback_roles(config, role)[1:]):
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
        if args.recover_job:
            until = dispatch_paused(config)
            if until:
                print('repair recovery paused: provider rate limit until ' + until)
                return
            error = fetch_clone(config)
            if error:
                print('repair recovery deferred: ' + error[:200])
                return
            result = recover_job(config, args.recover_job)
            if result.get('report', {}).get('stop') == 'rate-limit':
                rate_limit_pause(result['report'], args.recover_job)
            print('repair recovery: ' + json.dumps(result))
            return
        if all(selectors):
            job = select_job(ROOT, config, args.job, args.source_sha, args.finding_sha256)
            process_item(config, [job])
            return
        drain(config)


if __name__ == '__main__':
    main()
