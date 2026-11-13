"""Tick-owned inbox, result harvesting and publication. No model dispatch."""
from runtime_target import DEFAULT_BRANCH, DEFAULT_REF
import repo_registry
import review_receipt
import copy
import json
from pathlib import Path
import re
from crq_repair import (DetectorUnavailable, atomic, findings, git as wt_git,
                         hack_detector, verify)
from crq_repair.bounded import JOB_ID, identity, job_path, require_canonical_delivery, source_path, validate_revalidation


# The fixer ladder crq_repair.process runs is exactly A0-A2; digest keys its
# fixed counts on these rungs, so nothing else may be recorded as a fix.
FIXED_RUNGS = ('A0', 'A1', 'A2')


def scan_fix_instructions(c, instructions, source_sha, scan_path):
    """Validate and scan the exact bounded guidance before binding it to a job."""
    if (not isinstance(instructions, str) or not instructions.strip()
            or len(instructions) > 2000 or '\x00' in instructions):
        raise ValueError('fix instructions must contain 1..2000 characters without NUL')
    lines = instructions.split('\n')
    patch = ('diff --git a/crq-fix-instructions.txt b/crq-fix-instructions.txt\n'
             '--- /dev/null\n+++ b/crq-fix-instructions.txt\n'
             '@@ -0,0 +1,' + str(len(lines)) + ' @@\n'
             + '\n'.join('+' + line for line in lines) + '\n')
    clean, _ = c.secret_scan_diff(patch, scan_path, base=None, head=source_sha)
    if not clean:
        raise ValueError('fix instructions secret scan failed')


def prepare_current_job(c, q, old_job_id, source_sha, evidence, *, preserve_worktree=False):
    """Locked operator preparation, not dispatch or a historical-job disposition."""
    old = json.loads(job_path(c.ROOT, old_job_id).read_text())
    if old.get('job') != old_job_id:
        raise ValueError('historical job identity mismatch')
    validate_revalidation(c.CONFIG, old, source_sha, evidence)
    instructions = evidence.get('fix_instructions')
    if 'fix_instructions' in evidence and (not isinstance(instructions, str) or not instructions.strip()
                                     or len(instructions) > 2000 or '\x00' in instructions):
        raise ValueError('fix instructions must contain 1..2000 characters without NUL')
    item = next(i for i in q['items'] if i['id'] == old['item'])
    old_record = item.get('repair_runs', {}).get(old['run'])
    if not old_record or old_job_id not in old_record.get('jobs', []):
        raise ValueError('historical finding lacks tick-owned repair evidence')
    binding = {'origin_job': old_job_id, 'source_sha': source_sha, 'evidence': evidence}
    if preserve_worktree:
        binding['preserve_worktree'] = True
    token = identity(binding)[:24]
    run = 'revalidated-' + token
    job_id = 'crq-' + run + '-F1'
    existing = item.get('repair_runs', {}).get(run)
    if existing:
        if old.get('canonical_finding_id'):
            job = json.loads(job_path(c.ROOT, job_id).read_text())
            finding_inbox(c).handoff(old['canonical_finding_id'], old_job_id, job, c.iso())
        return job_id
    if old.get('canonical_finding_id'):
        from finding_delivery import canonical_rounds
        count = canonical_rounds(c.ROOT, q, old['canonical_finding_id'], source_sha)
    else:
        history = [r for i in q['items'] if i.get('pr') == item.get('pr')
                   for r in i.get('repair_runs', {}).values()]
        count = sum(r.get('pin') == source_sha for r in history)
    if count >= c.CONFIG['repair'].get('max_rounds_per_pin', 2):
        raise ValueError('repair round ceiling reached for current source pin')
    # Scan the FULL pinned file, not just the tip commit's changed lines.
    # The same path-scoped denylist and gitleaks policy precedes any model use.
    source_file = source_path(old['finding'])
    text = c.run(['git', 'show', source_sha + ':' + source_file], cwd=c.CLONE).stdout
    patch = 'diff --git a/' + source_file + ' b/' + source_file + '\n--- /dev/null\n+++ b/' + source_file + '\n'
    patch += '@@ -0,0 +1,' + str(len(text.splitlines())) + ' @@\n'
    patch += '\n'.join('+' + line for line in text.splitlines()) + '\n'
    scan_path = c.STATE / 'repair/preparation' / (run + '-secret-scan.json')
    scan_path.parent.mkdir(parents=True, exist_ok=True)
    clean, _ = c.secret_scan_diff(patch, scan_path, base=None, head=source_sha)
    if not clean:
        raise ValueError('current-tip preparation secret scan failed')
    if instructions is not None:
        scan_fix_instructions(c, instructions, source_sha, scan_path.with_name(run + '-instructions-scan.json'))
    job = {**old, 'job': job_id, 'run': run, 'cycle': None, 'kind': 'merged',
           'repair_base': source_sha, 'branch': None, 'repair_round': count + 1,
           'origin_job': old_job_id, 'source_sha': source_sha,
           'finding_sha256': identity(old['finding']), 'revalidation': evidence,
           'prior': None, 'recurrence': False,
           'source': {**old.get('source', {}), 'run': old.get('source', {}).get('run', old['run'])}}
    if preserve_worktree:
        job['recovery_worktree'] = True
    atomic(job_path(c.ROOT, job_id), job)
    if old.get('canonical_finding_id'):
        finding_inbox(c).handoff(old['canonical_finding_id'], old_job_id, job, c.iso())
    if ((old.get('canonical_finding_id') or preserve_worktree)
            and old_record.get('jobs') == [old_job_id]
            and old_record.get('state') in ('queued', 'ready', 'publish_failed')
            and not old_record.get('fix_pr')):
        old_record.update(state='stale', error='superseded by prepared retry ' + job_id)
    item.setdefault('repair_runs', {})[run] = {
        'jobs': [job_id], 'pin': source_sha, 'base': source_sha, 'branch': None,
        'open_pr': False, 'round': count + 1, 'state': 'queued',
        'origin_job': old_job_id, 'revalidation_sha256': identity(evidence)}
    if old.get('canonical_finding_id'):
        item['repair_runs'][run]['canonical_finding_id'] = old['canonical_finding_id']
    c.save_queue(q)
    return job_id


def own_range(c, q, base, head):
    commits = c.git('rev-list', base + '..' + head).splitlines()
    owned = set(q.get('repair_own_commits', []))
    return bool(commits) and set(commits) <= owned


def merged_current_enabled(c):
    return ((c.CONFIG.get('repair') or {}).get('merged_current') or {}).get('enabled') is True


