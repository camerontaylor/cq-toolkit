// Slice C — the merge-queue gate's fail-closed mechanics, tested over the
// generated workflow (.github/workflows/merge-queue-gate.yml) and its source
// of truth (policy/templates/merge-queue-gate.yml). The extracted programs
// and guards are byte-compared across both files; after that identity check,
// the real awk matrix and shell guard run once against the shared copy.
//
// Pinned here:
//   1. The awk verdict program (extracted verbatim from each file and run as
//      a real `awk -f` program): exact verdict strings for the whole matrix —
//      pass requires EVERY matching row completed+success; a terminal
//      failure outranks waiting; a terminal `skipped` is neither pass nor
//      fail (I4: a skipped required check is missing, and missing = failing)
//      and outranks waiting but never failure; no rows at all -> missing.
//   2. The fail-closed empty-checks guard (extracted verbatim): an empty
//      check list must exit 1 with the refusing message BEFORE the wait loop
//      can spin zero times and promote; a populated list passes the guard
//      (positive control, exit 0) in both files.
//   3. The promotion text: the on-queue guard, the promotion-review
//      requirement (status context, the pinned reviewer bot, reviewed base,
//      no push trigger), the skipped case branch, the awaiting exit (green,
//      no promotion), and a checkout pinned to exactly 40 lowercase hex
//      chars.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const GATE_FILES = [
  { label: 'generated', path: join(ROOT, '.github/workflows/merge-queue-gate.yml') },
  { label: 'template', path: join(ROOT, 'policy/templates/merge-queue-gate.yml') },
];

// The awk verdict program: everything after the line assigning it via
// `awk -F'\t'`, up to (not including) the closing `')"` line, joined with \n.
function extractAwkProgram(text: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes("awk -F'\\t'"));
  if (start === -1) throw new Error('no awk verdict program found');
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '\')"') break;
    body.push(line);
  }
  if (body.length === 0) throw new Error('empty awk verdict program');
  return body.join('\n');
}

// The fail-closed guard: the `checks="$(echo ...)"` line plus the six lines
// after it (two comment lines, if, echo, exit, fi).
function extractFailClosedSnippet(text: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes('checks="$(echo'));
  if (start === -1) throw new Error('no checks= line found');
  return lines.slice(start, start + 7).join('\n');
}

// One gate's check list is quoted differently per file ('static,denylist'
// generated, '{{GATE_CHECKS}}' template); normalize it so one snippet runner
// serves both. Plain string surgery (no regex: a literal `$(` inside a
// RegExp literal is an end-of-input anchor, and escaping it trips
// no-useless-escape), then wrap with set -euo pipefail like the real step.
function scriptFor(text: string, list: string): string {
  const snippet = extractFailClosedSnippet(text);
  const marker = `checks="$(echo '`;
  const start = snippet.indexOf(marker);
  if (start === -1) throw new Error('checks= echo list not found');
  const close = snippet.indexOf(`'`, start + marker.length);
  if (close === -1) throw new Error('checks= echo list is unterminated');
  const substituted = `${snippet.slice(0, start + marker.length)}${list}${snippet.slice(close)}`;
  return `set -euo pipefail\n${substituted}\n`;
}

// The promotion step's run script: from the `set -euo pipefail` that follows
// the step's name line through the final `promoted ${SHA} to main by pure
// fast-forward` echo (inclusive).
function extractPromotionScript(text: string): string {
  const lines = text.split(/\r?\n/);
  const nameLine = lines.findIndex((line) => line.includes('Fast-forward promote the gated sha'));
  if (nameLine === -1) throw new Error('promotion step not found');
  const start = lines.findIndex((line, i) => i > nameLine && /^ {10}set -euo pipefail$/.test(line));
  if (start === -1) throw new Error('promotion run script not found');
  const end = lines.findIndex(
    (line, i) => i >= start && line.includes('promoted ${SHA} to main by pure fast-forward'),
  );
  if (end === -1) throw new Error('promotion script tail not found');
  return lines.slice(start, end + 1).join('\n');
}

