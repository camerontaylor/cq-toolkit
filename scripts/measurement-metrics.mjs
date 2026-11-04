// Offline fix and cost panel computation for M10c (ADR-0008 vocabulary). Pure
// arithmetic over evidence the M10b reader already admitted — attempt leaves
// (MeasurementInputRecord rows) and its unknown bucket — plus the ADR-0008
// fix vocabulary (closures, baseline failures) and each run's provenance
// window, all passed in explicitly: no file access, no network, nothing read
// beyond the merged shapes. Unknown never becomes zero: a placeholder
// baseline unit never mixes into a failure denominator, an untrusted, torn or
// absent child value never reads as zero, run elapsed (the provenance window)
// is reported beside — never in place of — the summed attempt wall, modeled
// price coverage is stated explicitly rather than implied by a number, and
// fixesPerRun stays per-run with no cross-run ratio. Leaf usage follows the
// M10b dedup identity (repo, runId, invocation): identical copies count once,
// and disagreeing copies are a conflict that contributes nothing. Session
// index parent aggregates stay folded in the reader's own totals; this panel
// computes from leaves only.
const KNOWN_STATES = new Set(['known', 'known-zero']);
const avail = (state, reason) => ({ state, reason, source: null });
const entry = ({ value: _value, ...rest }) => rest;