def enqueue(c, q, item, meta, rdir):
    if (item.get('kind') == 'local-review' or meta.get('kind') == 'local-review'
            or any(cycle.get('source') == 'local-review' and cycle.get('run_id') == meta.get('run_id')
                   for cycle in item.get('cycles', []))):
        return False
    if not repo_registry.same_repo(c.item_repo(item), c.REPO):
        # The repair drain never runs for non-primary repositories.
        return False
    if item['kind'] == review_receipt.KIND:
        if not merged_current_enabled(c):
            return False
        # Require complete supported finding scope, not a partial repair of a mixed receipt.
        doc = json.loads((c.STATE / 'receipts' / (item['receipt_id'] + '.json')).read_bytes())
        if (doc.get('outcome') != 'terminal-with-findings' or not doc.get('findings')
                or any(f.get('severity') not in ('critical', 'major') for f in doc['findings'])):
            return False
    existing = item.setdefault('repair_runs', {}).get(meta['run_id'])
    sourced = findings(rdir / 'review.ndjson', provenance=True)
    sources = [f.pop('_source', {}) for f in sourced]
    actionable = sourced
    for source in sources:
        source['run'] = meta['run_id']
    if existing:
        for job_id in existing.get('jobs', []):
            path = c.STATE / 'repair/inbox' / (job_id + '.json')
            if not path.exists():
                continue
            job = json.loads(path.read_text())
            matches = [source for finding, source in zip(actionable, sources) if finding == job.get('finding')]
            if len(matches) == 1 and not job.get('source'):
                job['source'] = matches[0]
                atomic(path, job)
        return existing['state'] in ('queued', 'ready', 'publish_failed')
    if not actionable:
        return False
    if own_range(c, q, meta['base'], meta.get('pr_head', meta['head'])):
        return False
    pin = meta.get('review_pin') or item.get('pinned_base') or meta['base']
    # Delta items are separate queue entries but share a PR/pin repair ceiling.
    history = [r for i in q['items'] if i.get('pr') == item.get('pr')
               for r in i.get('repair_runs', {}).values()]
    count = sum(r.get('pin') == pin for r in history)
    if count >= c.CONFIG['repair'].get('max_rounds_per_pin', 2):
        item['last_error'] = 'repair round ceiling reached; needs human'
        return False
    open_pr = item['kind'] in ('open', 'delta') and bool(meta.get('pr_branch'))
    base = (item['capture']['target'] if item['kind'] == review_receipt.KIND else
            meta.get('pr_head', meta['head']) if open_pr else c.git('rev-parse', DEFAULT_REF))
    if not open_pr and item['kind'] != review_receipt.KIND:
        # An interrupted enqueue can leave inbox jobs whose base predates a
        # moved default-branch tip; adopt it so harvest's predecessor check holds.
        for n, finding in enumerate(actionable, 1):
            old = c.STATE / 'repair/inbox' / ('crq-' + meta['run_id'] + '-F' + str(n) + '.json')
            if old.exists():
                prev = json.loads(old.read_text())
                if prev.get('finding') == finding and prev.get('repair_base'):
                    base = prev['repair_base']
                    break
    record = {'jobs': [], 'pin': pin, 'base': base, 'branch': meta.get('pr_branch'),
              'open_pr': open_pr, 'round': count + 1, 'state': 'queued'}
    reviewed_diff = c.git('diff', meta['base'], meta['head'])
    if not JOB_ID.fullmatch('crq-' + meta['run_id'] + '-F1'):
        # bounded.job_path refuses such ids, so the job would never drain.
        item['last_error'] = 'repair not enqueued: run id outside the job-id grammar'
        return False
    for n, finding in enumerate(actionable, 1):
        job_id = 'crq-' + meta['run_id'] + '-F' + str(n)
        prior = [v for r in history for v in r.get('verdicts', [])
                 if v.get('verdict') == 'NOT-FIXED' and v.get('finding', {}).get('path') == finding['path']
                 and v.get('finding', {}).get('severity') == finding['severity']]
        job = {'job': job_id, 'item': item['id'], 'kind': item['kind'], 'pr': item['pr'],
               'run': meta['run_id'], 'cycle': meta.get('cycle'), 'repair_base': base,
               'branch': record['branch'], 'finding': finding, 'repair_round': count + 1,
               'prior': prior[-1] if prior else None, 'recurrence': bool(prior),
               'review_diff': reviewed_diff, 'source': sources[n - 1]}
        path = c.STATE / 'repair/inbox' / (job_id + '.json')
        if not path.exists():
            atomic(path, job)
        else:
            prev = json.loads(path.read_text())
            if not prev.get('source') and prev.get('finding') == finding:
                prev['source'] = sources[n - 1]
                atomic(path, prev)
            if ((prev.get('repair_base') != base or prev.get('finding') != finding)
                    and not (c.STATE / 'repair' / job_id / 'result.json').exists()):
                # Stale orphan that never ran: rebind to this record.
                atomic(path, job)
        record['jobs'].append(job_id)
        for blocker in item.get('blocking', []):
            if blocker.get('run') == meta['run_id'] and blocker.get('run_finding') == n:
                blocker['repair_job'] = job_id
    if item['kind'] == review_receipt.KIND:
        record['receipt_id'] = item['receipt_id']
        record['receipt_findings'] = sorted(review_receipt.digest(f) for f in doc['findings'])
        record['repair_findings'] = sorted(review_receipt.digest(f) for f in actionable)
    item['repair_runs'][meta['run_id']] = record
    return True


def finding_inbox(c):
    import backfill_runtime
    import finding_delivery
    import review_ledger as ledger
    config = backfill_runtime.settings(c.STATE)
    if not config:
        raise ValueError('backfill repair write-back requires existing ledger configuration')
    store = ledger.ArtifactStore(config['durable_artifact_root'])
    return finding_delivery.Inbox(c.STATE / 'backfill/findings',
                                  ledger.Outbox(c.STATE / 'backfill/publication', store))


def mark_finding_outcome(c, job, result, merge=None, fix_pr=None):
    """The source finding ledger remains authoritative for threadless repairs."""
    fid = job.get('canonical_finding_id')
    if not fid:
        return
    verdict = result['verdict']
    failure_class = result.get('failure_class', 'exhausted')
    if failure_class not in ('transient', 'exhausted', 'evidence', 'protected-path', 'owner-decision'):
        failure_class = 'exhausted'
    action = 'fixed' if merge and verdict == 'FIXED' else {
        'STALE': 'needs-retriage', 'FAILED': 'needs-human' if failure_class == 'owner-decision' else 'needs-retriage'}.get(verdict)
    if verdict == 'NOT-FIXED':
        action = 'dismissed' if result.get('unchanged_evidence') else ('needs-human' if failure_class == 'owner-decision' else 'needs-retriage')
    if not action:
        return
    inbox = finding_inbox(c)
    inbox.repair_outcome(fid, job['job'], action, result.get('reason') or verdict,
                         c.iso(), fixing_commit=merge, fix_pr=fix_pr, failure_class=failure_class,
                         repair_base=job.get('repair_base'),
                         max_finding_retries=c.CONFIG['repair'].get('max_finding_retries', 2),
                         **({'source_evidence': result['unchanged_evidence']} if result.get('unchanged_evidence') else {}))