// The verdict matrix: @tsv rows ([name, status, conclusion]) in, exact
// verdict string out (the string the workflow's case statement receives).
const VERDICT_CASES: ReadonlyArray<{ name: string; rows: string; expected: string }> = [
  {
    name: 'two suites, both green -> pass',
    rows: 'static\tcompleted\tsuccess\nstatic\tcompleted\tsuccess',
    expected: 'pass',
  },
  { name: 'no rows -> missing', rows: '', expected: 'missing' },
  {
    name: 'incomplete row -> waiting in_progress',
    rows: 'static\tin_progress\t',
    expected: 'waiting in_progress',
  },
  {
    name: 'terminal failure -> failing failure',
    rows: 'static\tcompleted\tfailure',
    expected: 'failing failure',
  },
  {
    name: 'skipped is neither pass nor fail -> skipped skipped (I4)',
    rows: 'static\tcompleted\tskipped',
    expected: 'skipped skipped',
  },
  {
    name: 'terminal failure outranks skipped',
    rows: 'static\tcompleted\tfailure\nstatic\tcompleted\tskipped',
    expected: 'failing failure',
  },
  {
    name: 'terminal skipped outranks waiting',
    rows: 'static\tin_progress\t\nstatic\tcompleted\tskipped',
    expected: 'skipped skipped',
  },
  {
    name: 'pass requires EVERY row success',
    rows: 'static\tcompleted\tsuccess\nstatic\tin_progress\t',
    expected: 'waiting in_progress',
  },
  {
    name: 'success beside skipped -> skipped skipped',
    rows: 'static\tcompleted\tsuccess\nstatic\tcompleted\tskipped',
    expected: 'skipped skipped',
  },
];

