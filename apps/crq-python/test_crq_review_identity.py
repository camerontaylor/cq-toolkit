"""Private token-only helper integration; no live credential access."""
import unittest
from types import SimpleNamespace
from unittest import mock
import tempfile

import crq
import crq_review_identity as identity
import pr_review_findings as prf
from test_crq_review_receipt import COMPLETE
from test_pr_review_findings import META, REPO, write_ndjson


class IdentityTest(unittest.TestCase):
    def response(self, out, err='', code=0):
        return SimpleNamespace(returncode=code, stdout=out, stderr=err)

    def test_capability_probe_token_capture_child_env_and_expiry(self):
        answers = [self.response('{"installation_token":"repo-scoped-v1"}'),
                   self.response('fixture-private-token\n', '{"expires_at":"2099-01-01T00:00:00Z"}'),
                   self.response('{}')]
        with mock.patch.object(identity.subprocess, 'run', side_effect=answers) as run:
            gh = identity.authenticated_gh(REPO)
            gh(['gh', 'api', 'repos/' + REPO + '/pulls/7'])
        self.assertEqual(run.call_args_list[0].args[0], ['cq-review-post', '--capabilities'])
        self.assertEqual(run.call_args_list[1].args[0],
            ['cq-review-post', '--installation-token', '--repo', REPO])
        self.assertEqual(run.call_args.kwargs['env']['GH_TOKEN'], 'fixture-private-token')
        self.assertNotIn('fixture-private-token', str(run.call_args.args))

    def test_missing_old_helper_failed_token_and_invalid_expiry_have_safe_distinct_errors(self):
        fixtures = [(FileNotFoundError('secret-like'), 'helper-missing'),
                    ([self.response('secret-like', code=2)], 'helper-capability-missing'),
                    ([self.response('{"installation_token":"repo-scoped-v1"}'),
                      self.response('secret-like', code=1)], 'app-credentials-unavailable'),
                    ([self.response('{"installation_token":"repo-scoped-v1"}'),
                      self.response('secret-like', '{"expires_at":"expired"}')], 'invalid-credential-response')]
        for answers, reason in fixtures:
            with self.subTest(reason=reason), mock.patch.object(identity.subprocess, 'run', side_effect=answers):
                with self.assertRaises(identity.IdentityUnavailable) as error:
                    identity.authenticated_gh(REPO)
                self.assertEqual(str(error.exception), reason)
                self.assertNotIn('secret-like', str(error.exception))

    def test_selected_app_never_falls_back_when_next_credential_setup_fails(self):
        with tempfile.TemporaryDirectory() as root:
            path = write_ndjson(root, [COMPLETE])
            with mock.patch.object(identity, 'authenticated_gh', side_effect=identity.IdentityUnavailable('helper-missing')), \
                 mock.patch.object(prf, '_gh') as owner:
                with self.assertRaisesRegex(RuntimeError, 'retry as App'):
                    prf.deliver(REPO, 7, {**META, 'crq_receipt': True, 'posting_identity': 'cq-review[bot]'}, path)
                owner.assert_not_called()

    def test_identity_checkpoint_is_durable_before_any_publication(self):
        request = {**META}
        q = {'items': []}
        with mock.patch.object(crq, 'save_queue') as save:
            crq._checkpoint_review_identity(q, request, 'cq-review[bot]', None)
            self.assertEqual(request['posting_identity'], 'cq-review[bot]')
            save.assert_called_once_with(q)
            crq._checkpoint_review_identity(q, request, 'cq-review[bot]', None)
            save.assert_called_once()
            with self.assertRaisesRegex(ValueError, 'changed CRQ posting identity'):
                crq._checkpoint_review_identity(q, request, 'owner', None)
