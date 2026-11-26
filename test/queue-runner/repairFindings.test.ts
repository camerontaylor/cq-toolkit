/**
 * Differential: `parseRepairFindings` against the committed output of the
 * production Python `crq_repair.findings` (apps/crq-python/repair_findings_vectors.py),
 * byte-exact over the rows' `json.dumps` text, plus the file-backed binding.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pythonJsonText } from '../../src/policy/crq/pythonJson.js';
import { fileRepairBackfillEffects } from '../../src/adapters/crq/repairBackfillSource.js';
import { PyError } from '../../src/queue-runner/pyErrors.js';
import { repairEnqueue } from '../../src/queue-runner/repairBackfill.js';
import { parseRepairFindings } from '../../src/queue-runner/repairFindings.js';

interface Expected {
  readonly rows_text?: string;
  readonly error?: [string, string];
}
interface Case {
  readonly name: string;
  readonly bytes_b64: string;
  readonly plain: Expected;
  readonly provenance: Expected;
}

const fixture = JSON.parse(
  readFileSync(
    new URL('../../apps/crq-python/fixtures/crq-repair-findings/cases.json', import.meta.url),
    'utf8',
  ),
) as { schema: string; cases: Case[] };

/** Python's `findings(...)` rows: `_source` is folded into the finding when provenance is on. */
function render(bytes: Uint8Array, provenance: boolean): Expected {
  try {
    const rows = parseRepairFindings(bytes, provenance).map((r) =>
      provenance ? { ...r.finding, _source: r.source } : r.finding,
    );
    return {
      rows_text: pythonJsonText(rows, {
        asciiOnly: true,
        sortKeys: false,
        indent: null,
        spacedSeparators: true,
      }),
    };
  } catch (e) {
    if (e instanceof PyError) return { error: [e.kind, e.message] };
    throw e;
  }
}

describe('parseRepairFindings against Python crq_repair.findings', () => {
  it('pins the fixture schema and size', () => {
    expect(fixture.schema).toBe('cq.crq-repair-findings-vector/v1');
    expect(fixture.cases.length).toBeGreaterThan(300);
  });

  for (const c of fixture.cases) {
    it(`${c.name}: plain and provenance`, () => {
      const bytes = Buffer.from(c.bytes_b64, 'base64');
      expect(render(bytes, false)).toEqual(c.plain);
      // `_source` precedes nothing in Python's dict: it is the last key, as here.
      expect(render(bytes, true)).toEqual(c.provenance);
    });
  }
});

describe('the file-backed findings binding', () => {
  const setup = (review: Uint8Array | null) => {
    const root = mkdtempSync(join(tmpdir(), 'crq-findings-'));
    if (review) {
      mkdirSync(join(root, 'runs', 'r1'), { recursive: true });
      writeFileSync(join(root, 'runs', 'r1', 'review.ndjson'), review);
    }
    return fileRepairBackfillEffects({
      stateRoot: root,
      runsRoot: join(root, 'runs'),
      ledgerRoot: join(root, 'ledger'),
      primaryRepo: 'o/r',
      defaultRef: 'origin/main',
      mergedCurrentEnabled: false,
      maxRoundsPerPin: 2,
      git: (...args) =>
        Promise.resolve(args[0] === 'rev-list' ? '' : args[0] === 'diff' ? 'DIFF' : 'tip'),
      iso: () => '2026-11-27T00:00:00Z',
    });
  };

  it('reads RUNS/<run>/review.ndjson and feeds repairEnqueue without an injected parser', async () => {
    const line = JSON.stringify({
      type: 'finding',
      severity: 'major',
      fileName: 'a.py',
      comment: 'bad at line 4',
      title: 'T',
      id: 'x1',
    });
    const fx = setup(Buffer.from(`${line}\n`));
    const queue = { items: [] as Record<string, unknown>[] };
    const item: Record<string, unknown> = { id: 'i1', kind: 'open', pr: 5, repo: 'o/r' };
    queue.items.push(item);
    const queued = await repairEnqueue(
      queue,
      item,
      { run_id: 'r1', base: 'b', head: 'h', pr_branch: 'br' },
      fx,
      'r1',
    );
    expect(queued).toBe(true);
    const job = await fx.readInbox('crq-r1-F1');
    expect(job?.finding).toEqual({
      severity: 'major',
      path: 'a.py',
      line: 4,
      body: 'bad at line 4',
    });
    expect(job?.source).toEqual({ id: 'x1', run: 'r1', finding_number: 1 });
  });

  it('a missing review.ndjson is the OSError Python raises', async () => {
    const fx = setup(null);
    await expect(fx.findings('r1', true)).rejects.toMatchObject({ kind: 'FileNotFoundError' });
  });
});