describe('merge-queue-gate: fail-closed mechanics (generated file and template in lockstep)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gate-mechanics-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const gates = GATE_FILES.map(({ label, path }) => {
    const text = readFileSync(path, 'utf8');
    const progFile = join(tmp, `verdict-${label}.awk`);
    writeFileSync(progFile, extractAwkProgram(text)); // written once per file
    return { label, text, progFile };
  });

  // Identity lockstep: the behavioral matrix below can only catch drift the
  // cases exercise — these string-identity checks catch ALL drift.
  it('extracted program and guard snippet are byte-identical across the files', () => {
    const [generated, template] = gates;
    if (generated === undefined || template === undefined)
      throw new Error('both workflow sources are required');
    expect(
      extractAwkProgram(generated.text),
      'the files drifted outside the behavioral cases: the awk verdict program',
    ).toBe(extractAwkProgram(template.text));
    // Each file quotes its check list differently ('static,denylist,ratchet'
    // generated — whatever the wait list currently holds — and
    // '{{GATE_CHECKS}}' template) — the sanctioned token-level divergence of
    // the instantiation (the whole-file lockstep is template-render.test.ts).
    // Normalize BOTH to a placeholder before comparing; ANY other drift still
    // fails. The generated list is matched by SHAPE, and
    // only as the `echo` argument (`(echo )'[a-z]+(?:,[a-z]+)*'` — a bare `tr ','` must
    // NOT match, whose comma is in the class but is not the wait list), so a
    // future wait-list change ('static,denylist,ratchet' was the second
    // entry) cannot re-break the identity assertion — only real drift can.
    // The template placeholder keeps its exact-match replacement
    // ('{{GATE_CHECKS}}' is uppercase and braced, outside the shape).
    const normalize = (text: string): string =>
      extractFailClosedSnippet(text)
        .replace(/(echo )'[a-z]+(?:,[a-z]+)*'/, `$1'<LIST>'`)
        .replace(`'{{GATE_CHECKS}}'`, `'<LIST>'`);
    expect(
      normalize(generated.text),
      'the files drifted outside the behavioral cases: the fail-closed guard snippet',
    ).toBe(normalize(template.text));
  });

  // The identity assertion above proves both sources are byte-identical.
  // Execute the matrix and guard once against that shared copy: 9 awk + 2
  // bash instead of repeating the same programs for the template copy.
  // Three observed runs took 34.26–46.61s; 100s is over 2× the slowest
  // run while still bounding the 9-awk process matrix against a stall.
  it('runs the exact verdict matrix through the shared awk program', { timeout: 100_000 }, () => {
    const { label, progFile } = gates[0]!;
    for (const testCase of VERDICT_CASES) {
      const verdict = execFileSync('awk', ['-F', '\t', '-v', 'c=static', '-f', progFile], {
        input: testCase.rows,
        encoding: 'utf8',
      }).trim();
      expect(verdict, `${label}: ${testCase.name}`).toBe(testCase.expected);
    }
  });

  describe('fail-closed empty-checks guard', () => {
    const { label, text } = gates[0]!;
    it(`refuses an empty check list with exit 1 before any waiting (${label})`, () => {
      const script = join(tmp, `empty-${label}.sh`);
      writeFileSync(script, scriptFor(text, ''));
      const res = spawnSync('bash', [script], { encoding: 'utf8' });
      const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
      expect(res.status, output).toBe(1);
      expect(output).toContain('refusing: GATE_CHECKS is empty');
    });

    it(`positive control: a populated check list passes the guard with exit 0 (${label})`, () => {
      const script = join(tmp, `populated-${label}.sh`);
      writeFileSync(script, scriptFor(text, 'static,denylist'));
      const res = spawnSync('bash', [script], { encoding: 'utf8' });
      expect(res.status, `${res.stdout ?? ''}${res.stderr ?? ''}`).toBe(0);
    });
  });

  describe('promotion guards, review signal, skipped refusal, and the checkout pin', () => {
    for (const { label, text } of gates) {
      it(`carries the queue guard, the review signal, the skipped branch, a 40-hex pin (${label})`, () => {
        expect(text, `${label}: the on-queue guard`).toContain('is not on merge-queue');
        // Batch policy: promotion needs the crq/promotion-review status from
        // an allowed USER, bound to a reviewed base, and no push trigger.
        expect(text, `${label}: the review status context`).toContain(
          "github.event.context == 'crq/promotion-review'",
        );
        expect(text, `${label}: the pinned reviewer bot filter`).toContain(
          '.type == "Bot" and .login == $bot_login and .cid == $bot_id',
        );
        expect(text, `${label}: the reviewed-base binding`).toContain('REVIEW_BASE');
        expect(text, `${label}: no push trigger`).not.toMatch(/^ {2}push:/m);
        expect(text, `${label}: the skipped case branch`).toContain('concluded skipped');
        // Waiting is not failing: an unreviewed or blocked sha ends green
        // and promotes nothing; every step after the review is skipped.
        expect(text, `${label}: the awaiting summary`).toContain('awaiting promotion review');
        expect(
          text.match(/^ {8}if: steps\.review\.outputs\.promote == 'true'$/gm)?.length,
          `${label}: wait, checkout, validate and promote run only for a reviewed sha`,
        ).toBe(4);
        const checkoutLines = text
          .split(/\r?\n/)
          .filter((line) => line.includes('uses: actions/checkout@'));
        expect(checkoutLines.length, `${label}: at least one checkout step`).toBeGreaterThanOrEqual(
          1,
        );
        for (const line of checkoutLines) {
          const ref = /uses: actions\/checkout@([^@\s]+)/.exec(line)?.[1] ?? '';
          expect(
            ref,
            `${label}: checkout pin must be exactly 40 lowercase hex chars: ${line.trim()}`,
          ).toMatch(/^[0-9a-f]{40}$/);
        }
      });
    }

    // Identity lockstep: the presence checks above can pass with a one-file
    // revert; the promotion run script itself must be byte-identical.
    it('the promotion step run script is byte-identical across the files (identity lockstep)', () => {
      const [generated, template] = gates;
      if (generated === undefined || template === undefined)
        throw new Error('both workflow sources are required');
      const gen = extractPromotionScript(generated.text);
      const tmpl = extractPromotionScript(template.text);
      expect(gen, 'the promotion step drifted between template and instantiation').toBe(tmpl);
      expect(gen, 'the promotion step must carry no template tokens').not.toContain('{{');
    });
  });
});

