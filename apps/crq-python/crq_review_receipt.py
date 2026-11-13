"""CRQ-only whole-PR receipts; never consumes canonical repair evidence.

The ordinary independent-review CLI remains on its existing publisher path.
A run's absence of a finding is deliberately NOT a thread-resolution proof.
"""
import json
import datetime as dt
import re

PREFIX = '<!-- crq-review-output '
BLOCKING = {'major', 'critical', 'blocker', 'fatal'}


def binding(meta, pr):
    return {key: value for key, value in (
        ('pr', pr), ('run_id', meta['run_id']), ('base', meta['base']), ('head', meta['head']))}


def binding_marker(value):
    return PREFIX + json.dumps(value, sort_keys=True, separators=(',', ':')) + ' -->'


def reviews(prf, gh, repo, pr):
    pages = prf._json(gh, ['gh', 'api', '--paginate', '--slurp',
                         f'repos/{repo}/pulls/{pr}/reviews?per_page=100'])
    if not isinstance(pages, list) or any(not isinstance(page, list) for page in pages):
        raise RuntimeError('incomplete PR review pagination')
    rows = []
    for page in pages:
        for row in page:
            if not isinstance(row, dict) or type(row.get('id')) is not int:
                raise RuntimeError('invalid PR review identity')
            body, user = row.get('body') or '', row.get('user') or {}
            if not isinstance(body, str) or not isinstance(user, dict):
                raise RuntimeError('invalid PR review metadata')
            rows.append({**row, 'body': body, 'user': user})
    return rows


INLINE_PREFIX = '<!-- crq-review-inline-major '
THREAD = re.compile(r'\n<!-- crq-review-thread run=([A-Za-z0-9._-]+) head=([0-9a-f]{40}) finding=([0-9a-f]{64}) -->$')


class ThreadsNotVisible(RuntimeError):
    """Expected receipt evidence has no visible thread yet; keep delivery pending."""


def owned_receipt(row, login):
    author, body = row.get('user', {}).get('login') or '', row['body']
    return author in {login, 'cq-review[bot]'} or (
        'Unattested: App identity unavailable; posted with the host account.' in body
        and author and not author.endswith('[bot]')
        and row.get('author_association') in {'OWNER', 'MEMBER', 'COLLABORATOR'})


def expected_inline_major(rows, pr, head, login):
    """Read immutable per-scan finding ids; absence of visibility is never resolution."""
    expected = set()
    for row in rows:
        if not owned_receipt(row, login):
            continue
        body = row['body']
        for match in re.finditer(re.escape(PREFIX) + r'(.*?) -->', body):
            try:
                bound = json.loads(match[1])
                if bound.get('pr') != pr or bound.get('head') != head:
                    continue
                proof = re.search(re.escape(INLINE_PREFIX) + r'(.*?) -->', body)
                if proof is None:
                    raise ThreadsNotVisible('CRQ inline-major receipt proof unavailable; retry')
                value = json.loads(proof[1])
                if (value['run_id'] != bound['run_id'] or value['head'] != head
                        or not isinstance(value['findings'], list)
                        or any(not isinstance(key, str) or not re.fullmatch(r'[0-9a-f]{64}', key)
                               for key in value['findings'])):
                    raise ValueError()
                expected.update((bound['run_id'], head, key) for key in value['findings'])
            except (ValueError, KeyError, TypeError, AttributeError):
                raise ValueError('invalid CRQ inline-major receipt proof') from None
    return expected


def body_major_at_head(rows, pr, head, login):
    """Only post-change CRQ receipt evidence holds a head across later scans."""
    for row in rows:
        if not owned_receipt(row, login):
            continue
        body = row['body']
        for match in re.finditer(re.escape(PREFIX) + r'(.*?) -->', body):
            try:
                found = json.loads(match[1])
            except ValueError:
                raise ValueError('malformed CRQ receipt binding') from None
            if not isinstance(found, dict):
                raise ValueError('malformed CRQ receipt binding')
            if found.get('pr') != pr or found.get('head') != head:
                continue
            for scope in ('whole-pr-success', 'narrow-success'):
                if f"<!-- crq-review-scan run={found.get('run_id')} {scope} body-major=1 -->" in body:
                    return True
    return False