def repair_provenance(c, record, run):
    import review_ledger as ledger
    reviews = None
    lines = ['', 'Source run: `' + run + '`', '', '| finding ID | source ledger/review | source |',
             '|---|---|---|']
    for job_id in record['jobs']:
        job = json.loads((c.STATE / 'repair/inbox' / (job_id + '.json')).read_text())
        finding = job.get('finding', {})
        fid = job.get('canonical_finding_id') or finding.get('id') or finding.get('source_id') or job.get('source', {}).get('id') or job.get('source', {}).get('source_id') or job_id
        source = job.get('review_id') or job.get('source', {}).get('review_id') or job.get('source', {}).get('run') or job.get('run') or run
        job_file = c.STATE / 'repair/inbox' / (job_id + '.json')
        source_run = job.get('source', {}).get('run') or job.get('run') or run
        raw = c.STATE / 'runs' / source_run / 'review.ndjson'
        local = raw if raw.exists() else job_file
        link = ('https://github.com/' + c.REPO + '/pull/' + str(job['pr'])) if job.get('pr') else 'threadless; local source `' + str(local.relative_to(c.STATE.parent)) + '`'
        if job.get('canonical_finding_id'):
            row = c.STATE / 'backfill/findings/triage' / (fid + '.json')
            local = row if row.exists() else job_file
            link = 'threadless; local source `' + str(local.relative_to(c.STATE.parent)) + '`'
            if reviews is None:
                try:
                    reviews = {v['id']: v for v in finding_inbox(c).publication.retained()
                               if isinstance(v, dict) and v.get('event_type') == 'review'}
                except (OSError, ValueError, KeyError):
                    reviews = {}
            value = reviews.get(job.get('review_id') or job.get('source', {}).get('review_id'))
            if value:
                try:
                    ledger.validate(value)
                    if value['payload']['repo'] == c.REPO and any(f['id'] == fid for f in value['payload']['findings']):
                        link = '[ledger review](https://github.com/' + c.REPO + '/blob/cq/review-ledger/' + ledger.record_path(value) + ')'
                except (ValueError, KeyError, TypeError):
                    pass  # Keep an accurate local locator; never invent a ledger URL.
        lines.append('| `' + str(fid) + '` | `' + str(source) + '` | ' + link + ' |')
    return lines


def record_terminal_failure(c, q, item, record, verdicts, expected, job_id, exc):
    """Shared terminal path for a deterministic repair artifact defect: it can
    never pass on a later tick, so record the failure instead of blocking the
    item on a retried identical result."""
    failure = {'job': job_id, 'item': item['id'], 'verdict': 'FAILED',
               'reason': 'invalid repair result: ' + str(exc)[:300],
               'finding': expected['finding']}
    record['verdicts'] = verdicts + [failure]
    record.update(state='failed', error=str(exc)[:300])
    if item['kind'] == review_receipt.KIND:
        item['state'] = 'done'
        item['repair_outcome'] = record['state']
        item['last_error'] = None
    else:
        item['state'] = 'repair_failed'
        item['last_error'] = 'repair_failed; needs human'
    c.save_queue(q)  # terminal identity before authoritative write-back
    mark_finding_outcome(c, expected, failure)
    record_unpublished_siblings(c, record, {job_id})


def record_unpublished_siblings(c, record, handled):
    """A failed run can never publish. A FIXED sibling records no outcome of
    its own (only publication fixes a finding), so give each verified sibling an
    explicit decision instead of leaving it bound to a dead run. `handled` are
    the jobs whose own outcome the caller records. Idempotent, so the terminal
    replay path can repeat it after a failed ledger write."""
    for other in record.get('jobs') or ():
        if other in handled or not isinstance(other, str):
            continue
        try:
            result = json.loads((c.STATE / 'repair' / other / 'result.json').read_text())
            job = json.loads((c.STATE / 'repair/inbox' / (other + '.json')).read_text())
        except (OSError, ValueError):
            continue
        if not isinstance(result, dict) or not isinstance(job, dict):
            continue
        if result.get('verdict') != 'FIXED' or not job.get('canonical_finding_id'):
            continue
        finding_inbox(c).repair_outcome(
            job['canonical_finding_id'], other, 'needs-human',
            'repair run failed before publication; the verified fix was not published',
            c.iso(), repair_base=job.get('repair_base'), failure_class='exhausted')


