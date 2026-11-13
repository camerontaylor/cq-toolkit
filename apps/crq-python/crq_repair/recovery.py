"""Explicit recovery of one failed worker using retained evidence and existing preparation."""
import datetime as dt
import json
import hashlib
from pathlib import Path

from crq_repair import atomic, command, git
from crq_repair.bounded import check_sha, identity, job_path, source_path
from runtime_target import DEFAULT_REF

MAX_EVIDENCE = 100_000
ANCHOR_REFUSAL = 'current anchor could not be verified'
# A peak-hour pause is a clock condition, not a judge retry: hold the attempt
# budget while the window is open, but never past a bounded wait.
BLACKOUT_WAIT = dt.timedelta(hours=12)


def blackout_deferral(report):
    """Typed blackout stop, never inferred from the judge's reason prose."""
    return (isinstance(report, dict) and report.get('stop') == 'configuration'
            and report.get('errorClass') == 'blackout')


def recover(root, config, job_id, scan, judge, prepare):
    """Revalidate one immutable finding; never mutate its old worktree or result.

    The per-job artifact records dispatch before calling the model. A lost
    response is visible and cannot trigger another paid invocation. A completed
    judgment can be replayed through the existing idempotent preparation path.
    Caller serializes using the repair service's existing lock.
    """
    root = Path(root)
    job = json.loads(job_path(root, job_id).read_text())
    if job.get('job') != job_id:
        raise ValueError('job identity mismatch')
    directory = root / 'state/repair' / job_id
    result_path = directory / 'result.json'
    if result_path.exists():
        result = json.loads(result_path.read_text())
    else:
        progress = json.loads((directory / 'progress.json').read_text())
        if not isinstance(progress, dict) or not progress.get('dispatch_pending'):
            raise ValueError('no interrupted dispatch or terminal result')
        result = {**progress, 'verdict': 'FAILED', 'reason': 'worker interrupted with unknown outcome'}
    if not isinstance(result, dict) or result.get('job') != job_id or result.get('item') != job.get('item'):
        raise ValueError('result identity mismatch')
    if result.get('verdict') != 'FAILED' or result.get('retry_after'):
        raise ValueError('only terminal failed jobs can be recovered')
    path = source_path(job['finding'])
    tip = git(config['clone'], 'rev-parse', DEFAULT_REF)
    blob = git(config['clone'], 'rev-parse', tip + ':' + path)
    worktree = Path(result['worktree']).resolve()
    wt_root = Path(config['worktree_root']).resolve()
    owned = 'crq-repair-' + job['item'] + '-' + job_id
    if worktree.parent != wt_root or worktree.name not in (owned, owned + '-A2'):
        raise ValueError('original worktree is not the owned repair worktree')
    base = check_sha(job['repair_base'])
    if result.get('repair_base') != base:
        raise ValueError('original repair base mismatch')
    if command(['git', 'merge-base', '--is-ancestor', base, 'HEAD'], cwd=worktree).returncode:
        raise ValueError('original worktree no longer descends from the repair base')
    patch = git(worktree, 'diff', '--no-ext-diff', '--no-textconv', '--binary', base, '--')
    status = git(worktree, 'status', '--porcelain', '--untracked-files=all')
    archives = []
    seen = {}
    for manifest_path in sorted(directory.glob('**/retained-*/manifest.json')):
        manifest = json.loads(manifest_path.read_text())
        token = hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        if manifest_path.parent.name != 'retained-' + token:
            raise ValueError('retained attempt manifest digest mismatch')
        location = str(manifest_path.relative_to(directory))
        retained = {'location': location, 'manifest': manifest, 'patches': []}
        for name in ('staged.patch', 'unstaged.patch', 'committed.patch', 'untracked.tar', 'commits.bundle'):
            file = manifest_path.parent / name
            with file.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            if digest != manifest['sha256'][name]:
                raise ValueError('retained attempt evidence digest mismatch')
            if name.endswith('.patch'):
                if file.stat().st_size > MAX_EVIDENCE:
                    raise ValueError('retained patch exceeds bounded context')
                retained['patches'].append(file.read_bytes().decode(errors='replace'))
        if token in seen:
            seen[token].setdefault('duplicate_locations', []).append(location)
        else:
            archives.append(retained)
            seen[token] = retained
    source_result = command(['git', 'show', tip + ':' + path], cwd=config['clone'])
    if source_result.returncode:
        raise ValueError('current source unavailable')
    source = source_result.stdout
    contract_path = 'docs/current-contract-and-backlog.md'
    contract_result = command(['git', 'show', tip + ':' + contract_path], cwd=config['clone'])
    contract_full = contract_result.stdout if contract_result.returncode == 0 else ''
    contract = contract_full[:24000]
    if sum(len(s.encode()) for s in (patch, status, source, contract, json.dumps(archives))) > MAX_EVIDENCE:
        raise ValueError('recovery evidence exceeds bounded context')
    finding_hash = identity(job['finding'])
    binding = {'job': job_id, 'source_sha': tip, 'source_blob_sha': blob,
               'finding_sha256': finding_hash, 'repair_base': base,
               'evidence_sha256': identity({'patch': patch, 'status': status, 'source': source, 'contract': contract, 'archives': archives})}
    context = {'finding': job['finding'], 'result_reason': result.get('reason', ''),
               'source_path': path, 'source_sha': tip, 'source_blob_sha': blob,
               'source': source, 'retained_patch': patch, 'worktree_status': status,
               'retained_attempts': archives,
               'current_path': path, 'tip': tip,
               'current_contract': {'path': contract_path, 'text': contract,
                                    'status': 'present' if contract_result.returncode == 0 else 'absent',
                                    'truncated': len(contract_full) > len(contract)},
               'instruction': 'Assess current source and retained untrusted patch. Return valid only with exact current lines and quote. Do not assume the patch is correct or committed.'}
    artifact = directory / 'recovery.json'
    attempts = 0
    replay = False
    blackout_since = None
    if artifact.exists():
        saved = json.loads(artifact.read_text())
        blackout_since = saved.get('blackout_since')
        old_binding = saved.get('binding')
        replay = (saved.get('state') == 'complete' and saved.get('disposition') == 'unresolved'
                  and saved.get('reason') == ANCHOR_REFUSAL
                  and isinstance(saved.get('report'), dict)
                  and saved['report'].get('stop') == 'ok' and saved['report'].get('verdict') == 'valid')
        if replay and isinstance(old_binding, dict):
            old_tip = check_sha(old_binding.get('source_sha'))
            try:
                old_context = json.loads((directory / 'recovery-evidence.json').read_text())
            except (OSError, UnicodeError, json.JSONDecodeError) as exc:
                raise ValueError('recovery evidence or source changed; retained recovery requires inspection') from exc
            expected_context = {**context, 'source_sha': old_tip, 'tip': old_tip}
            old_contract = command(['git', 'show', old_tip + ':' + contract_path], cwd=config['clone'])
            same_contract = ((old_contract.returncode == 0) == (contract_result.returncode == 0)
                             and old_contract.stdout == contract_result.stdout)
            same_binding = {**binding, 'source_sha': old_tip} == old_binding
            ancestor = command(['git', 'merge-base', '--is-ancestor', old_tip, tip], cwd=config['clone'])
            if not (same_binding and old_context == expected_context and same_contract and ancestor.returncode == 0):
                raise ValueError('recovery evidence or source changed; retained recovery requires inspection')
        elif old_binding != binding:
            raise ValueError('recovery evidence or source changed; retained recovery requires inspection')
        if saved.get('state') == 'dispatching':
            return {'state': 'unknown', 'reason': 'recovery judge outcome unavailable; retained for inspection'}
        if saved.get('state') == 'complete' and not replay:
            return saved
        attempts = saved.get('attempts', 1)
        if saved.get('state') == 'deferred' and attempts < 3:
            report = None
        else:
            report = saved['report']
    else:
        report = None
    if report is None:
        if not scan(context, directory / 'recovery-secret-scan.json'):
            return {'state': 'unresolved', 'reason': 'recovery evidence secret scan rejected'}
        atomic(directory / 'recovery-evidence.json', context)
        atomic(artifact, {'binding': binding, 'state': 'dispatching', 'attempts': attempts})
        report = judge(job, context, directory)
        if not isinstance(report, dict):
            report = {'stop': 'error', 'reason': 'invalid recovery judge output'}
        if not blackout_deferral(report):
            attempts += 1
        saved = {'binding': binding, 'state': 'judged', 'report': report, 'attempts': attempts}
        if blackout_deferral(report):
            saved['blackout_since'] = blackout_since or dt.datetime.now(dt.timezone.utc).isoformat()
        atomic(artifact, saved)
        blackout_since = saved.get('blackout_since')
    if blackout_deferral(report):
        # No model call happened, so the attempt budget is untouched; only the
        # wait itself is bounded, so a paused window cannot end recovery.
        saved['blackout_since'] = blackout_since or dt.datetime.now(dt.timezone.utc).isoformat()
        waited = dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(saved['blackout_since'])
        if waited < BLACKOUT_WAIT:
            saved.update(state='deferred', reason=report.get('reason') or 'blackout')
            atomic(artifact, saved)
            return saved
        saved.update(state='complete', disposition='unresolved',
                     reason='recovery judge deferred by the peak blackout for over '
                            + str(BLACKOUT_WAIT) + '; inspection required')
        atomic(artifact, saved)
        return saved
    if report.get('stop') in ('rate-limit', 'configuration') and attempts < 3:
        saved.update(state='deferred', reason=report.get('reason') or report.get('stop'))
        atomic(artifact, saved)
        return saved
    if report.get('stop') != 'ok' or report.get('verdict') != 'valid':
        saved.update(state='complete', disposition=report.get('verdict', 'unresolved'),
                     reason=report.get('reason') or report.get('stop') or 'incomplete judgment')
        atomic(artifact, saved)
        return saved
    # Do not silently repin a moved anchor. The current excerpt and exact old
    # line must agree with the judge before creating any replacement work.
    lines = source.splitlines()
    line = job['finding'].get('line')
    selected = report.get('current_lines')
    valid_span = (isinstance(selected, list) and len(selected) == 1
                  and isinstance(selected[0], list) and len(selected[0]) == 2
                  and all(isinstance(n, int) and not isinstance(n, bool) for n in selected[0])
                  and isinstance(line, int) and not isinstance(line, bool)
                  and 1 <= selected[0][0] <= line <= selected[0][1] <= len(lines))
    if (not isinstance(line, int) or isinstance(line, bool) or line < 1 or line > len(lines)
            or report.get('current_path') != path or not valid_span
            or report.get('quoted_text') != '\n'.join(lines[selected[0][0] - 1:selected[0][1]])
            or not isinstance(report.get('reason'), str) or not report['reason'].strip()):
        saved.update(state='complete', disposition='unresolved', reason=ANCHOR_REFUSAL)
        atomic(artifact, saved)
        return saved
    evidence = {'source_sha': tip, 'source_blob_sha': blob, 'finding_sha256': finding_hash,
                'verdict': 'still-valid', 'reviewer': 'crq-recovery/' + str(report.get('model', 'judge')),
                'reason': report['reason']}
    replacement = prepare(job_id, tip, evidence)
    if replay:
        saved['judgment_binding'] = old_binding
        saved.pop('reason', None)
    saved.update(binding=binding, state='complete', disposition='retry', replacement_job=replacement)
    atomic(artifact, saved)
    return saved