def prior_receipt(prf, gh, repo, pr, meta, login):
    wanted = binding(meta, pr)
    for row in reviews(prf, gh, repo, pr):
        if not isinstance(row, dict):
            raise RuntimeError('invalid PR review row')
        body = row.get('body') or ''
        if row.get('user', {}).get('login') not in {login, 'cq-review[bot]'}:
            continue
        if body.startswith(prf.marker(meta['run_id']) + '\n') and PREFIX not in body:
            # Upgrade must preserve the original run-marker crash barrier too.
            if f"{meta['base']}..{meta['head']}" not in body:
                raise ValueError('changed legacy CRQ review binding')
            return {'id': row['id'], 'url': row.get('html_url'), 'login': row.get('user', {}).get('login'), 'body': body}
        for match in re.finditer(re.escape(PREFIX) + r'(.*?) -->', body):
            try:
                found = json.loads(match[1])
            except ValueError:
                raise ValueError('malformed CRQ receipt binding') from None
            if not isinstance(found, dict):
                raise ValueError('malformed CRQ receipt binding')
            if found.get('run_id') != wanted['run_id']:
                continue
            if found != wanted:
                raise ValueError('changed CRQ receipt binding')
            if not body.startswith(prf.marker(meta['run_id']) + '\n' + binding_marker(wanted)):
                raise ValueError('misplaced CRQ receipt binding')
            return {'id': row['id'], 'url': row.get('html_url'), 'login': row.get('user', {}).get('login'), 'body': body}
    return None


def open_major(prf, gh, repo, pr, login, expected=None):
    """Paginate own namespaced threads; never resolve from absence in this run."""
    owner, name = repo.split('/')
    cursor = None
    seen = set()
    visible, has_open = set(), False
    while True:
        query = '''query($owner:String!,$name:String!,$pr:Int!,$cursor:String){
          repository(owner:$owner,name:$name){pullRequest(number:$pr){reviewThreads(first:100,after:$cursor){
            pageInfo{hasNextPage endCursor} nodes{id isResolved comments(first:1){nodes{body author{login __typename} pullRequestReview{body authorAssociation author{login __typename}}}}}
          }}}}'''
        args = ['gh', 'api', 'graphql', '-f', 'query=' + query, '-f', 'owner=' + owner,
                '-f', 'name=' + name, '-F', 'pr=' + str(pr)]
        if cursor:
            args += ['-f', 'cursor=' + cursor]
        data = prf._json(gh, args)
        try:
            if data.get('errors'):
                raise ValueError()
            conn = data['data']['repository']['pullRequest']['reviewThreads']
            nodes, page = conn['nodes'], conn['pageInfo']
            if not isinstance(nodes, list) or type(page['hasNextPage']) is not bool:
                raise ValueError()
            for thread in nodes:
                first = thread['comments']['nodes']
                if not first:
                    raise ValueError()
                body = first[0]['body']
                review = first[0].get('pullRequestReview') or {}
                review_body = review.get('body') or ''
                # Legacy queue output has a CodeRabbit CLI label; independent
                # cq-review-post summaries have a different explicit label.
                legacy = (review_body.startswith('<!-- crq-findings run=') and
                          '### crq findings (CodeRabbit CLI, local run ' in review_body)
                trusted = {login, 'cq-review[bot]'}
                # GitHub GraphQL returns the App as Bot/cq-review (verified on PR1690);
                # REST uses cq-review[bot]. A bare User/cq-review is not the App.
                author = (first[0].get('author') or {}).get('login') or ''
                review_author = (review.get('author') or {}).get('login')
                fallback = (author and not author.endswith('[bot]') and author == review_author
                            and review.get('authorAssociation') in {'OWNER', 'MEMBER', 'COLLABORATOR'}
                            and 'Unattested: App identity unavailable; posted with the host account.' in review_body)
                root_app = author == 'cq-review' and (first[0].get('author') or {}).get('__typename') == 'Bot'
                review_app = review_author == 'cq-review' and (review.get('author') or {}).get('__typename') == 'Bot'
                authored = author in trusted or root_app or fallback
                legacy = legacy and (review_author in trusted or review_app or fallback)
                marker = THREAD.search(body)
                own = authored and (marker is not None or legacy)
                if type(thread['isResolved']) is not bool:
                    raise ValueError()
                if own and marker:
                    visible.add(marker.groups())
                    if marker.groups() in (expected or set()) and not thread['isResolved']:
                        has_open = True
                if own and not thread['isResolved'] and re.search(r'^\*\*crq finding F\d+ \[(major|critical|blocker|fatal)\]\*\*', body, re.I):
                    has_open = True
            if not page['hasNextPage']:
                if (expected or set()) - visible:
                    raise ThreadsNotVisible('expected CRQ major thread not visible; retry')
                return has_open
            next_cursor = page['endCursor']
            if not next_cursor or next_cursor in seen:
                raise ValueError()
            seen.add(next_cursor)
            cursor = next_cursor
        except (KeyError, TypeError, ValueError, AttributeError):
            if expected:
                raise ThreadsNotVisible('expected CRQ thread inventory incomplete; retry') from None
            raise RuntimeError('incomplete PR review threads') from None