def harvest(c, q, item, dry=False):
    messages = []
    for run, record in item.get('repair_runs', {}).items():
        if record['state'] in ('published', 'done', 'failed', 'stale'):
            # A terminal local failure can outlive a failed ledger write. Replay
            # retained FAILED outcomes through the ledger's idempotent event chain.
            if not dry and record['state'] == 'failed':
                handled = set()
                for result in record.get('verdicts', []):
                    if (result.get('verdict') != 'FAILED'
                            or not result.get('reason', '').startswith('invalid repair result: ')):
                        continue
                    if result.get('job') not in record['jobs'] or result.get('item') != item['id']:
                        raise ValueError('terminal repair outcome identity mismatch')
                    expected = json.loads((c.STATE / 'repair/inbox' / (result['job'] + '.json')).read_text())
                    if expected.get('job') != result['job'] or expected.get('item') != item['id']:
                        raise ValueError('terminal repair job identity mismatch')
                    handled.add(result['job'])
                    if expected.get('canonical_finding_id'):
                        c.save_queue(q)  # also retry any prior failed terminal save
                        mark_finding_outcome(c, expected, result)
                # A write-back that failed before the sibling decision is replayed
                # here; every sibling decision is idempotent.
                record_unpublished_siblings(c, record, handled)
            if not dry and record.get('verdicts') and hasattr(c, 'WT_ROOT') and hasattr(c, 'CLONE'):
                from crq_repair.retain import cleanup_harvested
                for result in record['verdicts']:
                    if not isinstance(result, dict):
                        continue
                    job_id = result.get('job', '')
                    if isinstance(job_id, str) and JOB_ID.fullmatch(job_id):
                        try:
                            for alternate in (False, True):
                                cleanup_harvested(c.CLONE, c.WT_ROOT, c.STATE / 'repair' / job_id,
                                                  item['id'], job_id, result, alternate=alternate)
                        except (OSError, ValueError, KeyError, TypeError, RuntimeError) as exc:
                            messages.append('repair cleanup ' + job_id + ': ' + str(exc)[:300])
            # Reconcile atomically persisted publication after a caller crash.
            if item['kind'] == review_receipt.KIND:
                item['state'] = 'done'
                item['repair_outcome'] = record['state']
                item['last_error'] = None
            elif item.get('state') == 'repairing':
                item['state'] = 'repair_failed' if record['state'] == 'failed' else 'done'
            continue
        if record['state'] not in ('queued', 'ready', 'publish_failed'):
            continue
        verdicts = []
        predecessor = record['base']
        for job_id in record['jobs']:
            path = c.STATE / 'repair' / job_id / 'result.json'
            if not path.exists():
                break
            expected = json.loads((c.STATE / 'repair/inbox' / (job_id + '.json')).read_text())
            try:
                require_canonical_delivery(c.STATE.parent, expected)
            except ValueError as exc:
                if not dry:
                    record.update(state='stale', error=str(exc))
                    item['state'] = 'done'
                break  # Retain the result artifact without publishing an obsolete fix.
            try:
                result = json.loads(path.read_text())
                if not isinstance(result, dict):
                    raise ValueError('repair result must be an object')
                if result.get('retry_after'):
                    break
                if result.get('job') != job_id or result.get('item') != item['id']:
                    raise ValueError('repair result identity mismatch')
                if expected.get('source_sha') and any(result.get(k) != expected.get(k)
                        for k in ('source_sha', 'finding_sha256', 'origin_job')):
                    raise ValueError('prepared repair result source/evidence binding mismatch')
                if result.get('verdict') == 'FIXED':
                    commits = result.get('commits')
                    if (not isinstance(commits, list) or not commits
                            or not all(isinstance(sha, str) and re.fullmatch(r'[0-9a-fA-F]{40}', sha)
                                       for sha in commits)):
                        raise ValueError('repair result claims FIXED without valid commits')
                    attempts = result.get('attempts')
                    final = attempts[-1] if isinstance(attempts, list) and attempts else None
                    if not isinstance(final, dict) or final.get('rung') not in FIXED_RUNGS:
                        raise ValueError('repair fixed result lacks a valid final attempt rung')
                    wt = Path(result['worktree']).resolve()
                    root = c.WT_ROOT.resolve()
                    legacy_name = 'crq-repair-' + item['id']
                    scoped_name = legacy_name + '-' + job_id
                    if wt.parent != root or wt.name not in (legacy_name, scoped_name, scoped_name + '-A2'):
                        raise ValueError('repair result worktree outside owned path')
                    if result.get('repair_base') != predecessor:
                        raise ValueError('repair predecessor mismatch')
                elif result.get('verdict') not in ('NOT-FIXED', 'FAILED', 'STALE'):
                    raise ValueError('unknown repair verdict')
            except (ValueError, IndexError, KeyError, TypeError) as exc:
                # A deterministic artifact defect can never pass on a later tick,
                # so record it as a terminal failure instead of blocking the item.
                if not dry:
                    record_terminal_failure(c, q, item, record, verdicts, expected, job_id, exc)
                break
            if result.get('verdict') == 'FIXED' and not dry:
                # Later findings move the shared HEAD; validate each immutable
                # claimed range through a separate detached verification worktree.
                check_wt, branch = c.make_worktree('verify-' + job_id, commits[-1])
                try:
                    verify(check_wt, predecessor, commits, job_id)
                    from importlib import util
                    spec = util.spec_from_file_location('crq_repair_service', c.ROOT / 'crq_repair.py')
                    module = util.module_from_spec(spec)
                    spec.loader.exec_module(module)
                    module.mechanical(c.CONFIG, check_wt, predecessor, commits, job_id, path.parent)
                except DetectorUnavailable:
                    # The detector never rendered a verdict; keep it on the
                    # retry path, as RuntimeError from git() already is.
                    raise
                except ValueError as exc:
                    # A rejected claimed range is deterministic (duplicate
                    # commits, oversize or flagged diff), so record the same
                    # terminal failure as a defective result artifact.
                    record_terminal_failure(c, q, item, record, verdicts, expected, job_id, exc)
                    break
                finally:
                    c.remove_worktree(check_wt, branch)
                predecessor = commits[-1]
            if not dry:
                mark_finding_outcome(c, expected, result)
            verdicts.append({**result, 'finding': expected['finding']})
        if len(verdicts) != len(record['jobs']):
            continue
        if dry:
            messages.append('would harvest repair ' + run)
            continue
        record['verdicts'] = verdicts
        record['state'] = 'ready'
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
        if item['kind'] == review_receipt.KIND:
            item['state'] = 'done'
            item['repair_outcome'] = record['state']
            item['last_error'] = None
        else:
            item['state'] = 'repair_failed' if record['state'] in ('failed', 'publish_failed') else 'done'
        messages.append(item['id'] + ': repair ' + record['state'])
    return messages


def publish(c, q, item, run, record, fixed):
    journal = c.STATE / 'repair' / record['jobs'][0] / 'publication.json'
    if journal.exists():
        publication = json.loads(journal.read_text())
        recover_publication(c, q, item, run, record, publication)
        return
    commits = [sha for v in fixed for sha in v['commits']]
    # Re-read GitHub pin immediately before publishing; never force push.
    info = c.pr_info(item['pr']) if record['open_pr'] else None
    if info and info['state'] != 'OPEN':
        record.update(state='stale', error='PR closed or merged before repair publication')
        return
    target = info['headRefOid'] if info else c.git('rev-parse', DEFAULT_REF)
    if info and not c.is_ancestor(record['base'], target):
        record.update(state='stale', error='head moved non-fast-forward; await new pin review')
        return
    wt, branch = c.make_worktree('publish-' + run, target)
    try:
        translated = []
        for v in fixed:
            before = wt_git(wt, 'rev-parse', 'HEAD')
            try:
                for sha in v['commits']:
                    wt_git(wt, 'cherry-pick', sha)
            except RuntimeError as exc:
                # Only a recorded cherry-pick with conflicts or an empty index
                # proves a deterministic replay failure. Spawn, timeout, hook,
                # and other git failures must remain retryable.
                try:
                    wt_git(wt, 'rev-parse', '--verify', 'CHERRY_PICK_HEAD')
                except RuntimeError:
                    raise exc
                conflicts = wt_git(wt, 'diff', '--name-only', '--diff-filter=U')
                staged = wt_git(wt, 'diff', '--cached', '--name-only')
                if conflicts or not staged:
                    record.update(state='stale',
                                  error='repair does not apply to current target: ' + str(exc)[:200])
                    return
                raise
            claims = wt_git(wt, 'rev-list', '--reverse', before + '..HEAD').splitlines()
            verify(wt, before, claims, v['job'])
            translated.extend(claims)
        # Re-run content scan and secret scan over final rebased publication.
        from importlib import util
        spec = util.spec_from_file_location('crq_repair_service', c.ROOT / 'crq_repair.py')
        module = util.module_from_spec(spec)
        spec.loader.exec_module(module)
        patch = c.STATE / 'repair' / record['jobs'][0] / 'publication.patch'
        diff = wt_git(wt, 'diff', target + '..HEAD')
        patch.write_text(diff + '\n')
        try:
            hack_detector(c.CONFIG['repair']['cq_bin'], diff, wt)
        except ValueError as exc:
            raise ValueError('publication ' + str(exc)) from None
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
        publication = {'head': head, 'target': target, 'branch': remote_branch,
                       'commits': translated, 'open_pr': bool(info), 'at': c.iso()}
        journal = c.STATE / 'repair' / record['jobs'][0] / 'publication.json'
        c.git('update-ref', 'refs/crq/publication/' + run, head)
        atomic(journal, publication)
        record['publication'] = publication
        c.save_queue(q)  # durable identity before any remote mutation
        c.git('push', 'origin', 'HEAD:refs/heads/' + remote_branch, cwd=wt)
        finalize_publication(c, q, item, run, record, publication)
    finally:
        c.remove_worktree(wt, branch)


