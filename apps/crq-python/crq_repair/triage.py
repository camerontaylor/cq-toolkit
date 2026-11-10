"""Bounded backfill triage using the existing event chain and repair adapter."""
import collections
import json
import time
import subprocess
import re

import review_ledger as ledger
from finding_delivery import RepairRoundCeiling


PENDING = ('untriaged', 'needs-retriage')
CONTRACT_PATH = 'docs/current-contract-and-backlog.md'
CONTRACT_MAX_CHARS = 24000


def source_excerpt(content, path, body, primary=False):
    """Spend the existing 8k allowance on cited lines before a file prefix."""
    citations = re.findall(re.escape(path) + r':(\d+)', body)
    if primary:
        citations += re.findall(r'(?i)lines?\s+(\d+)', body)
    lines = content.splitlines(keepends=True)
    starts = list(dict.fromkeys(max(0, int(n) - 21) for n in citations))[:4]
    if not starts or len(content) <= 8000:
        return {'text': content[:8000], 'truncated': len(content) > 8000}
    regions = []
    remaining = 8000
    for start in starts:
        if start >= len(lines):
            continue
        text = ''.join(lines[start:start + 41])[:min(2000, remaining)]
        regions.append({'start_line': start + 1, 'text': text})
        remaining -= len(text)
    return {'text': '', 'regions': regions, 'truncated': True}


def context(repo, row, tip):
    finding = row['finding']
    anchor = row.get('recovered_anchor') or finding
    name, lines = repo.carry(row['target'], tip, anchor['path'], ledger.intervals(anchor['intervals'])) if anchor.get('intervals') else (None, set())
    name = name or finding['path']
    entries = repo.entries(tip)
    text = repo.git('cat-file', 'blob', entries[name]['blob']).decode(errors='replace').splitlines() if name in entries else []
    start = max(0, min(lines, default=1) - 41)
    end = min(len(text), max(lines, default=1) + 40)
    original = ''
    search = ''
    if anchor.get('intervals'):
        old = repo.git('cat-file', 'blob', repo.entries(row['target'])[finding['path']]['blob']).decode(errors='replace').splitlines()
        indices = sorted(ledger.intervals(anchor['intervals']))
        original = '\n'.join(old[i - 1] for i in indices if 1 <= i <= len(old))[:16000]
        needle = next((line.strip() for line in original.splitlines() if len(line.strip()) >= 12), '')
        if needle and not lines:
            search = repo.git('grep', '-n', '-F', '-e', needle[:200], tip, '--', finding['path'], check=False).decode(errors='replace')[:16000]
    contract_entry = entries.get(CONTRACT_PATH)
    contract_text = repo.git('cat-file', 'blob', contract_entry['blob']).decode(errors='replace') if contract_entry else ''
    contract = {'path': CONTRACT_PATH, 'tip': tip, 'blob': contract_entry['blob'] if contract_entry else None,
                'status': 'present' if contract_entry else 'absent', 'text': contract_text[:CONTRACT_MAX_CHARS],
                'total_chars': len(contract_text), 'limit_chars': CONTRACT_MAX_CHARS,
                'truncated': len(contract_text) > CONTRACT_MAX_CHARS}
    extra = []
    if row.get('_escalate'):
        # Repository-controlled, immutable blobs only; the caller scans the
        # complete pack before dispatch. Never give the model raw file tools.
        body = ' '.join(str(finding.get(k) or '') for k in ('title', 'body'))
        paths = [name] + re.findall(r'[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+', body)
        paths = [path if path in entries else path.rstrip('.') for path in paths]
        for path in dict.fromkeys(paths):
            if path not in entries or len(extra) >= 3:
                continue
            content = repo.git('cat-file', 'blob', entries[path]['blob']).decode(errors='replace')
            extra.append({'path': path, 'blob': entries[path]['blob'],
                          **source_excerpt(content, path, body, primary=path == name)})
    return {'current_contract': contract, 'original_region': original, 'content_search': search, 'finding': finding, 'target': row['target'], 'tip': tip, 'current_path': name, 'additional_sources': extra,
            'region': [{'line': i + 1, 'text': text[i]} for i in range(start, end)],
            'history': repo.git('log', '-n', '40', '--format=%H %s', row['target'] + '..' + tip, '--', finding['path']).decode(errors='replace')[:16000]}


