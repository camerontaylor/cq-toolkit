// Offline fix and cost panel computation for M10c (ADR-0008 vocabulary). Pure
// arithmetic over evidence the M10b reader already admitted — attempt leaves
// (MeasurementInputRecord rows) and its unknown bucket — plus the ADR-0008
// fix vocabulary (closures, baseline failures), the producer-recorded
// numerator and each run's provenance window, all passed in explicitly: no
// file access, no network, nothing read beyond the merged shapes. Unknown
// never becomes zero or a count: a placeholder or uncompleted baseline unit
// never mixes into a failure denominator, a producer-declared unknown
// numerator stays unknown, an untrusted, torn or absent child value never
// reads as zero, run elapsed (the provenance window) is reported beside —
// never in place of — the summed attempt wall, modeled price coverage is
// stated explicitly rather than implied by a number, and fixesPerRun stays
// per-run with no cross-run ratio. Leaf usage follows the M10b dedup
// identity (repo, runId, invocation), and runs, closure rows and baseline
// rows are admitted the same way: identical copies count once, disagreeing
// copies are a conflict that contributes nothing. Session-index parent
// aggregates stay folded in the reader's own totals; this panel computes
// from leaves only.
const KNOWN_STATES = new Set(['known', 'known-zero']);
const avail = (state, reason) => ({ state, reason, source: null });
const entry = ({ value: _value, ...rest }) => rest;