def recover_publication(c, q, item, run, record, publication):
    head, branch = publication['head'], publication['branch']
    remote = c.git('ls-remote', '--heads', 'origin', 'refs/heads/' + branch)
    remote_head = remote.split()[0] if remote else None
    if publication['open_pr']:
        info = c.pr_info(item['pr'])
        if info['state'] != 'OPEN' or info['headRefName'] != branch:
            record.update(state='stale', error='PR no longer publishable')
            return
        if info['headRefOid'] == head or c.is_ancestor(head, info['headRefOid']):
            finalize_publication(c, q, item, run, record, publication)
            return
        if info['headRefOid'] != publication['target']:
            record.update(state='stale', error='head moved after prepared publication; needs new review')
            return
    else:
        prs = c.gh_json(['pr', 'list', '--repo', c.REPO, '--head', branch, '--state', 'all', '--json', 'number,url,state,headRefOid'])
        if prs:
            if len(prs) != 1 or prs[0]['headRefOid'] != head:
                raise ValueError('fix PR identity or prepared head mismatch')
            finalize_publication(c, q, item, run, record, publication)
            return
    if not publication['open_pr'] and remote_head and remote_head != head:
        raise ValueError('existing fix branch differs from prepared publication')
    if remote_head != head:
        # Immutable publication SHA survives retries via refs/crq/publication.
        c.git('push', 'origin', head + ':refs/heads/' + branch)
    finalize_publication(c, q, item, run, record, publication)


def finalize_publication(c, q, item, run, record, publication):
    record['publication'] = publication
    translated, head, branch = publication['commits'], publication['head'], publication['branch']
    owned = q.setdefault('repair_own_commits', [])
    owned.extend(sha for sha in translated if sha not in owned)
    record['published_commits'] = translated
    if publication['open_pr']:
        item['last_push'] = {'sha': head, 'shas': translated, 'at': c.iso()}
        record['fix_pr'] = {'number': item['pr'], 'url': 'https://github.com/' + c.REPO + '/pull/' + str(item['pr'])}
    else:
        prs = c.gh_json(['pr', 'list', '--repo', c.REPO, '--head', branch, '--state', 'all', '--json', 'number,url,state'])
        if not prs:
            if publication.get('pr_create_pending'):
                raise ValueError('previous PR creation outcome unknown; reconcile existing PR before retry')
            body = ['Verified CodeRabbit repairs from ' + run, '', '| finding | verdict | reason |', '|---|---|---|']
            for v in record['verdicts']:
                body.append('| ' + v['job'] + ' | ' + v['verdict'] + ' | ' + v['reason'].replace('|', r'\|').replace('\n', ' ') + ' |')
            body.extend(repair_provenance(c, record, run))
            path = c.STATE / 'repair' / record['jobs'][0] / 'fix-pr.md'
            path.write_text('\n'.join(body) + '\n')
            publication['pr_create_pending'] = True
            atomic(c.STATE / 'repair' / record['jobs'][0] / 'publication.json', publication)
            c.save_queue(q)
            c.run(['gh', 'pr', 'create', '--repo', c.REPO, '--base', DEFAULT_BRANCH, '--head', branch,
                   '--title', 'fix: Address CodeRabbit findings from ' + run, '--body-file', str(path)])
            prs = c.gh_json(['pr', 'list', '--repo', c.REPO, '--head', branch, '--state', 'all', '--json', 'number,url,state'])
        if len(prs) != 1:
            raise ValueError('fix PR identity is ambiguous')
        pr = prs[0]
        record['fix_pr'] = pr
        if not any(i['pr'] == pr['number'] and i['kind'] == 'open' for i in q['items']):
            c.new_item(q, [], False, id='pr' + str(pr['number']), pr=pr['number'], kind='open', tier=1,
                       prior_cycles=2 - c.CONFIG['repair'].get('fix_pr_cycles', 1), repair_origin=run,
                       why='verified repair fix PR')
    record['state'] = 'published'
    item['state'] = 'done'
    c.save_queue(q)


def backfill(c, q):
    if q.get('legacy_repair_backfilled'):
        return
    missing = []
    for item in q['items']:
        if not repo_registry.same_repo(c.item_repo(item), c.REPO):
            # Foreign cycles are review evidence, never legacy repair debt.
            continue
        for cycle in item.get('cycles', []):
            if cycle.get('source') == 'local-review':
                continue
            run = cycle['run_id']
            path = c.RUNS / run
            if not (path / 'meta.json').exists() or not (path / 'review.ndjson').exists():
                # No evidence means no verdict and no archive permission.
                if cycle.get('findings') or cycle.get('severity_counts') or item.get('blocking') or run.startswith('signer:'):
                    missing.append({'item': item['id'], 'run': run})
                continue
            meta = json.loads((path / 'meta.json').read_text())
            if meta.get('kind') == 'local-review':
                continue
            queued = enqueue(c, q, item, meta, path)
            if not queued and run not in item.get('repair_runs', {}) and findings(path / 'review.ndjson'):
                if not own_range(c, q, meta['base'], meta.get('pr_head', meta['head'])):
                    missing.append({'item': item['id'], 'run': run, 'reason': item.get('last_error') or 'no repair verdict'})
    q['legacy_repair_missing'] = missing
    if not missing:
        q['legacy_repair_backfilled'] = c.iso()
    # Archive only when all backfilled findings have terminal verdicts.


def archive_legacy(c, q):
    if q.get('legacy_repair_missing') or not q.get('legacy_repair_backfilled'):
        return
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