def missing_evidence(reason):
    """Recognize legacy missing-evidence judgments for existing recovery paths."""
    return (isinstance(reason, str)
            and not reason.startswith('fixer investigation:')
            and not re.search(r'secret|scan|dispatch|invalid|budget|timeout|timed out|provider|rate.limit', reason, re.I)
            and bool(re.search(r'(?:missing|insufficient|lack|need|unavailable|not provided).*?(?:source|context|evidence)|(?:source|context|evidence).*?(?:missing|insufficient|unavailable|not provided)', reason, re.I)))


def decision(repo, row, tip, report):
    reason = report.get('reason')
    if not isinstance(reason, str) or not reason.strip():
        return 'needs-human', 'judge supplied no reason', {'failure_class': 'exhausted'}
    verdict = report.get('verdict')
    if report.get('context_scan_refused'):
        return 'confirmed', 'fixer investigation: ' + reason, {'failure_class': 'evidence'}
    if verdict == 'unsure':
        # The current bridge has no typed owner-decision field. Its free text
        # cannot establish that class; let the fixer investigate and decide.
        # Admission to investigation, not a substantive validity judgment.
        # Inbox.triage still verifies the carried anchor before delivery.
        return 'confirmed', 'fixer investigation: ' + reason, {'failure_class': 'evidence'}
    if verdict in ('fixed', 'superseded'):
        commit = report.get('fixing_commit')
        try:
            commit = repo.resolve(commit)
            if commit not in repo.git('rev-list', row['target'] + '..' + tip).decode().splitlines():
                raise ValueError('commit not ancestor')
            fixing_path = repo.lineage(row['target'], commit, row['finding']['path']) or row['finding']['path']
            if verdict == 'fixed' and fixing_path not in repo.git('diff-tree', '--root', '--no-commit-id', '--name-only', '--first-parent', '-m', '-r', commit).decode().splitlines():
                raise ValueError('fix does not touch path')
        except (TypeError, ValueError, ledger.IntegrityError, subprocess.CalledProcessError):
            return 'needs-human', 'unverified fixing/superseding commit: ' + reason, {'failure_class': 'evidence'}
        return ('already-fixed' if verdict == 'fixed' else 'superseded'), reason, {'fixing_commit': commit}
    if verdict == 'valid':
        try:
            path = report['current_path']; selected = ledger.intervals(report['current_lines'])
            blob = repo.entries(tip)[path]['blob']
            text = repo.git('cat-file', 'blob', blob).decode().splitlines()
            quote = report.get('quoted_text')
            if not isinstance(quote, str) or not quote.strip():
                raise ValueError('quote missing')
            if (not selected or min(selected) < 1 or max(selected) > len(text)
                    or '\n'.join(text[i - 1] for i in sorted(selected)) != quote):
                # Recover line-number drift only from an exact, unique whole-line
                # match in the pinned blob. Ambiguous/edited quotes still fail.
                quoted = quote.split('\n')
                matches = [i for i in range(len(text) - len(quoted) + 1)
                           if text[i:i + len(quoted)] == quoted]
                if len(matches) != 1:
                    raise ValueError('quote mismatch')
                start = matches[0] + 1
                report = {**report, 'current_lines': [[start, start + len(quoted) - 1]]}
        except (KeyError, TypeError, ValueError, UnicodeError, ledger.IntegrityError):
            return 'confirmed', 'fixer investigation: judge current anchor failed verification: ' + reason, {'failure_class': 'evidence'}
        return 'confirmed', reason, {k: report.get(k) for k in ('current_path', 'current_lines', 'quoted_text')}
    if verdict == 'duplicate-of':
        return 'duplicate', reason, {'canonical_id': report.get('canonical_of')}
    return ('dismissed' if verdict == 'invalid' else 'needs-human'), reason, {'failure_class': 'exhausted'}


