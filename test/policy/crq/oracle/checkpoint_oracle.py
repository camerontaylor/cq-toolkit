"""Run crq._checkpoint_review_identity against scenarios; save_queue is a recorder."""
import json
import os
import sys
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', '..', 'apps', 'crq-python'))
import crq  # noqa: E402


def run_one(sc):
    request = dict(sc['request'])
    saves = []
    try:
        with mock.patch.object(crq, 'save_queue', lambda q: saves.append(True)):
            crq._checkpoint_review_identity({'items': []}, request, sc['login'], sc.get('reason'))
        return {'ok': {'request': request, 'saved': len(saves)}}
    except Exception as e:  # noqa: BLE001
        return {'err': type(e).__name__, 'msg': str(e), 'request': request, 'saved': len(saves)}


json.dump([run_one(sc) for sc in json.load(sys.stdin)], sys.stdout)