def reconcile_current_fix(c, item):
    # Revalidate on every tick; a rewritten target must revoke old evidence.
    item.pop('remediation', None)
    if item.get('remediation_state') == 'fixed':
        item['remediation_state'] = 'pending-merged-evidence'
    rid = item.get('receipt_id')
    records = [r for r in item.get('repair_runs', {}).values()
               if r.get('receipt_id') == rid and r.get('state') == 'published'
               and not r.get('not_fixed')]
    if not rid or not records:
        return
    import hashlib
    try:
        data = (c.STATE / 'receipts' / (rid + '.json')).read_bytes()
        if hashlib.sha256(data).hexdigest() != rid:
            return
        doc = json.loads(data)
    except (OSError, ValueError):
        return
    for record in records:
        pr = record.get('fix_pr')
        publication = record.get('publication', {})
        verdicts = record.get('verdicts', [])
        if (not pr or not verdicts or record.get('state') != 'published'
                or any(v.get('verdict') != 'FIXED' for v in verdicts)
                or sorted(v.get('job', '') for v in verdicts) != sorted(record.get('jobs', []))
                or record.get('receipt_id') != rid
                or sorted(review_receipt.digest(v.get('finding')) for v in verdicts) != record.get('repair_findings')
                or len(verdicts) != len(doc.get('findings', []))
                or record.get('receipt_findings') != sorted(review_receipt.digest(f) for f in doc.get('findings', []))):
            continue
        # Merged PR identity is immutable; only target ancestry needs refreshing.
        info = record.get('merged_fix')
        if not info:
            try:
                info = c.pr_info(pr['number'])
            except Exception:
                continue
        if (info.get('state') == 'CLOSED' or
                info.get('state') == 'MERGED' and info.get('headRefOid') != publication.get('head')):
            record['not_fixed'] = {'pr': pr['number'], 'state': info.get('state'),
                                   'head': info.get('headRefOid'), 'reason': 'closed-or-head-mismatch'}
            continue
        if info.get('state') == 'MERGED' and info.get('number') == pr['number']:
            record['merged_fix'] = copy.deepcopy(info)
        selector = item['subject']['target_selector']
        ref = review_receipt.SELECTORS[selector]
        target = c.git('rev-parse', ref)
        merge = (info.get('mergeCommit') or {}).get('oid')
        if (info.get('state') != 'MERGED' or info.get('number') != pr['number']
                or info.get('baseRefName') != ref.removeprefix('origin/')
                or info.get('headRefOid') != publication.get('head') or not merge
                or not c.is_ancestor(merge, target)
                or not c.is_ancestor(doc['capture']['target'], publication.get('target', ''))):
            continue
        evidence = dict(receipt_id=rid, subject=item['subject'], capture_digest=review_receipt.digest(doc['capture']),
                        findings=sorted(review_receipt.digest(f) for f in doc['findings']),
                        fix_pr=pr['number'], merge=merge, head=info['headRefOid'], target=target)
        item['remediation'] = evidence
        if review_receipt.remediation_fixed(item, doc, rid):
            item['remediation_state'] = 'fixed'
            record['merged_fix'] = copy.deepcopy(info)
            return
        item.pop('remediation', None)


def source_thread(c, job):
    source = job.get('source', {})
    explicit = (job.get('source_thread_id') or job.get('thread_id') or
                source.get('source_thread_id') or source.get('thread_id') or
                job.get('finding', {}).get('thread_id'))
    if explicit:
        return explicit
    number = source.get('finding_number')
    if not number or not job.get('pr'):
        return None
    owner, repo = c.REPO.split('/')
    query = ('query($owner:String!,$repo:String!,$pr:Int!,$endCursor:String){'
             'repository(owner:$owner,name:$repo){pullRequest(number:$pr){'
             'reviewThreads(first:100,after:$endCursor){pageInfo{hasNextPage endCursor}'
             'nodes{id comments(first:1){nodes{body path}}}}}}}')
    pages = c.gh_json(['api', 'graphql', '--paginate', '--slurp', '-f', 'query=' + query,
                       '-f', 'owner=' + owner, '-f', 'repo=' + repo, '-F', 'pr=' + str(job['pr'])])
    matches = set()
    for page in pages:
        if page.get('errors'):
            raise ValueError('source thread lookup failed')
        for thread in page['data']['repository']['pullRequest']['reviewThreads']['nodes']:
            for comment in thread['comments']['nodes']:
                if (comment.get('path') == job['finding'].get('path') and
                        comment.get('body', '').startswith('**crq finding F' + str(number) + ' [') and
                        '<sub>crq run `' + source.get('run', job['run']) + '`' in comment.get('body', '')):
                    matches.add(thread['id'])
    if len(matches) > 1:
        raise ValueError('ambiguous source thread; retain publication for retry')
    return next(iter(matches), None)


def publish_source_resolution(c, record, merge):
    """Resume source comments/resolves in the existing publication journal."""
    publication = record.get('publication')
    if not publication:
        return
    journal = c.STATE / 'repair' / record['jobs'][0] / 'publication.json'
    completed = publication.setdefault('source_resolutions', [])
    for result in record.get('verdicts', []):
        if result['verdict'] != 'FIXED' or result['job'] in completed:
            continue
        job = json.loads((c.STATE / 'repair/inbox' / (result['job'] + '.json')).read_text())
        if not job.get('pr'):
            continue  # Threadless source truth is the finding ledger.
        marker = '<!-- crq-repair-source:' + job['job'] + ' -->'
        pages = c.gh_json(['api', 'repos/' + c.REPO + '/issues/' + str(job['pr']) + '/comments',
                           '--paginate', '--slurp'])
        comments = [comment for page in pages for comment in page]
        if not any(marker in comment.get('body', '') for comment in comments):
            body = journal.parent / ('source-' + job['job'] + '.md')
            body.write_text(marker + '\nFixed in [' + merge + '](https://github.com/' + c.REPO + '/commit/' + merge + ').\n')
            c.run(['env', '-u', 'GITHUB_TOKEN', 'gh', 'pr', 'comment', str(job['pr']), '--repo', c.REPO, '--body-file', str(body)])
        thread = source_thread(c, job)
        if thread:
            request = journal.parent / ('resolve-' + job['job'] + '.json')
            atomic(request, {'query': 'mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{isResolved}}}',
                             'variables': {'threadId': thread}})
            response = c.gh_json(['api', 'graphql', '--input', str(request)])
            if response.get('errors') or not response.get('data', {}).get('resolveReviewThread', {}).get('thread', {}).get('isResolved'):
                raise ValueError('source thread resolution unconfirmed')
        completed.append(job['job'])
        atomic(journal, publication)


def repair_test_path(path):
    # Exact classifier from scripts/lib/affected-tests.mjs:isTest; no Python exemption.
    return re.fullmatch(r'(?:test/.*\.test\.(?:ts|mjs)|lint/.*\.test\.ts)', path) is not None


def repair_source_entry(c, head, path):
    raw = c.git('ls-tree', '-z', head, '--', path)
    if not raw:
        return None  # Preserve a published deletion, not just existing blobs.
    header, name = raw.rstrip('\0').split('\t', 1)
    mode, kind, blob = header.split()
    if name != path or kind != 'blob':
        raise ValueError('repair source is not an exact blob path: ' + path)
    return mode, blob


