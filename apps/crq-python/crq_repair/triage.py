"""Bounded backfill triage using the existing event chain and repair adapter."""
import collections
import json
import time
import subprocess

import review_ledger as ledger


PENDING = ('untriaged', 'needs-retriage')


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
    return {'original_region': original, 'content_search': search, 'finding': finding, 'target': row['target'], 'tip': tip, 'current_path': name,
            'region': [{'line': i + 1, 'text': text[i]} for i in range(start, end)],
            'history': repo.git('log', '-n', '40', '--format=%H %s', row['target'] + '..' + tip, '--', finding['path']).decode(errors='replace')[:16000]}


def decision(repo, row, tip, report):
    reason = report.get('reason')
    if not isinstance(reason, str) or not reason.strip():
        return 'needs-human', 'judge supplied no reason', {}
    verdict = report.get('verdict')
    if verdict in ('fixed', 'superseded'):
        commit = report.get('fixing_commit')
        try:
            commit = repo.resolve(commit)
            if commit not in repo.git('rev-list', tip).decode().splitlines():
                raise ValueError('commit not ancestor')
            if verdict == 'fixed' and row['finding']['path'] not in repo.git('diff-tree', '--root', '--no-commit-id', '--name-only', '-r', commit).decode().splitlines():
                raise ValueError('fix does not touch path')
        except (TypeError, ValueError, ledger.IntegrityError, subprocess.CalledProcessError):
            return 'needs-human', 'unverified fixing/superseding commit: ' + reason, {}
        return ('already-fixed' if verdict == 'fixed' else 'superseded'), reason, {'fixing_commit': commit}
    if verdict == 'valid':
        try:
            path = report['current_path']; selected = ledger.intervals(report['current_lines'])
            blob = repo.entries(tip)[path]['blob']
            text = repo.git('cat-file', 'blob', blob).decode().splitlines()
            quote = report.get('quoted_text')
            if (not selected or min(selected) < 1 or max(selected) > len(text)
                    or not isinstance(quote, str) or not quote.strip()
                    or '\n'.join(text[i - 1] for i in sorted(selected)) != quote):
                raise ValueError('quote mismatch')
        except (KeyError, TypeError, ValueError, UnicodeError, ledger.IntegrityError):
            return 'needs-human', 'judge current anchor failed verification: ' + reason, {}
        return 'confirmed', reason, {k: report.get(k) for k in ('current_path', 'current_lines', 'quoted_text')}
    if verdict == 'duplicate-of':
        return 'duplicate', reason, {'canonical_id': report.get('canonical_of')}
    return ('dismissed' if verdict == 'invalid' else 'needs-human'), reason, {}


def phase(inbox, repo, tip, judge, transport, at, *, maximum=6, seconds=600, dry_run=False):
    """Dry-run never recovers events, changes rows, or calls the transport."""
    deadline = time.monotonic() + seconds
    if not dry_run:
        inbox.recover(inbox.publication.retained())
    rows = [ledger.loads(p.read_bytes()) for p in sorted((inbox.root / 'triage').glob('*.json'))]
    reviews = inbox.publication.retained()
    for row in rows:
        if hasattr(inbox, 'recovered_anchor'):
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
        key = (f['path'], ' '.join(f['title'].split()).casefold(), json.dumps(anchor.get('intervals')))
        canonical = seen.get(key) if anchor.get('intervals') else None
        if row['status'] == 'duplicate':
            continue
        if anchor.get('intervals'):
            seen.setdefault(key, f['id'])
        if row['status'] not in PENDING:
            continue
        if f['path'] not in entries:
            deletion = repo.git('log', '-1', '--format=%H', '--diff-filter=D', tip, '--', f['path']).decode().strip()
            plans.append((row, 'superseded', 'path absent at promoted tip ' + tip + '; deleting commit ' + deletion, {}))
        elif canonical:
            plans.append((row, 'duplicate', 'exact path/title/anchor duplicate', {'canonical_id': canonical}))
        else:
            candidates.append(row)
    candidates.sort(key=lambda r: ({'critical': 0, 'major': 1}.get(r['finding']['severity'], 2), age(r), r['finding']['id']))
    judged = 0
    stopped = None
    for row in candidates[:maximum]:
        if time.monotonic() >= deadline:
            stopped = 'deadline'; break
        report = judge(row, context(repo, row, tip), deadline - time.monotonic())
        if report.get('stop') != 'ok':
            stopped = report.get('stop', 'error'); break
        row['_triage_model'] = report.get('model', 'judge')
        action, reason, kwargs = decision(repo, row, tip, report)
        if action == 'duplicate' and (kwargs.get('canonical_id') == row['finding']['id'] or not any(r['finding']['id'] == kwargs.get('canonical_id') and r['status'] != 'duplicate' for r in rows)):
            action, reason, kwargs = 'needs-human', 'judge supplied invalid canonical finding', {}
        plans.append((row, action, reason, kwargs)); judged += 1
    outcomes = []
    for row, action, reason, kwargs in plans:
        fid = row['finding']['id']
        if not dry_run:
            event = inbox.triage(fid, repo, tip, action, 'crq-triage/' + row.get('_triage_model', 'deterministic'), reason, at, **kwargs)
            action = event['payload']['action']
        outcomes.append({'finding_id': fid, 'action': action, 'reason': reason})
    delivered = 0
    if not dry_run:
        for path in sorted((inbox.root / 'triage').glob('*.json')):
            row = ledger.loads(path.read_bytes())
            if row['status'] == 'confirmed' and row.get('target_current') == tip:
                inbox.deliver(row['finding']['id'], transport, at); delivered += 1
    return {'total': len(rows), 'judged': judged, 'unjudged': len(candidates) - judged,
            'counts': dict(collections.Counter(o['action'] for o in outcomes)),
            'delivered': delivered, 'stopped': stopped, 'dry_run': dry_run, 'outcomes': outcomes}
