"""Source-verified cq CLI JSON flag adapter; never launches tests."""
import json
import os
from pathlib import Path
from crq_repair import command

HARNESS = {
    'tools': {
        'read': {'enabled': True, 'pathPatterns': ['**/*'], 'maxOutputChars': 200000},
        'edit': {'enabled': True, 'pathPatterns': ['**/*'], 'maxOutputChars': 4000},
        'run': {'enabled': True, 'commandPatterns': ['git ' + x for x in
                ('add', 'commit', 'status', 'diff', 'log', 'rev-parse')],
                'timeoutMs': 30000, 'maxOutputChars': 100000}},
    'promptBudget': {'maxSystemPromptChars': 20000, 'maxTools': 3, 'maxToolDescriptionChars': 1024}}


def invoke(config, role, job, wt, directory):
    provider, model = role['model'].split('/', 1)
    payload = {'repo': config['repo'], 'pr': job.get('pr') or 0,
               'item': {'id': job['job'], **{k: job['finding'].get(k) for k in ('path', 'line', 'body')}, 'comments': []},
               'worktree': {'path': str(wt), 'branch': 'detached'},
               'driver': {'provider': provider, 'model': model}, 'harness': HARNESS,
               'budget': {'maxTokens': role.get('budget', {}).get('max_tokens', config['repair']['budget']['max_tokens']),
                          'wallClockMs': config['repair']['budget']['wall_clock_min'] * 60000}}
    env = {k: v for k, v in os.environ.items() if not k.startswith('CQ_SANDBOX') and k != 'CQ_RUN_TOOL'}
    env.update(GIT_CONFIG_COUNT='1', GIT_CONFIG_KEY_0='remote.origin.pushurl', GIT_CONFIG_VALUE_0='/dev/null')
    argv = ['node', config['repair']['cq_bin'], 'review.fixItem', '--json']
    argv += ['--' + k + '=' + json.dumps(v) for k, v in payload.items()]
    p = command(argv, cwd=wt, env=env, timeout=config['repair']['budget']['wall_clock_min'] * 60)
    Path(directory, 'driver.log').write_text(p.stdout + '\n' + p.stderr)
    try:
        data = json.loads(p.stdout)
    except ValueError:
        return {'stop': 'error', 'changed': False, 'summary': 'invalid cq output', 'commits': []}
    if p.returncode or data.get('status') != 'ok':
        signals = data.get('providerSignals') or {}
        return {'stop': 'rate-limit' if 'rate' in json.dumps(signals).lower() else 'error',
                'changed': False, 'summary': str(data.get('reason') or data.get('status')), 'commits': []}
    result = data.get('value') or data.get('result') or {}
    return {**result, 'stop': 'ok'}