def merge_head_evidence(c, record, actual_head):
    published = record.get('publication', {}).get('head')
    if not published:
        return None  # Preserve legacy reconciliation without a publication journal.
    evidence = {'published_head': published, 'actual_head': actual_head, 'source_blobs': {}}
    if actual_head == published:
        return evidence
    fixed = [v['job'] for v in record.get('verdicts', []) if v['verdict'] == 'FIXED']
    if not actual_head or not fixed or not c.is_ancestor(published, actual_head):
        raise ValueError('merged repair head is not a descendant of the published fix')
    commits = record.get('publication', {}).get('commits')
    if not isinstance(commits, list) or not commits:
        raise ValueError('published repair commits unavailable; needs revalidation')
    anchors = {source_path(json.loads((c.STATE / 'repair/inbox' / (j + '.json')).read_text())['finding']) for j in fixed}
    changed = set()
    for sha in commits:
        if not isinstance(sha, str) or not re.fullmatch(r'[0-9a-f]{40}', sha) or not c.is_ancestor(sha, published):
            raise ValueError('published repair commit lineage unavailable; needs revalidation')
        changed.update(p for p in c.git('diff-tree', '--root', '--no-commit-id', '--name-only',
                                        '--no-renames', '-r', '-z', sha).split('\0') if p)
    paths = anchors | {p for p in changed if not repair_test_path(p)}
    evidence.update(compared_paths=sorted(paths), excluded_test_paths=sorted(changed - paths), source_modes={})
    for path in sorted(paths):
        source_path({'path': path})
        before = repair_source_entry(c, published, path)
        after = repair_source_entry(c, actual_head, path)
        if before != after:
            raise ValueError('merged repair source changed; needs revalidation: ' + path)
        evidence['source_blobs'][path] = before[1] if before else None
        evidence['source_modes'][path] = before[0] if before else None
    return evidence


def fixed_publication_evidence(c, item, run, record, info, evidence):
    """Validate an explicit semantic finding disposition against current observations."""
    fixed = [v['job'] for v in record.get('verdicts', []) if v['verdict'] == 'FIXED']
    if len(fixed) != 1 or record.get('state') != 'published' or record.get('fix_merged'):
        raise ValueError('expected one unresolved published FIXED job')
    job_id = fixed[0]
    job = json.loads(job_path(c.ROOT, job_id).read_text())
    if (job.get('job') != job_id or job.get('item') != item['id'] or job.get('run') != run
            or job_id not in record.get('jobs', []) or job.get('canonical_finding_id')):
        raise ValueError('legacy repair job identity mismatch')
    publication = record.get('publication') or {}
    published, actual = publication.get('head'), info.get('headRefOid')
    merge = (info.get('mergeCommit') or {}).get('oid')
    tip = c.git('rev-parse', DEFAULT_REF)
    if (info.get('state') != 'MERGED' or info.get('number') != record.get('fix_pr', {}).get('number')
            or not all(isinstance(x, str) and re.fullmatch(r'[0-9a-f]{40}', x)
                       for x in (published, actual, merge, tip))):
        raise ValueError('merged repair PR identity or lineage mismatch')
    if not c.ensure_commit(info['number'], actual):
        raise ValueError('merged repair PR head unavailable')
    if not c.is_ancestor(published, actual) or not c.is_ancestor(merge, tip):
        raise ValueError('merged repair PR identity or lineage mismatch')
    commits = publication.get('commits')
    if not isinstance(commits, list) or not commits:
        raise ValueError('published repair commits unavailable')
    paths = {source_path(job['finding'])}
    for sha in commits:
        if not isinstance(sha, str) or not re.fullmatch(r'[0-9a-f]{40}', sha) or not c.is_ancestor(sha, published):
            raise ValueError('published repair commit lineage unavailable')
        paths.update(p for p in c.git('diff-tree', '--root', '--no-commit-id', '--name-only',
                                      '--no-renames', '-r', '-z', sha).split('\0')
                     if p and not repair_test_path(p))
    sources = {}
    for path in sorted(paths):
        source_path({'path': path})
        sources[path] = {'published': repair_source_entry(c, published, path),
                         'actual': repair_source_entry(c, actual, path),
                         'current': repair_source_entry(c, tip, path)}
    # JSON round trip normalizes git entry tuples for journal comparison.
    expected = json.loads(json.dumps({'job': job_id, 'item': item['id'], 'run': run,
        'finding_sha256': identity(job['finding']), 'pr': info['number'], 'published_head': published,
        'actual_head': actual, 'merge_commit': merge, 'source_sha': tip,
        'sources': sources, 'verdict': 'fixed'}))
    if not isinstance(evidence, dict) or any(evidence.get(k) != v for k, v in expected.items()):
        raise ValueError('fixed revalidation binding changed')
    if not all(isinstance(evidence.get(k), str) and evidence[k].strip() and len(evidence[k]) <= 4000
               for k in ('reviewer', 'reason')):
        raise ValueError('named revalidation reviewer and concrete reason required')
    return expected


def publication_journal(c, record):
    publication = record.get('publication') or {}
    journal = c.STATE / 'repair' / record['jobs'][0] / 'publication.json'
    saved = json.loads(journal.read_text())
    for key in ('head', 'commits', 'target', 'branch', 'open_pr'):
        if saved.get(key) != publication.get(key):
            raise ValueError('publication journal identity mismatch')
    if publication.get('fixed_revalidation') is not None and not saved.get('fixed_revalidation'):
        raise ValueError('publication revalidation missing from journal')
    if not set(publication.get('source_resolutions', [])) <= set(saved.get('source_resolutions', [])):
        raise ValueError('publication resolutions contradict journal')
    return journal, saved


def record_fixed_publication_evidence(c, q, job_id, evidence):
    """Persist one explicit legacy fixed disposition under the tick lock; never dispatch."""
    job = json.loads(job_path(c.ROOT, job_id).read_text())
    matches = [i for i in q['items'] if i['id'] == job.get('item')]
    if len(matches) != 1:
        raise ValueError('repair item identity mismatch')
    item = matches[0]
    run = job.get('run')
    record = item.get('repair_runs', {}).get(run)
    if not record or job.get('job') != job_id or not isinstance(evidence, dict) or evidence.get('job') != job_id:
        raise ValueError('repair run identity mismatch')
    journal, saved = publication_journal(c, record)
    info = c.pr_info(record['fix_pr']['number'])
    fixed_publication_evidence(c, item, run, record, info, evidence)
    if c.pr_info(record['fix_pr']['number']) != info:
        raise ValueError('repair PR changed during revalidation')
    fixed_publication_evidence(c, item, run, record, info, evidence)
    saved['fixed_revalidation'] = evidence
    atomic(journal, saved)
    record['publication'] = saved
    c.save_queue(q)


def canonical_fixed_events(c, record, info):
    """Project existing terminal ledger truth; never create a disposition."""
    fixed = [v['job'] for v in record.get('verdicts', []) if v['verdict'] == 'FIXED']
    if not fixed:
        return None
    jobs = [json.loads((c.STATE / 'repair/inbox' / (j + '.json')).read_text()) for j in fixed]
    if not all(isinstance(j.get('canonical_finding_id'), str)
               and re.fullmatch(r'[0-9a-f]{64}', j['canonical_finding_id'])
               and (c.STATE / 'backfill/findings/triage' / (j['canonical_finding_id'] + '.json')).exists()
               for j in jobs):
        return None
    merge = (info.get('mergeCommit') or {}).get('oid')
    inbox = finding_inbox(c)
    events = {}
    for job_id, job in zip(fixed, jobs):
        if job.get('job') != job_id or job_id not in record['jobs']:
            raise ValueError('canonical fixed repair job identity mismatch')
        event_id = inbox.current_fixed_event(job, merge)
        if not event_id:
            return None
        events[job_id] = event_id
    published = record.get('publication', {}).get('head')
    actual = info.get('headRefOid')
    if (info.get('number') != record['fix_pr']['number'] or not published or not actual
            or not c.is_ancestor(published, actual)):
        raise ValueError('canonical fixed repair PR lineage mismatch')
    return {'published_head': published, 'actual_head': actual, 'canonical_fixed_events': events}


