"""Repair mechanical gate and cq driver contracts. Real local Git and a fake
cq CLI that follows the real flag semantics; no models, no network."""
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
import crq_repair
from crq_repair.drivers import cq

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('repair_mechanical_under_test', ROOT / 'crq_repair.py')
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)

# Mirrors `cq gates.hackDetector --diff=<value> --json`: the CLI takes the flag
# value as the diff text (there is no @file expansion), answers
# `indeterminate` for text with no diff structure, and flags added
# suppressions.
FAKE_CQ = r"""
const arg = process.argv.slice(2).find((a) => a.startsWith('--diff='));
const diff = arg === undefined ? '' : arg.slice('--diff='.length);
const looksLikeDiff = /^diff --git |^@@ |^--- /m.test(diff);
if (diff.trim() !== '' && !looksLikeDiff) {
  console.log(JSON.stringify({status: 'indeterminate', detail: 'input does not parse as a unified diff'}));
} else {
  const value = diff.split('\n').filter((l) => l.startsWith('+') && l.includes('eslint-disable'))
    .map(() => ({kind: 'suppression', file: 'src/a.ts', message: 'new suppression'}));
  console.log(JSON.stringify({status: 'ok', value}));
}
"""


@unittest.skipUnless(shutil.which('node'), 'node is required for the fake cq CLI')
class MechanicalGateTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.cq_bin = self.root / 'cli.js'
        self.cq_bin.write_text(FAKE_CQ)
        self.wt = self.root / 'wt'
        (self.wt / 'src').mkdir(parents=True)
        self.git('init', '-q')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('config', 'user.name', 'Fixture')
        (self.wt / 'src/a.ts').write_text('export const a = 1;\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'base')
        self.base = self.git('rev-parse', 'HEAD')
        self.config = {'repair': {'cq_bin': str(self.cq_bin)}}

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.wt), *args], check=True,
                              capture_output=True, text=True).stdout.strip()

    def fix(self, text, job='crq-run1-F1'):
        (self.wt / 'src/a.ts').write_text(text)
        self.git('commit', '-qam', 'fix: ' + job)
        return [self.git('rev-parse', 'HEAD')]

    def test_clean_fix_passes_the_detector(self):
        # Every real fix on the runner host failed here: `--diff=@<path>` was scanned as
        # the literal path string and came back indeterminate.
        commits = self.fix('export const a = 2;\n')
        out = self.root / 'A0'
        out.mkdir()
        result = service.mechanical(self.config, self.wt, self.base, commits, 'crq-run1-F1', out)
        self.assertEqual(result, {'verify': 'ok', 'hack': 'ok', 'tests': 'suspended'})
        self.assertTrue((out / 'repair.patch').read_text().startswith('diff --git '))

    def test_detector_argv_carries_diff_text_not_a_path(self):
        with mock.patch.object(crq_repair, 'command', return_value=SimpleNamespace(
                returncode=0, stdout='{"status":"ok","value":[]}', stderr='')) as command:
            crq_repair.hack_detector('/x/cli.js', 'diff --git a/x b/x\n', self.wt)
        flag = next(a for a in command.call_args.args[0] if a.startswith('--diff='))
        self.assertEqual(flag, '--diff=diff --git a/x b/x\n')

    def test_detector_findings_reach_the_failure_reason(self):
        commits = self.fix('// eslint-disable-next-line\nexport const a = 2;\n')
        out = self.root / 'A0'
        out.mkdir()
        with self.assertRaisesRegex(ValueError, 'hack detector did not pass: .*suppression'):
            service.mechanical(self.config, self.wt, self.base, commits, 'crq-run1-F1', out)

    def test_indeterminate_and_oversized_diffs_fail_closed(self):
        with self.assertRaisesRegex(ValueError, 'does not parse as a unified diff'):
            crq_repair.hack_detector(str(self.cq_bin), '@/tmp/repair.patch', self.wt)
        big = 'diff --git a/x b/x\n' + '+x\n' * crq_repair.MAX_HACK_DETECTOR_DIFF_BYTES
        with self.assertRaisesRegex(ValueError, 'too large'):
            crq_repair.hack_detector(str(self.cq_bin), big, self.wt)


class CqDriverTest(unittest.TestCase):
    def invoke(self, stdout, returncode=1, pr=None):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        config = {'repo': 'example/repo', 'repair': {'cq_bin': '/unused/cli.js',
                  'budget': {'wall_clock_min': 1, 'max_tokens': 1000}}}
        job = {'job': 'crq-run1-F1', 'pr': pr, 'finding': {'path': 'src/a.ts', 'line': 1, 'body': 'x'},
               'source_snapshot': {}}
        with mock.patch.object(cq, 'command', return_value=SimpleNamespace(
                returncode=returncode, stdout=stdout, stderr='')) as command:
            report = cq.invoke(config, {'model': 'zai/glm-5.3-flash'}, job, Path(tmp.name), Path(tmp.name))
        return report, command.call_args.args[0]

    def test_quota_exhaustion_pauses_like_a_rate_limit(self):
        # 24 runner-host jobs burned A0..A2 in seconds on Z.ai's weekly limit.
        error = ('fixReviewItem: driver reported an error stop (session s); errorClass=quota: '
                 'ai-sdk driver: run failed — Weekly/Monthly Limit Exhausted.')
        report, _ = self.invoke(json.dumps({'status': 'failed', 'error': error}))
        self.assertEqual(report['stop'], 'rate-limit')

    def test_other_failures_stay_errors(self):
        report, _ = self.invoke(json.dumps({'status': 'failed', 'error': 'errorClass=provider'}))
        self.assertEqual(report['stop'], 'error')
        report, _ = self.invoke(json.dumps({'status': 'budget-exhausted'}))
        self.assertEqual(report['stop'], 'budget')

    def test_pr_flag_is_omitted_without_a_positive_pr(self):
        # Backfill and merged-current jobs carry pr 0; review.fixItem rejects
        # `pr: 0` ("Too small: expected number to be >0") but accepts no pr.
        for pr, expected in ((0, None), (None, None), (42, '--pr=42')):
            with self.subTest(pr=pr):
                _, argv = self.invoke('{"status":"ok","value":{"changed":false}}', returncode=0, pr=pr)
                self.assertEqual(next((a for a in argv if a.startswith('--pr=')), None), expected)

    def test_fixer_is_told_its_shell_allowlist(self):
        _, argv = self.invoke('{"status":"ok","value":{"changed":false}}', returncode=0)
        body = json.loads(next(a for a in argv if a.startswith('--item='))[len('--item='):])['body']
        self.assertIn('git grep -n', body)
        harness = json.loads(next(a for a in argv if a.startswith('--harness='))[len('--harness='):])
        self.assertEqual(harness['tools']['run']['commandPatterns'][-len(cq.SEARCH_PATTERNS):],
                         cq.SEARCH_PATTERNS)