/** Stable M10b serialization for duplicate-leaf comparison. */
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value !== null && typeof value === 'object'
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(',')}}`
      : JSON.stringify(value);

/** M10b aggregate semantics: known values sum; incomplete evidence yields unavailable (nothing observed) or partial (a subtotal beside unknowns); only fully observed evidence is known, and a fully observed zero is known-zero. */
function aggregate(records, field, label, incomplete, why) {
  const reason = why ?? 'measurement inputs were rejected, incomplete or unavailable';
  const known = records.filter((record) => record[field] !== null);
  if (incomplete && known.length === 0)
    return { value: null, ...avail('unavailable', `no ${label} value was observed; ${reason}`) };
  if (records.length === 0)
    return { value: null, ...avail('n-a', `no ${label} evidence was observed`) };
  if (known.length === 0)
    return { value: null, ...avail('not-collected', `no ${label} value was observed`) };
  const value = known.reduce((sum, record) => sum + record[field], 0);
  if (incomplete || known.length < records.length)
    return {
      value,
      ...avail(
        'partial',
        `observed ${known.length} of ${records.length} ${label} values${incomplete ? `; ${reason}` : ''}`,
      ),
    };
  return {
    value,
    ...avail(
      value === 0 ? 'known-zero' : 'known',
      `observed ${known.length} of ${records.length} ${label} values`,
    ),
  };
}

/** Observed provenance window; ms null when not observed, unparseable or inverted; bad only when both stamps are present yet no window exists. */
const windowOf = (run) => {
  const start = run.startedAt == null ? null : Date.parse(run.startedAt);
  const end = run.endedAt == null ? null : Date.parse(run.endedAt);
  const present = start !== null && end !== null;
  const whole = present && Number.isFinite(start) && Number.isFinite(end) && end >= start;
  return { ms: whole ? end - start : null, bad: present && !whole };
};

/** Compute the fix and cost panels over explicitly provided measurement evidence. */
export function computeMeasurementPanels({ runs, unknown = [] } = {}) {
  if (
    !Array.isArray(runs) ||
    !Array.isArray(unknown) ||
    runs.some((run) => run === null || typeof run !== 'object' || !Array.isArray(run.attempts))
  )
    throw new TypeError(
      'computeMeasurementPanels: runs and unknown must be arrays; every run needs an attempts array',
    );
  const anyUnknown = unknown.length > 0;
  const incomplete = {
    channels: anyUnknown,
    wall: anyUnknown,
    usd: anyUnknown,
    elapsed: anyUnknown,
  };
  // Dedup on the M10b identity (repo, runId, invocation): identical copies
  // count once; disagreeing copies are a conflict that contributes nothing.
  const leaves = [];
  const byInvocation = new Map();
  const conflicted = new Set();
  for (const run of runs)
    for (const record of run.attempts) {
      const key = `${record.repo ?? ''}\u0000${record.runId}\u0000${record.invocation}`;
      if (conflicted.has(key)) continue;
      const prior = byInvocation.get(key);
      if (prior === undefined) {
        byInvocation.set(key, record);
        leaves.push(record);
      } else if (canonical({ ...record, source: null }) !== canonical({ ...prior, source: null })) {
        byInvocation.delete(key);
        conflicted.add(key);
        leaves.splice(leaves.indexOf(prior), 1);
      }
    }
  if (conflicted.size > 0) incomplete.channels = incomplete.wall = incomplete.usd = true;
  // A leaf's own non-known availability degrades the cost totals it feeds,
  // conservatively across all of them (never less than the reader would).
  for (const leaf of leaves)
    if (Object.values(leaf.availability ?? {}).some((record) => !KNOWN_STATES.has(record?.state))) {
      incomplete.channels = incomplete.wall = incomplete.usd = true;
      break;
    }
  const channels = new Map();
  for (const leaf of leaves)
    for (const [name, value] of Object.entries(leaf.usageChannels ?? {}))
      channels.set(name, [...(channels.get(name) ?? []), { value }]);
  const usageChannels = {};
  const usageAvailability = {};
  if (channels.size === 0)
    usageAvailability['/usageChannels'] = entry(
      aggregate([], 'value', 'usage channel', incomplete.channels),
    );
  else
    for (const [name, records] of channels) {
      const total = aggregate(records, 'value', `usage channel ${name}`, incomplete.channels);
      usageChannels[name] = total.value;
      usageAvailability[`/usageChannels/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`] =
        entry(total);
    }
  const wallTotal = aggregate(
    leaves.map((leaf) => ({ wallMs: leaf.wallMs })),
    'wallMs',
    'wall',
    incomplete.wall,
  );
  const windows = runs.map(windowOf);
  const badWindow = windows.some((window) => window.bad);
  const elapsedTotal = aggregate(
    windows.map((window) => ({ ms: window.ms })),
    'ms',
    'run elapsed',
    incomplete.elapsed || badWindow,
    badWindow ? 'a run window is inverted or unparseable' : undefined,
  );
  // Modeled price coverage is explicit: the sum never claims completeness
  // while coverage is absent or mixed across the attempts that priced.
  const coverages = [...new Set(leaves.map((leaf) => leaf.priceCoverage))];
  const revisions = [...new Set(leaves.map((leaf) => leaf.priceTableRevision))];
  const uniform = (values) => values.length === 1 && values[0] !== null;
  const coverageIncomplete = leaves.some((leaf) => leaf.modeledUsd !== null) && !uniform(coverages);
  const usdTotal = aggregate(
    leaves.map((leaf) => ({ usd: leaf.modeledUsd })),
    'usd',
    'modeled USD',
    incomplete.usd || coverageIncomplete,
    coverageIncomplete ? 'price coverage is absent or mixed across attempts' : undefined,
  );
  // Fix panel, per-run only, mirroring the ADR-0008 MetricRecord (which
  // carries no availability of its own): the numerator counts distinct
  // verified non-todo commits; a placeholder unit (null count) makes the
  // denominator unknown, with the known subtotal withheld — never mixed in.
  const fixRuns = runs.map((run) => {
    const shas =
      run.closures == null
        ? null
        : [...new Set(run.closures.filter((row) => !row.todo).map((row) => row.commitSha))];
    const units = run.baselineFailures ?? [];
    const whole = run.baselineFailures != null && units.every((unit) => unit.count !== null);
    return {
      repo: run.repo,
      runId: run.runId,
      fixesPerRun: {
        numerator: shas === null ? null : shas.length,
        denominator: whole ? units.reduce((sum, unit) => sum + unit.count, 0) : null,
      },
      verifiedCommits: shas ?? [],
    };
  });
  return {
    fix: { runs: fixRuns },
    cost: {
      usageChannels,
      attemptWallMs: wallTotal.value,
      runElapsedMs: elapsedTotal.value,
      modeledUsd: usdTotal.value,
      priceTableRevision: uniform(revisions) ? revisions[0] : null,
      priceCoverage: uniform(coverages) ? coverages[0] : null,
      availability: {
        ...usageAvailability,
        '/attemptWallMs': entry(wallTotal),
        '/runElapsedMs': entry(elapsedTotal),
        '/modeledUsd': entry(usdTotal),
      },
    },
  };
}