def reconcile_fix_prs(c, q):
    for item in q['items']:
        if item['kind'] == review_receipt.KIND:
            try:
                reconcile_current_fix(c, item)
            except Exception as exc:
                item.pop('remediation', None)
                if item.get('remediation_state') == 'fixed':
                    item['remediation_state'] = 'pending-merged-evidence'
                item['repair_error'] = str(exc)[:300]
            continue
        for run, record in item.get('repair_runs', {}).items():
            pr = record.get('fix_pr')
            if not pr or record.get('fix_merged') or record.get('fix_closed'):
                continue
            try:
                info = c.pr_info(pr['number'])
            except Exception:
                # Shared forge exhaustion must not abort queue persistence.
                continue
            pr['state'] = info['state']
            if info['state'] == 'CLOSED':
                # Terminal marker: an abandoned fix PR must not cost one forge
                # call per tick forever.
                record['fix_closed'] = c.iso()
                continue
            if info['state'] == 'MERGED':
                merge = (info.get('mergeCommit') or {}).get('oid')
                if not merge or not c.is_ancestor(merge, c.git('rev-parse', DEFAULT_REF)):
                    continue
                try:
                    proof = canonical_fixed_events(c, record, info)
                    projected = proof is not None
                    if not projected:
                        journal = c.STATE / 'repair' / record['jobs'][0] / 'publication.json' if record.get('publication') else None
                        saved = json.loads(journal.read_text()) if journal and journal.exists() else None
                        evidence = saved.get('fixed_revalidation') if saved else None
                        if evidence:
                            _, saved = publication_journal(c, record)
                            fixed_publication_evidence(c, item, run, record, info, evidence)
                            record['publication'] = saved
                            proof = {'fixed_revalidation': evidence}
                        else:
                            proof = merge_head_evidence(c, record, info.get('headRefOid'))
                    elif canonical_fixed_events(c, record, info) != proof:
                        raise ValueError('canonical fixed finding changed before source feedback')
                except Exception as exc:
                    record['source_publication_error'] = str(exc)[:300]
                    continue
                if proof and 'fixed_revalidation' in proof:
                    try:
                        _, latest = publication_journal(c, record)
                        if latest.get('fixed_revalidation') != proof['fixed_revalidation']:
                            raise ValueError('fixed revalidation changed')
                        fixed_publication_evidence(c, item, run, record, c.pr_info(pr['number']), proof['fixed_revalidation'])
                    except Exception as exc:
                        record['source_publication_error'] = str(exc)[:300]
                        continue
                if proof is not None:
                    record['validated_merge_head'] = {**proof, 'merge_commit': merge}
                fixed = {v['job'] for v in record.get('verdicts', []) if v['verdict'] == 'FIXED'}
                for index, job in enumerate(record['jobs'], 1):
                    if job in fixed:
                        expected = json.loads((c.STATE / 'repair/inbox' / (job + '.json')).read_text())
                        result = next(v for v in record['verdicts'] if v['job'] == job)
                        if not projected:
                            mark_finding_outcome(c, expected, result, merge, pr.get('url'))
                        for blocker in item.get('blocking', []):
                            if blocker.get('repair_job') == job:
                                blocker['resolution'] = {'fix_pr': pr['number'], 'merge': merge, 'at': c.iso()}
                try:
                    if projected and canonical_fixed_events(c, record, info) != proof:
                        raise ValueError('canonical fixed finding changed before source feedback')
                    if proof and 'fixed_revalidation' in proof:
                        _, latest = publication_journal(c, record)
                        if latest.get('fixed_revalidation') != proof['fixed_revalidation']:
                            raise ValueError('fixed revalidation changed before source feedback')
                        fresh = c.pr_info(pr['number'])
                        fixed_publication_evidence(c, item, run, record, fresh, proof['fixed_revalidation'])
                        record['publication'] = latest
                    publish_source_resolution(c, record, merge)
                except Exception as exc:
                    record['source_publication_error'] = str(exc)[:300]
                    continue  # Optional feedback must not abort the scheduler tick.
                record.pop('source_publication_error', None)
                record['fix_merged'] = c.iso()


def digest(root, queue):
    from crq_repair import utc
    import datetime as dt
    counts = {k: 0 for k in ('fixed@A0', 'fixed@A1', 'fixed@A2', 'not-fixed', 'stale', 'judged-valid', 'judged-invalid', 'failed')}
    fix_prs = []
    source_publication_errors = []
    consumed = set()
    for item in queue['items']:
        for run, record in item.get('repair_runs', {}).items():
            if record.get('source_publication_error'):
                source_publication_errors.append({'item': item['id'], 'run': run, 'error': record['source_publication_error']})
            if record.get('fix_pr'):
                fix_prs.append(record['fix_pr'])
            for value in record.get('verdicts', []):
                consumed.add(value['job'])
                if value['verdict'] == 'FIXED':
                    counts['fixed@' + value['attempts'][-1]['rung']] += 1
                else:
                    counts[{'NOT-FIXED': 'not-fixed', 'STALE': 'stale'}.get(value['verdict'], 'failed')] += 1
                judged = (value.get('judge') or {}).get('verdict')
                if judged in ('valid', 'invalid'):
                    counts['judged-' + judged] += 1
    # Only jobs the drain can still select count as inbox work. This mirrors
    # bounded.drain_job/drain_order: a job listed in a 'queued' run (any item
    # kind) whose id passes the drain's job-id grammar. Anything else (a
    # terminal run, an id the drain refuses such as the retired
    # 'crq-signer-promo-7f440274a8+-F1') never drains, so it would pin the
    # oldest age forever; report it separately as orphaned.
    drainable = {job for item in queue['items']
                 for record in item.get('repair_runs', {}).values()
                 if record.get('state') == 'queued'
                 for job in record.get('jobs', []) if JOB_ID.fullmatch(job)}
    inbox = Path(root) / 'state/repair/inbox'
    pending, deferred, running, orphaned = [], 0, 0, 0
    for path in inbox.glob('*.json'):
        if path.stem in consumed:
            continue
        if path.stem not in drainable:
            if not (inbox.parent / path.stem / 'result.json').exists():
                orphaned += 1
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
            'jobs_in_flight': running, 'rate_limit_deferred': deferred, 'orphaned': orphaned,
            'fix_prs': fix_prs, 'source_publication_errors': source_publication_errors}