/** Stable M10b serialization for duplicate comparison. */
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value !== null && typeof value === 'object'
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(',')}}`
      : JSON.stringify(value);

/** M10b aggregate semantics: known values sum; incomplete evidence yields unavailable (nothing observed) or partial (a subtotal beside unknowns); only fully observed evidence is known, and a fully observed zero is known-zero. A missing (undefined) field is unknown, never a known NaN. */
function aggregate(records, field, label, incomplete, why) {
  const reason = why ?? 'measurement inputs were rejected, incomplete or unavailable';
  const known = records.filter((record) => record[field] != null);
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

/** ADR-0008 instants are UTC ISO-8601: only the Z-form is a valid stamp. An offset-less stamp would be read in the host timezone and could mix into a silently wrong window, so it is never one. */
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const instant = (stamp) =>
  typeof stamp === 'string' && UTC_INSTANT.test(stamp) ? Date.parse(stamp) : null;

/** Observed provenance window; ms null when not observed, malformed (non-UTC form) or inverted; bad only when both stamps are present yet no window exists. */
const windowOf = (run) => {
  const start = instant(run.startedAt);
  const end = instant(run.endedAt);
  const whole = start !== null && end !== null && end >= start;
  return {
    ms: whole ? end - start : null,
    bad: run.startedAt != null && run.endedAt != null && !whole,
  };
};

/** Compute the fix and cost panels over explicitly provided measurement evidence. */
export function computeMeasurementPanels({ runs, unknown = [], evidenceAvailability } = {}) {
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
  const channelTorn = new Set();
  // An availability record degrades exactly the totals its pointer names:
  // the root pointer covers all, '/attempts' the attempt evidence totals,
  // the umbrella and escaped per-channel pointers their channels, and the
  // field pointers their fields. A pointer the panel does not consume
  // (/servedModel and similar) is not a statement about these totals.
  const flagAvailability = (map) => {
    for (const [pointer, record] of Object.entries(map ?? {})) {
      if (KNOWN_STATES.has(record?.state)) continue;
      if (pointer === '') incomplete.channels = incomplete.wall = incomplete.usd = true;
      else if (pointer === '/attempts')
        incomplete.channels = incomplete.wall = incomplete.usd = true;
      else if (pointer === '/usageChannels') incomplete.channels = true;
      else if (pointer.startsWith('/usageChannels/'))
        channelTorn.add(pointer.slice(15).replaceAll('~1', '/').replaceAll('~0', '~'));
      else if (pointer === '/wallMs') incomplete.wall = true;
      else if (pointer === '/modeledUsd') incomplete.usd = true;
    }
  };
  // Report/run-level availability (the reader's totals availability) reaches
  // the panel through the same pointer scoping, so evidence the reader calls
  // partial is never known here.
  flagAvailability(evidenceAvailability);
  // Admit runs the M10b way: identical copies of one (repo, runId) count
  // once; disagreeing copies are a conflict whose run-level figures (fix
  // counts, window) contribute nothing.
  const admitted = [];
  const byIdentity = new Map();
  const conflictedRuns = new Set();
  for (const run of runs) {
    const key = `${run.repo ?? ''}\u0000${run.runId}`;
    if (conflictedRuns.has(key)) continue;
    const prior = byIdentity.get(key);
    if (prior === undefined) {
      byIdentity.set(key, run);
      admitted.push(run);
    } else if (canonical(prior) !== canonical(run)) {
      byIdentity.delete(key);
      conflictedRuns.add(key);
      admitted.splice(admitted.indexOf(prior), 1);
    }
  }
  const conflictedWindow = (run) =>
    conflictedRuns.has(`${run.repo ?? ''}\u0000${run.runId}`)
      ? { ms: null, bad: true }
      : windowOf(run);
  // A conflicted run identity is a statement about the run-level figures
  // (window, fix counts); its attempt leaves are admitted on their own
  // identity below, exactly as duplicate leaves from any source are.
  if (conflictedRuns.size > 0) incomplete.elapsed = true;
  // Dedup attempt leaves on the M10b identity (repo, runId, invocation):
  // identical copies count once; disagreeing copies are a conflict that
  // contributes nothing.
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
  for (const leaf of leaves) flagAvailability(leaf.availability);
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
      const total = aggregate(
        records,
        'value',
        `usage channel ${name}`,
        incomplete.channels || channelTorn.has(name),
      );
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
  const windows = admitted.map(conflictedWindow);
  const badWindow = windows.some((window) => window.bad);
  const elapsedTotal = aggregate(
    windows.map((window) => ({ ms: window.ms })),
    'ms',
    'run elapsed',
    incomplete.elapsed || badWindow,
    badWindow ? 'a run window is inverted, unparseable or conflicted' : undefined,
  );
  // Modeled price coverage is explicit: the sum never claims completeness
  // while coverage or the price table is absent or mixed across the priced
  // attempts (USD from different or unstated tables is never a known total).
  const coverages = [...new Set(leaves.map((leaf) => leaf.priceCoverage))];
  const revisions = [...new Set(leaves.map((leaf) => leaf.priceTableRevision))];
  const uniform = (values) => values.length === 1 && values[0] !== null;
  const coverageIncomplete =
    leaves.some((leaf) => leaf.modeledUsd !== null) && !(uniform(coverages) && uniform(revisions));
  const usdTotal = aggregate(
    leaves.map((leaf) => ({ usd: leaf.modeledUsd })),
    'usd',
    'modeled USD',
    incomplete.usd || coverageIncomplete,
    coverageIncomplete ? 'price coverage is absent or mixed across attempts' : undefined,
  );
  // Fix panel, per-run only, mirroring the ADR-0008 MetricRecord: the
  // numerator counts distinct verified non-todo commits, cross-checked
  // against the producer-recorded scalar (a recorded null is a
  // producer-declared unknown, held, never counted; a disagreement withholds
  // the count, exactly as reportFold does); closure rows are admitted by
  // commitSha (a todo disagreement makes the count unknown); baseline rows
  // are admitted by unitId and must each be completed with a known count —
  // a placeholder, uncompleted or conflicting unit makes the denominator
  // unknown, with the known subtotal withheld, never mixed in.
  const fixRuns = admitted.map((run) => {
    if (conflictedRuns.has(`${run.repo ?? ''}\u0000${run.runId}`))
      return {
        repo: run.repo,
        runId: run.runId,
        fixesPerRun: { numerator: null, denominator: null },
        verifiedCommits: [],
      };
    // One commit closing several findings is legitimate multiplicity (it
    // counts once); the conflict is a contradictory todo on the same SHA,
    // which makes the count uncertain and therefore unknown.
    const todoBySha = new Map();
    const conflictedShas = new Set();
    for (const row of run.closures ?? []) {
      const todo = row.todo === true;
      if (!todoBySha.has(row.commitSha)) todoBySha.set(row.commitSha, todo);
      else if (todoBySha.get(row.commitSha) !== todo) conflictedShas.add(row.commitSha);
    }
    const shas =
      run.closures == null
        ? null
        : [
            ...new Set(
              run.closures
                .filter((row) => !row.todo && !conflictedShas.has(row.commitSha))
                .map((row) => row.commitSha),
            ),
          ];
    const counted = shas === null || conflictedShas.size > 0 ? null : shas.length;
    let numerator = counted;
    if (run.recordedNumerator === null) numerator = null;
    else if (run.recordedNumerator !== undefined && run.recordedNumerator !== counted)
      numerator = null;
    // Baseline rows are admitted by unitId: identical duplicates count once;
    // disagreeing ones conflict. A unit counts only when its probe completed
    // with a known count — a placeholder, uncompleted or conflicting unit
    // makes the denominator unknown, subtotal withheld.
    const units = [];
    const byUnit = new Map();
    const conflictedUnits = new Set();
    for (const unit of run.baselineFailures ?? []) {
      if (conflictedUnits.has(unit.unitId)) continue;
      const prior = byUnit.get(unit.unitId);
      if (prior === undefined) {
        byUnit.set(unit.unitId, unit);
        units.push(unit);
      } else if (canonical(prior) !== canonical(unit)) {
        byUnit.delete(unit.unitId);
        conflictedUnits.add(unit.unitId);
        units.splice(units.indexOf(prior), 1);
      }
    }
    const distinctUnits = new Set((run.baselineFailures ?? []).map((unit) => unit.unitId)).size;
    const whole =
      run.baselineFailures != null &&
      conflictedUnits.size === 0 &&
      units.length === distinctUnits &&
      units.every((unit) => unit.completed === true && unit.count !== null);
    return {
      repo: run.repo,
      runId: run.runId,
      fixesPerRun: {
        numerator,
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