def phase(inbox, repo, tip, judge, transport, at, *, maximum=6, seconds=600, dry_run=False):
    """Dry-run never recovers events, changes rows, or calls the transport."""
    deadline = time.monotonic() + seconds
    repo.begin_invocation()
    if not dry_run:
        inbox.recover(inbox.publication.retained())
    rows = [ledger.loads(p.read_bytes()) for p in sorted((inbox.root / 'triage').glob('*.json'))]
    reviews = inbox.publication.retained()
    events = {v['id']: v for v in reviews if v.get('event_type') == 'finding-event'}
    for row in rows:
        if (time.monotonic() < deadline and row['finding'].get('anchor_status') != 'verified'
                and row['status'] in (*PENDING, 'confirmed') and hasattr(inbox, 'recovered_anchor')):
            recovered = inbox.recovered_anchor(row, repo, reviews)
            if recovered:
                row['recovered_anchor'] = recovered
    dates = {r['id']: r.get('occurred_at', '') for r in reviews}
    targets = {r['target'] for r in rows if not dates.get(r['review_id'])}
    target_dates = {t: repo.git('show', '-s', '--format=%cI', t).decode().strip() for t in targets}
    def age(row):
        return dates.get(row['review_id']) or target_dates[row['target']]
    rows.sort(key=lambda r: (age(r), r['finding']['id']))
    entries = repo.entries(tip)
    seen, plans, candidates = {}, [], []
    for row in rows:
        f = row['finding']; anchor = row.get('recovered_anchor') or f
        # An empty/unknown anchor is never evidence for an exact duplicate.
        key = (f['severity'], f['path'], anchor.get('blob'), f['body'], ' '.join(f['title'].split()).casefold(), json.dumps(anchor.get('intervals')))
        canonical = seen.get(key) if anchor.get('intervals') and anchor.get('blob') else None
        if row['status'] == 'duplicate':
            continue
        if anchor.get('intervals') and anchor.get('blob') and row['status'] not in ('already-fixed', 'fixed', 'dismissed', 'superseded'):
            seen.setdefault(key, f['id'])
        prior = events.get(row.get('previous_event_id'), {}).get('payload', {})
        investigate = (row['status'] == 'needs-human'
                       and str(prior.get('actor', '')).startswith('crq-triage/')
                       and not prior.get('evidence', {}).get('failure_class')
                       and missing_evidence(prior.get('evidence', {}).get('reason')))
        if investigate and (len(plans) >= maximum or time.monotonic() >= deadline):
            continue
        if investigate and len(plans) < maximum and time.monotonic() < deadline:
            plans.append((row, 'confirmed', 'fixer investigation: ' + prior['evidence']['reason'], {'failure_class': 'evidence'}))
            continue
        escalation = (row['status'] == 'needs-human'
                      and str(prior.get('actor', '')).startswith('crq-triage/')
                      and prior.get('actor') != 'crq-triage/delivery'
                      and not str(prior.get('actor', '')).startswith('crq-triage/escalation/'))
        if row['status'] not in PENDING and not escalation and not (row['status'] == 'confirmed' and row.get('target_current') != tip):
            continue
        if escalation:
            row['_escalate'] = True
        if not isinstance(f.get('path'), str) or not f['path']:
            plans.append((row, 'needs-human', 'finding has no repository path', {'failure_class': 'evidence'}))
            continue
        if time.monotonic() >= deadline:
            candidates.append(row)
            continue
        mapped = repo.lineage(row['target'], tip, f['path'])
        if mapped is None and f['path'] not in entries and repo.proven_deleted(row['target'], tip, f['path']):
            deletion = repo.git('log', '-1', '--format=%H', '--diff-filter=D', tip, '--', f['path']).decode().strip()
            plans.append((row, 'superseded', 'path absent at promoted tip ' + tip + '; deleting commit ' + deletion, {'fixing_commit': deletion} if deletion else {}))
        elif canonical:
            plans.append((row, 'duplicate', 'exact path/title/anchor duplicate', {'canonical_id': canonical}))
        else:
            candidates.append(row)
    candidates.sort(key=lambda r: ({'critical': 0, 'major': 1}.get(r['finding']['severity'], 2), age(r), r['finding']['id']))
    investigation_admissions = sum(reason.startswith('fixer investigation:') for _, _, reason, _ in plans)
    judged = 0
    stopped = None
    stopped_report = {}
    context_errors = []
    for row in candidates:
        if judged + investigation_admissions >= maximum:
            break
        if time.monotonic() >= deadline:
            stopped = 'deadline'; break
        try:
            packed = context(repo, row, tip)
        except (KeyError, TypeError, ValueError, ledger.IntegrityError,
                subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as exc:
            # Leave this row pending; another row's context can still be valid.
            error = {'type': type(exc).__name__[:80], 'target': tip}
            context_errors.append({'finding_id': row['finding']['id'], **error})
            if not dry_run:
                try:
                    inbox.context_error(row['finding']['id'], row['previous_event_id'], error)
                except (OSError, ValueError, KeyError):
                    pass  # A damaged or unavailable row must not stop other findings.
            continue
        if not dry_run:
            try:
                if not inbox.context_error(row['finding']['id'], row['previous_event_id'], None):
                    continue
            except (OSError, ValueError, KeyError):
                continue
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                stopped = 'deadline'; break
            report = judge(row, packed, remaining)
        except (subprocess.TimeoutExpired, OSError):
            stopped = 'deferred'; break
        if report.get('stop') != 'ok':
            if report.get('stop') == 'error' and report.get('errorClass') == 'output-invalid':
                row['_triage_model'] = report.get('model', 'judge')
                stage = 'escalation' if row.get('_escalate') else 'judge'
                plans.append((row, 'needs-human', stage + ' returned invalid structured output', {'failure_class': 'exhausted'}))
                judged += 1
                continue
            stopped = report.get('stop', 'error'); stopped_report = report; break
        row['_triage_model'] = report.get('model', 'judge')
        action, reason, kwargs = decision(repo, row, tip, report)
        if action == 'duplicate' and (kwargs.get('canonical_id') == row['finding']['id'] or not any(r['finding']['id'] == kwargs.get('canonical_id') and r['status'] != 'duplicate' for r in rows)):
            action, reason, kwargs = 'needs-human', 'judge supplied invalid canonical finding', {'failure_class': 'evidence'}
        plans.append((row, action, reason, kwargs)); judged += 1
    outcomes = []
    for row, action, reason, kwargs in plans:
        fid = row['finding']['id']
        if not dry_run:
            actor = 'crq-triage/' + ('escalation/' if row.get('_escalate') else '') + row.get('_triage_model', 'deterministic')
            kwargs.setdefault('failure_class', 'evidence')
            event = inbox.triage(fid, repo, tip, action, actor, reason, at, expected_previous_event_id=row['previous_event_id'], **kwargs)
            if event is None:
                continue  # Operator/recovery changed the row during model judgment.
            action = event['payload']['action']
        outcomes.append({'finding_id': fid, 'action': action, 'reason': reason})
    delivered = 0
    delivery_deferred = 0
    if not dry_run:
        for path in sorted((inbox.root / 'triage').glob('*.json')):
            row = ledger.loads(path.read_bytes())
            if (row['status'] == 'confirmed' and row.get('target_current') == tip
                    and row['finding']['severity'] in ('critical', 'major', 'minor')):
                try:
                    inbox.deliver(row['finding']['id'], transport, at); delivered += 1
                except RepairRoundCeiling as exc:
                    inbox.triage(row['finding']['id'], repo, tip, 'needs-human', 'crq-triage/delivery', str(exc), at,
                                 failure_class='exhausted', expected_previous_event_id=row['previous_event_id'])
                except (RuntimeError, OSError, ValueError):
                    delivery_deferred += 1
    return {'total': len(rows), 'judged': judged, 'unjudged': len(candidates) - judged,
            'counts': dict(collections.Counter(o['action'] for o in outcomes)),
            'delivered': delivered, 'delivery_deferred': delivery_deferred, 'context_errors': context_errors,
            'stop_report': stopped_report, 'stopped': stopped, 'dry_run': dry_run, 'outcomes': outcomes}
