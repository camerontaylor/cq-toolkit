// M10d: render the local monthly measurement readout (ADR-0008 vocabulary).
// Pure rendering of already-computed evidence — the M10c measurement panels,
// the M10e outcome panels and the M10b reader totals with its unknown bucket —
// over one explicit UTC [start,end) window of exactly 30 days. No panel
// arithmetic is redone here, no cross-run success ratio or causal score is
// derived, unknown renders as unknown (never zero, never a count), every
// panel section states the window, and identical inputs render byte-identical
// JSON and Markdown. Corrupt panel shapes are refused at render time, never
// rendered as fabricated figures; untrusted text renders inert (line breaks
// collapse, pipes escape); identical unknown rows across the two buckets
// collapse. The window is a caller-declared label: the renderer does not
// verify the panels fall inside it. The CLI reads one explicit local input
// artifact and writes the two reports beside it; no provider is called and no
// engine state is written.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DAY_MS = 86_400_000;
// z.iso.datetime({ precision: 3 }): shape, parse and calendar round-trip must
// all agree — Feb 30 or hour 24 rolls over and fails the round-trip, and an
// offset form would be read outside UTC, so only the strict Z form is a stamp.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const KNOWN = new Set(['known', 'known-zero']);
const instantMs = (stamp) => {
  if (typeof stamp !== 'string' || !INSTANT.test(stamp)) return null;
  const ms = Date.parse(stamp);
  return Number.isNaN(ms) || new Date(ms).toISOString() !== stamp ? null : ms;
};
const need = (condition, message) => {
  if (!condition) throw new TypeError(`renderMeasurementReport: ${message}`);
};
const availMap = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.values(value).every(
    (entry) =>
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry.state === 'string' &&
      typeof entry.reason === 'string',
  );
const unknownRows = (rows) =>
  Array.isArray(rows) &&
  rows.every(
    (row) =>
      row !== null &&
      typeof row === 'object' &&
      typeof row.source === 'string' &&
      typeof row.kind === 'string' &&
      typeof row.reason === 'string',
  );
const shaList = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === 'string' && SHA.test(item));