describe('merge-queue-gate: the pinned-reviewer trust filter (REVIEW_JQ, files in lockstep)', () => {
  // REVIEW_JQ verbatim from each file. The jq program is token-free ($bot_login
  // and $bot_id arrive as jq variables from the step that runs it), so the
  // extraction is byte-identical across the generated file and the template.
  const extractReviewJq = (text: string): string => {
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((line) => line.trim().startsWith('REVIEW_JQ:'));
    if (start === -1) throw new Error('no REVIEW_JQ found');
    const body: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (line.startsWith('        ')) body.push(line.slice(8));
      else break;
    }
    if (body.length === 0) throw new Error('empty REVIEW_JQ program');
    return body.join('\n');
  };

  const sources = GATE_FILES.map(({ label, path }) => ({
    label,
    text: readFileSync(path, 'utf8'),
  }));

  // Fixture identity for the jq matrix, deliberately NOT any real App: the
  // matrix exercises the filter's LOGIC, and identity values live only in
  // instances.json — filled from the owner's registration record.
  const BOT_LOGIN = 'promo-review-fixture[bot]';
  const BOT_ID = 4242424242;
  const BASE = 'a'.repeat(40);
  const creator = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    login: BOT_LOGIN,
    type: 'Bot',
    id: BOT_ID,
    ...over,
  });
  const status = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    context: 'crq/promotion-review',
    id: 1,
    state: 'success',
    description: `reviewed main=${BASE} crq#promo-0000000000`,
    created_at: '2026-10-04T00:00:00Z',
    creator: creator(),
    ...over,
  });
  const run = (pages: unknown, botId: number | string = BOT_ID): Record<string, unknown> =>
    JSON.parse(
      execFileSync(
        'jq',
        [
          '-s',
          '--arg',
          'bot_login',
          BOT_LOGIN,
          '--argjson',
          'bot_id',
          String(botId),
          extractReviewJq(sources[0]!.text),
        ],
        // gh api --paginate prints ONE JSON ARRAY PER PAGE, back to back;
        // `jq -s` slurps that stream into an array of pages. Feed the same
        // stream shape (one document per page), never a pre-slurped nesting.
        {
          input: (pages as readonly unknown[]).map((page) => JSON.stringify(page)).join('\n'),
          encoding: 'utf8',
        },
      ),
    ) as Record<string, unknown>;

  it('REVIEW_JQ is byte-identical and each trust step consumes the identity source', () => {
    const [generated, template] = sources;
    if (generated === undefined || template === undefined)
      throw new Error('both workflow sources are required');
    expect(
      extractReviewJq(generated.text),
      'the trust filter drifted between template and instantiation',
    ).toBe(extractReviewJq(template.text));
    const identity = JSON.parse(
      readFileSync(join(ROOT, 'policy/promotion-reviewer.json'), 'utf8'),
    ) as { login: string; id: number; type: string; schemaVersion: number };
    for (const { text, label } of sources) {
      expect(text, label).not.toContain(identity.login);
      expect(text, label).not.toContain(String(identity.id));
      expect(text, label).not.toMatch(/\{\{REVIEWER_BOT_(?:LOGIN|ID)\}\}/);
      expect(text, label).not.toContain('cq-reviewer[bot]');
      expect(text, label).not.toContain('202921479');

      const document = parseDocument(text, { uniqueKeys: true });
      expect(document.errors, `${label}: valid workflow YAML`).toEqual([]);
      const parsed = document.toJS() as {
        jobs?: { gate?: { steps?: Array<{ id?: string; name?: string; run?: unknown }> } };
      };
      const steps = parsed.jobs?.gate?.steps ?? [];
      const reviewSteps = steps.filter((step) => step.id === 'review');
      const promoteSteps = steps.filter(
        (step) => step.name === 'Fast-forward promote the gated sha (guarded)',
      );
      expect(reviewSteps, `${label}: unique review trust step`).toHaveLength(1);
      expect(promoteSteps, `${label}: unique pre-push trust step`).toHaveLength(1);
      const trustSteps = [
        reviewSteps[0],
        promoteSteps[0],
      ];
      for (const [index, step] of trustSteps.entries()) {
        if (step === undefined || typeof step.run !== 'string') {
          throw new Error(`${label}: trust step ${index + 1} is missing its run script`);
        }
        const script = step.run
          .split(/\r?\n/)
          .filter((line) => !line.trimStart().startsWith('#'))
          .join('\n');
        expect(script, `${label}: trust step ${index + 1} fetches at GITHUB_SHA`).toContain(
          'contents/policy/promotion-reviewer.json?ref=${GITHUB_SHA}',
        );
        expect(script, `${label}: trust step ${index + 1} extracts login`).toContain(
          'jq -r .login <<<"${reviewer_json}"',
        );
        expect(script, `${label}: trust step ${index + 1} extracts id`).toContain(
          'jq -r .id <<<"${reviewer_json}"',
        );
        expect(script, `${label}: trust step ${index + 1} binds both values to REVIEW_JQ`).toMatch(
          /jq -s --arg bot_login "\$\{reviewer_login\}" \\\s*--argjson bot_id "\$\{reviewer_id\}" "\$\{REVIEW_JQ\}"/,
        );
      }
    }
    const instances = JSON.parse(
      readFileSync(join(ROOT, 'policy/templates/instances.json'), 'utf8'),
    ) as Array<{ workflow: string; tokens: Record<string, string> }>;
    const gate = instances.find((entry) => entry.workflow === 'merge-queue-gate.yml');
    expect(gate?.tokens['REVIEWER_BOT_LOGIN']).toBeUndefined();
    expect(gate?.tokens['REVIEWER_BOT_ID']).toBeUndefined();
    const protectedPaths = JSON.parse(
      readFileSync(join(ROOT, 'policy/protected-paths.json'), 'utf8'),
    ) as { protectedPaths: string[] };
    expect(protectedPaths.protectedPaths).toContain('^policy/promotion-reviewer\\.json$');
  });

  it('trusts only creator type Bot + pinned login + numeric id, newest wins', () => {
    // The pinned bot's success is the review; cid is projected as a number.
    const only = run([[status()]]);
    expect(only['review']).toMatchObject({ id: 1, state: 'success', cid: BOT_ID });
    expect(only['others']).toBe(0);

    // Same login, wrong numeric id: untrusted — and with no trusted review
    // plus others > 0 this is exactly the red-refusal input shape.
    const wrongId = run([[status({ id: 2, creator: creator({ id: BOT_ID + 1 }) })]]);
    expect(wrongId['review']).toBeNull();
    expect(wrongId['others']).toBe(1);

    // A string-typed id does not satisfy the numeric pin.
    const stringId = run([[status({ id: 3, creator: creator({ id: String(BOT_ID) }) })]]);
    expect(stringId['review']).toBeNull();
    expect(stringId['others']).toBe(1);

    // The repository owner's own User login is untrusted (PR-B's point).
    const owner = run([
      [status({ id: 4, creator: { login: 'camerontaylor', type: 'User', id: 1 } })],
    ]);
    expect(owner['review']).toBeNull();
    expect(owner['others']).toBe(1);

    // GITHUB_TOKEN's github-actions bot is untrusted too.
    const actions = run([
      [status({ id: 5, creator: { login: 'github-actions[bot]', type: 'Bot', id: 15368 } })],
    ]);
    expect(actions['review']).toBeNull();
    expect(actions['others']).toBe(1);

    // Newest by (created_at, id): a later failure overrides an earlier
    // success (a blocking finding), an earlier failure yields to a later
    // success, and an id tiebreak breaks an identical timestamp.
    const laterFailure = run([
      [status(), status({ id: 6, state: 'failure', created_at: '2026-10-04T00:01:00Z' })],
    ]);
    expect(laterFailure['review']).toMatchObject({ id: 6, state: 'failure' });
    const laterSuccess = run([
      [status({ state: 'failure' }), status({ id: 7, created_at: '2026-10-04T00:01:00Z' })],
    ]);
    expect(laterSuccess['review']).toMatchObject({ id: 7, state: 'success' });
    const idTiebreak = run([
      [
        status({ id: 9, created_at: '2026-10-04T00:00:00Z' }),
        status({ id: 8, created_at: '2026-10-04T00:00:00Z' }),
      ],
    ]);
    expect(idTiebreak['review']).toMatchObject({ id: 9 });

    // A trusted review coexisting with untrusted statuses selects the review
    // and counts the others (noted, not red). A foreign-context status is
    // filtered out before the trust split and never counts at all.
    const mixed = run([
      [
        status({ id: 10 }),
        status({ id: 11, creator: { login: 'camerontaylor', type: 'User', id: 1 } }),
        status({
          id: 12,
          context: 'other-context',
          creator: { login: 'someone', type: 'User', id: 2 },
        }),
      ],
    ]);
    expect(mixed['review']).toMatchObject({ id: 10 });
    expect(mixed['others']).toBe(1);

    // Two pages: the trusted success arrives on page 2, an untrusted status
    // on page 1 — the filter's `add` must concatenate across pages, which is
    // the whole point of slurping the paginated stream.
    const twoPages = run([
      [status({ id: 13, creator: { login: 'camerontaylor', type: 'User', id: 1 } })],
      [status({ id: 14, created_at: '2026-10-04T00:01:00Z' })],
    ]);
    expect(twoPages['review']).toMatchObject({ id: 14, cid: BOT_ID });
    expect(twoPages['others']).toBe(1);

    // No statuses at all: the await shape (green wait, not red).
    const none = run([]);
    expect(none['review']).toBeNull();
    expect(none['others']).toBe(0);
  });
});