ALLOWED = ['git grep -n import.meta.url -- scripts', 'git grep -rn foo', 'git grep foo',
           'git ls-files', 'git ls-files scripts test', 'git ls-tree -r HEAD src',
           'git grep -c needle', 'git grep -n -e def.process -- apps/crq-python/crq_repair.py',
           'git grep --no-textconv x', 'git grep -n a%b+c,d=e@f:g^h']
DENIED = [
    # Executing or escaping options, plain and abbreviated.
    'git grep -O vim x', 'git grep -nO x', 'git grep -Ovim x', 'git grep --open-files-in-pager=vim x',
    'git grep --op=vim x', 'git grep --no-index x /etc', 'git grep --no-ind x', 'git grep --textconv x',
    'git grep --tex x', 'git grep --ext-grep x', 'git ls-files --output=x',
    # Shell rewriting: quotes, backslashes, globs and expansions hide options from the raw text.
    'git grep "-O"touch x', 'git grep "-O"cat" /home/u/.key" pat', "git grep '-O'touch x",
    'git grep -\\O touch x', 'git grep \\-O touch x', 'git grep -"-"open-files-in-pager=id x',
    'git ls-files "--"output=/tmp/x', 'git grep x *', 'git grep x -?', 'git grep x [-]O',
    'git grep x ~/.ssh', 'git grep $HOME x', 'git grep x # comment', 'git grep x  -O',
    # Chaining, substitution, redirection, other programs.
    'git grep x | sh', 'git grep $(id)', 'git grep x > /tmp/o', 'git grep x; id', 'git grep `id`',
    'git grepx', 'git ls-files\nid', 'git ls-files\tx', 'git -c core.pager=id grep x',
    'git show HEAD', 'git show --output=/tmp/x HEAD', 'git show "--"output=/tmp/x HEAD',
    'grep -rn x .', 'rg -n x', 'find . -exec id ;', 'ls', ' git grep x', 'git grep x ']
def allowed(command, matcher):
    return any(matcher(pattern[len('re:'):], command) for pattern in cq.SEARCH_PATTERNS)


class SearchAllowlistTest(unittest.TestCase):
    def test_python_regex_semantics(self):
        match = lambda pattern, command: re.search(pattern, command) is not None
        for command in ALLOWED:
            self.assertTrue(allowed(command, match), command)
        for command in DENIED:
            self.assertFalse(allowed(command, match), command)

    @unittest.skipUnless(shutil.which('node'), 'node is required to check JS RegExp semantics')
    def test_javascript_regex_semantics(self):
        # The harness compiles re: grants with `new RegExp(source)` and tests the full command.
        script = ('const [patterns, commands] = JSON.parse(process.argv[1]);'
                  'console.log(JSON.stringify(commands.map((c) => patterns.some('
                  '(p) => new RegExp(p.slice(3)).test(c)))));')
        out = subprocess.run(['node', '-e', script, json.dumps([cq.SEARCH_PATTERNS, ALLOWED + DENIED])],
                             check=True, capture_output=True, text=True).stdout
        self.assertEqual(json.loads(out), [True] * len(ALLOWED) + [False] * len(DENIED))

    @unittest.skipUnless(Path('/bin/sh').exists(), 'needs /bin/sh, as the harness run tool uses')
    def test_shell_passes_allowed_commands_through_unchanged(self):
        # The guard reads the raw string; the harness runs it with `/bin/sh -c`.
        # Every allowed command must reach git as exactly its space-split
        # tokens, or the guard could be checking something other than argv.
        stub = Path(tempfile.mkdtemp()) / 'git'
        self.addCleanup(shutil.rmtree, stub.parent)
        stub.write_text('#!/bin/sh\nfor a in "$@"; do printf "%s\\0" "$a"; done\n')
        stub.chmod(0o755)
        every_char = 'git grep -n ' + ' '.join(ch * 2 for ch in 'A_./:=@%+,^-9z')
        for command in ALLOWED + [every_char]:
            with self.subTest(command=command):
                match = lambda pattern, text: re.search(pattern, text) is not None
                self.assertTrue(allowed(command, match))
                out = subprocess.run(['/bin/sh', '-c', str(stub) + command[len('git'):]], check=True,
                                     capture_output=True, text=True, cwd=stub.parent).stdout
                self.assertEqual(out.split('\0')[:-1], command.split(' ')[1:])


if __name__ == '__main__':
    unittest.main()