/** Render the monthly readout from already-computed panels; deterministic, pure. */
export function renderMeasurementReport({
  window,
  artifacts = [],
  measurement,
  outcome,
  reader,
} = {}) {
  need(window !== null && typeof window === 'object', 'window is required');
  const start = instantMs(window.start);
  const end = instantMs(window.end);
  need(
    start !== null && end !== null,
    'window start and end must be UTC ISO-8601 instants (Z form, milliseconds)',
  );
  need(end > start, 'window end must be after window start');
  need(end - start === 30 * DAY_MS, 'window must span exactly 30 days ([start,end))');
  need(
    Array.isArray(artifacts) &&
      artifacts.every((item) => typeof item === 'string' && item.length > 0),
    'artifacts must be an array of non-empty strings',
  );
  const { fix, cost } = measurement ?? {};
  const { harm, missed, population } = outcome ?? {};
  need(Array.isArray(fix?.runs), 'measurement must be computeMeasurementPanels output (fix.runs)');
  need(
    fix.runs.every((run) => shaList(run.verifiedCommits)),
    'fix.runs rows must carry arrays of sha verified commits',
  );
  need(
    cost !== null &&
      typeof cost === 'object' &&
      cost.usageChannels !== null &&
      typeof cost.usageChannels === 'object' &&
      !Array.isArray(cost.usageChannels) &&
      availMap(cost.availability),
    'measurement must be computeMeasurementPanels output (cost panel)',
  );
  need(
    [harm, missed, population].every((panel) => panel !== null && typeof panel === 'object') &&
      (harm.ciRed?.observedHeads === null || shaList(harm.ciRed.observedHeads)) &&
      (harm.ciRed?.unobservedHeads === null || shaList(harm.ciRed.unobservedHeads)),
    'outcome must be computeOutcomePanels output',
  );
  need(unknownRows(outcome?.unknown), 'outcome.unknown must be unknown-evidence rows');
  need(
    reader?.totals !== null &&
      typeof reader?.totals === 'object' &&
      availMap(reader.totals.availability),
    'reader.totals must be the readMeasurementInputs totals',
  );
  need(unknownRows(reader.unknown), 'reader.unknown must be unknown-evidence rows');
  // count() and figure() are the render-time shape guards: null is the honest
  // unknown, counts accept only numbers, identifiers also accept strings, and
  // anything else (undefined or corrupt on a panel row) is refused rather
  // than rendered as a fabricated figure.
  const count = (value) => {
    if (value === null) return 'unknown';
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new TypeError('renderMeasurementReport: counts and totals must be numbers or null');
    return String(value);
  };
  const figure = (value) => {
    if (value === null) return 'unknown';
    if (typeof value !== 'number' && typeof value !== 'string')
      throw new TypeError('renderMeasurementReport: identifiers must be numbers, strings or null');
    return String(value);
  };
  /** Untrusted text renders inert in Markdown: line breaks collapse, pipes escape. */
  const md = (text) =>
    String(text).replaceAll('\r', ' ').replaceAll('\n', ' ').replaceAll('|', '\\|');
  // A non-known total never renders its stored number: unavailable,
  // not-collected and n-a render unknown; partial keeps an explicitly
  // labelled subtotal.
  const stated = (value, entry) => {
    if (entry == null) return `${count(value)} (availability unstated)`;
    if (entry.state === 'partial') return `${count(value)} subtotal (partial: ${md(entry.reason)})`;
    if (!KNOWN.has(entry.state)) return `unknown (${md(entry.state)}: ${md(entry.reason)})`;
    return `${count(value)} (${entry.state})`;
  };
  const span = `[${window.start}, ${window.end})`;
  const refs = [...new Set(artifacts)].sort();
  // Identical rows in both buckets are one unknown entry (reader first), like
  // duplicate artifact references.
  const unknown = [];
  const seenUnknown = new Set();
  for (const row of [...reader.unknown, ...outcome.unknown]) {
    const key = `${row.source}\u0000${row.kind}\u0000${row.reason}`;
    if (seenUnknown.has(key)) continue;
    seenUnknown.add(key);
    unknown.push(row);
  }
  const escape = (name) => name.replaceAll('~', '~0').replaceAll('/', '~1');
  const lines = [
    '# cq-toolkit monthly measurement readout',
    '',
    `- window: ${span} — 30 days, UTC (explicit [start,end))`,
    `- evidence artifacts: ${refs.length} referenced`,
    '- per-run figures only: no cross-run success ratio, no causal score',
    '',
    '## Evidence artifacts',
    '',
    ...(refs.length === 0 ? ['- (none)'] : refs.map((ref) => `- ${md(ref)}`)),
    '',
    '## Unknown evidence',
    '',
    ...(unknown.length === 0
      ? ['- (none)']
      : unknown.map((row) => `- ${md(row.source)} — ${md(row.kind)}: ${md(row.reason)}`)),
    '',
    `## Fix panel — window ${span}`,
    '',
    '| repo | run | numerator | denominator | verified commits |',
    '| --- | --- | --- | --- | --- |',
    ...fix.runs.map(
      (run) =>
        `| ${run.repo === null ? '-' : md(figure(run.repo))} | ${md(figure(run.runId))} | ${count(run.fixesPerRun.numerator)} | ${count(run.fixesPerRun.denominator)} | ${md(run.verifiedCommits.join(', ')) || '-'} |`,
    ),
    '',
    `## Cost panel — window ${span}`,
    '',
    // An empty channel set is stated, never silently blank: the umbrella
    // availability entry says why no channel was observed.
    ...(Object.keys(cost.usageChannels).length === 0
      ? [`- usage channels: ${stated(null, cost.availability['/usageChannels'])}`]
      : Object.entries(cost.usageChannels).map(
          ([name, value]) =>
            `- usage channel ${md(name)}: ${stated(value, cost.availability[`/usageChannels/${escape(name)}`])}`,
        )),
    `- attempt wall (ms): ${stated(cost.attemptWallMs, cost.availability['/attemptWallMs'])}`,
    `- run elapsed (ms): ${stated(cost.runElapsedMs, cost.availability['/runElapsedMs'])}`,
    `- modeled USD: ${stated(cost.modeledUsd, cost.availability['/modeledUsd'])}`,
    `- price table: ${md(figure(cost.priceTableRevision))}; coverage: ${md(figure(cost.priceCoverage))}`,
    '',
    `## Harm panel — window ${span}`,
    '',
    `- re-fixes: ${count(harm.refix.candidates)} candidates, ${count(harm.refix.explained)} explained, ${count(harm.refix.unknown)} unknown`,
    `- CI red: flake ${count(harm.ciRed.flake)}, regression ${count(harm.ciRed.regression)}, infrastructure ${count(harm.ciRed.infrastructure)}, unknown ${count(harm.ciRed.unknown)}`,
    harm.ciRed.observedHeads === null
      ? '- CI red coverage: not examined — counts are unknown, never zero'
      : `- CI red coverage: ${harm.ciRed.observedHeads.length} heads examined${harm.ciRed.unobservedHeads === null || harm.ciRed.unobservedHeads.length === 0 ? '' : `; ${harm.ciRed.unobservedHeads.length} eligible heads unexamined (${harm.ciRed.unobservedHeads.join(', ')})`}`,
    '',
    `## Missed panel — window ${span}`,
    '',
    `- restored crq findings: ${count(missed.restored.missed)} missed, ${count(missed.restored.notMissed)} not missed, ${count(missed.restored.unknown)} unknown`,
    '',
    `## Population panel — window ${span}`,
    '',
    `- eligible: ${count(population.eligible)}; mature: ${count(population.mature)}; right-censored: ${count(population.rightCensored)}; follow-up window: ${count(population.followUpDays)} days`,
    '',
    '## Reader totals',
    '',
    `- attempts: ${stated(reader.totals.attempts, reader.totals.availability['/attempts'])}`,
    `- tokens: ${stated(reader.totals.tokens, reader.totals.availability['/tokens'])}`,
    `- wall (ms): ${stated(reader.totals.wallMs, reader.totals.availability['/wallMs'])}`,
    `- modeled USD: ${stated(reader.totals.modeledUsd, reader.totals.availability['/modeledUsd'])}`,
    '',
  ];
  const report = {
    window: { start: window.start, end: window.end, days: 30 },
    artifacts: refs,
    panels: { fix, cost, harm, missed, population },
    reader: { totals: reader.totals },
    unknown,
  };
  return { report, json: JSON.stringify(report, null, 2), markdown: `${lines.join('\n')}\n` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const value = args[args.indexOf(name) + 1];
    return args.includes(name) && !value?.startsWith('--') ? value : undefined;
  };
  const input = option('--input');
  if (input === undefined) {
    // I1: the machine-readable error object goes to stdout and the human
    // usage narration to stderr — never mixed onto one stream.
    console.log(
      JSON.stringify({ error: { message: 'missing required --input <readout-input.json>' } }),
    );
    console.error(
      'usage: node scripts/measurement-rollup.mjs --input <readout-input.json> [--out <dir>]',
    );
    process.exitCode = 2;
  } else
    try {
      const rendered = renderMeasurementReport(JSON.parse(await readFile(input, 'utf8')));
      const out = option('--out') ?? '.';
      await mkdir(out, { recursive: true });
      await writeFile(join(out, 'measurement-readout.json'), `${rendered.json}\n`, 'utf8');
      await writeFile(join(out, 'measurement-readout.md'), rendered.markdown, 'utf8');
      console.log(
        JSON.stringify({
          json: join(out, 'measurement-readout.json'),
          markdown: join(out, 'measurement-readout.md'),
        }),
      );
    } catch (error) {
      const message = String(error?.message ?? error);
      console.log(JSON.stringify({ error: { message } }));
      console.error(message);
      process.exitCode = 1;
    }
}