def current_merge_base(prf, gh, repo, base, head):
    """gh's scalar --jq output is plain text, not a JSON string."""
    argv = ['gh', 'api', f'repos/{repo}/compare/{base}...{head}', '--jq', '.merge_base_commit.sha']
    value = (prf._ok(argv, prf._call(gh, argv)).stdout or '').strip()
    if not re.fullmatch(r'[0-9a-f]{40}', value):
        raise RuntimeError('invalid current PR merge base')
    return value


def prepare(prf, gh, repo, pr, meta, ndjson, findings, login):
    """Validate saved scan artifacts, and recompute completeness at delivery."""
    import crq
    rdir = ndjson.parent
    saved = json.loads((rdir / 'meta.json').read_text())
    if not isinstance(saved, dict):
        raise ValueError('invalid CRQ run artifact')
    for key in ('run_id', 'base', 'head'):
        if saved.get(key) != meta.get(key):
            raise ValueError('changed CRQ run artifact binding')
    saved_repo = saved.get('repo', repo)
    if saved.get('pr', pr) != pr or not isinstance(saved_repo, str) or saved_repo.lower() != repo.lower():
        raise ValueError('changed CRQ PR/repository binding')
    exit_info = json.loads((rdir / 'exit.json').read_text())
    if not isinstance(exit_info, dict):
        raise ValueError('invalid CRQ exit artifact')
    cls = crq.classify(ndjson, exit_info.get('exit'))
    if cls['outcome'] != 'completed' or not cls['counted']:
        return None
    for line in ndjson.read_text().splitlines():
        if not line.strip():
            continue
        event = json.loads(line)
        if event.get('partial') is True or event.get('truncated') is True:
            return None
    state = prf.pr_state(gh, repo, pr)
    if state.get('head') != meta['head']:
        return None
    merge_base = current_merge_base(prf, gh, repo, state['base'], meta['head'])
    whole = (saved.get('range_policy') == 'full-range-once-v1' and merge_base == meta['base'])
    blocked = any(f['severity'].lower() in BLOCKING for f in findings)
    rows = reviews(prf, gh, repo, pr)
    threads_block = open_major(prf, gh, repo, pr, login, expected_inline_major(rows, pr, meta['head'], login))
    blocked = body_major_at_head(rows, pr, meta['head'], login) or threads_block or blocked
    verdict = 'PASS' if whole and not blocked else 'ITERATE'
    return {**meta, 'receipt_header': f"**Independent review (CodeRabbit CLI via crq): {verdict} for `{meta['head']}`**",
            'receipt_binding': binding_marker(binding(meta, pr)), 'whole_pr_scan': whole, 'receipt_verdict': verdict}


REFRESH = '<!-- crq-verdict-refresh '
VERDICT = re.compile(r'^\*\*Independent review \(CodeRabbit CLI via crq\): (PASS|ITERATE) for `([0-9a-f]{40})`\*\*$', re.M)


def refresh(prf, repo, pr, meta, gh=None, login=None):
    """Refresh a prior whole-PR scan after author resolution, never rescan/resolve.

    A separate per-scan/head PASS marker survives a crash after POST. This namespace
    does not change the immutable original run receipt or schedule another scan.
    """
    injected = gh is not None
    gh = prf._gh if gh is None else gh
    meta = dict(meta)
    gh, login, meta = prf.select_receipt_identity(repo, meta, gh, login, injected)
    state = prf.pr_state(gh, repo, pr)
    if state['state'] != 'open' or state.get('merged') or state.get('head') != meta['head']:
        return {'state': 'skipped-head'}
    if current_merge_base(prf, gh, repo, state['base'], meta['head']) != meta['base']:
        return {'state': 'skipped-range'}
    rows = reviews(prf, gh, repo, pr)
    if body_major_at_head(rows, pr, meta['head'], login):
        return {'state': 'body-major'}
    own = []
    for row in rows:
        body = row.get('body') or ''
        verdict = VERDICT.search(body)
        if (verdict and verdict[2] == meta['head'] and (PREFIX in body or REFRESH in body)
                and row.get('user', {}).get('login') in {login, 'cq-review[bot]'}):
            own.append((row, verdict[1]))
    if not own:
        return {'state': 'no-receipt'}
    def submitted(entry):
        try:
            value = dt.datetime.fromisoformat(entry[0]['submitted_at'].replace('Z', '+00:00'))
            if value.tzinfo is None:
                raise ValueError()
            return value.timestamp()
        except (KeyError, ValueError, TypeError, AttributeError):
            raise RuntimeError('missing CRQ review chronology; cannot refresh') from None
    own.sort(key=submitted)
    if len(own) > 1 and submitted(own[-1]) == submitted(own[-2]) and own[-1][1] != own[-2][1]:
        raise RuntimeError('ambiguous CRQ review chronology; cannot refresh')
    latest, verdict = own[-1]
    if verdict == 'PASS':
        return {'state': 'existing', 'review_id': latest['id'], 'review_url': latest.get('html_url')}
    body = latest['body']
    proof = f"<!-- crq-review-scan run={meta['run_id']} whole-pr-success -->"
    if ' body-major=1 -->' in body:
        return {'state': 'body-major'}
    if (binding_marker(binding(meta, pr)) not in body or proof not in body):
        return {'state': 'no-whole-pr-proof'}
    if open_major(prf, gh, repo, pr, login, expected_inline_major(rows, pr, meta['head'], login)):
        return {'state': 'pending-threads'}
    wanted = f"{REFRESH}head={meta['head']} scan-run={meta['run_id']} -->"
    for row, _ in own:
        if wanted in row['body']:
            return {'state': 'existing', 'review_id': row['id'], 'review_url': row.get('html_url')}
    lines = [wanted,
             f"**Independent review (CodeRabbit CLI via crq): PASS for `{meta['head']}`**"]
    if meta.get('unattested'):
        lines += ['Unattested: App identity unavailable; posted with the host account.']
    lines += [f"Refresh of scanned run `{meta['run_id']}`; reviewed range `{meta['base']}..{meta['head']}`.",
              f"Supersedes review {latest.get('html_url') or latest['id']} after the author's thread resolution.",
              'The prior complete whole-PR scan is reused; no scan or new findings were produced.',
              'Legacy body-only findings are not covered or claimed resolved by this receipt.']
    argv, response = prf._post(gh, repo, pr, {'event': 'COMMENT', 'commit_id': meta['head'],
                                           'body': '\n'.join(lines), 'comments': []})
    posted = json.loads(prf._ok(argv, response).stdout)
    if type(posted.get('id')) is not int:
        raise RuntimeError('refresh POST returned no review identity; reconcile before retry')
    return {'state': 'created', 'review_id': posted['id'], 'review_url': posted.get('html_url'),
            'identity': login, 'attested': login == 'cq-review[bot]',
            'identity_reason': meta.get('identity_reason'), 'scanned_run': meta['run_id']}
