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

/** M10b aggregate semantics: known values sum; incomplete evidence yields unavailable (nothing observed) or partial (a subtotal beside unknowns); only fully observed evidence is known, and a fully observed zero is known-zero. A missing, non-number or non-finite field is unknown, never a known NaN. */
function aggregate(records, field, label, incomplete, why) {
  const reason = why ?? 'measurement inputs were rejected, incomplete or unavailable';
  const known = records.filter(
    (record) => typeof record[field] === 'number' && Number.isFinite(record[field]),
  );
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

/** ADR-0008 instants are UTC ISO-8601: only the Z-form is a valid stamp, as strict as the schema instant — an offset-less stamp would be read in the host timezone, and a normalised calendar part (Feb 30) is an invalid stamp, never the day it rolls into. */
const UTC_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;
const instant = (stamp) => {
  if (typeof stamp !== 'string') return null;
  const match = UTC_INSTANT.exec(stamp);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second, fraction] = match;
  const utc = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second);
  const date = new Date(utc);
  const calendar =
    +month >= 1 &&
    +month <= 12 &&
    +hour < 24 &&
    +minute < 60 &&
    +second < 60 &&
    date.getUTCFullYear() === +year &&
    date.getUTCMonth() === +month - 1 &&
    date.getUTCDate() === +day;
  return calendar
    ? utc + (fraction ? +`0.${fraction.padEnd(3, '0').slice(0, 3)}` * 1000 : 0)
    : null;
};

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
  // Unattested report-level availability degrades every cost total to
  // partial, or unavailable where nothing was observed: without the reader's
  // availability the panel cannot claim completeness (unknown is never
  // known), and the omission is also reported through the
  // /evidenceAvailability entry.
  const unattested = evidenceAvailability == null;
  const UNATTESTED =
    'report-level availability was not provided; completeness is claimed over leaves and the unknown bucket only';
  const incomplete = {
    channels: anyUnknown || unattested,
    wall: anyUnknown || unattested,
    usd: anyUnknown || unattested,
    elapsed: anyUnknown || unattested,
  };
  const channelTorn = new Set();
  // An availability record degrades exactly the totals its pointer names:
  // the root pointer covers all, '/attempts' the attempt evidence totals,
  // the umbrella and escaped per-channel pointers their channels, and the
  // field pointers their fields. Provenance gates only the fields the window
  // is made of — '/provenance/startedAt' and '/provenance/endedAt' — never
  // journalLink/reportLink/witnesses and similar provenance the window does
  // not read. A pointer the panel does not consume at all is not a statement
  // about these totals.
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
      else if (
        pointer === '/provenance' ||
        pointer === '/provenance/startedAt' ||
        pointer === '/provenance/endedAt'
      )
        incomplete.elapsed = true;
    }
  };
  // Report/run-level availability (the reader's totals availability) reaches
  // the panel through the same pointer scoping, so evidence the reader calls
  // partial is never known here.
  flagAvailability(evidenceAvailability);
  // Admit runs the M10b way: identical copies of one (repo, runId) count
  // once, and a run split across entries only in its attempts is not a
  // disagreement (leaves are admitted on their own identity below); any
  // other disagreement is a conflict, and a conflicted identity keeps one
  // row whose run-level figures (fix counts, window) are explicitly unknown.
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
    } else if (canonical({ ...prior, attempts: null }) !== canonical({ ...run, attempts: null }))
      conflictedRuns.add(key);
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
  const unattestedWhy = unattested ? UNATTESTED : undefined;
  if (channels.size === 0)
    usageAvailability['/usageChannels'] = entry(
      aggregate([], 'value', 'usage channel', incomplete.channels, unattestedWhy),
    );
  else
    for (const [name, records] of channels) {
      const total = aggregate(
        records,
        'value',
        `usage channel ${name}`,
        incomplete.channels || channelTorn.has(name),
        unattestedWhy,
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
    unattestedWhy,
  );
  const windows = admitted.map(conflictedWindow);
  const badWindow = windows.some((window) => window.bad);
  const elapsedTotal = aggregate(
    windows.map((window) => ({ ms: window.ms })),
    'ms',
    'run elapsed',
    incomplete.elapsed || badWindow,
    badWindow ? 'a run window is inverted, unparseable or conflicted' : unattestedWhy,
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
    coverageIncomplete ? 'price coverage is absent or mixed across attempts' : unattestedWhy,
  );
  // Fix panel, per-run only, mirroring the ADR-0008 MetricRecord: the
  // numerator counts distinct verified non-todo commits, cross-checked
  // against the producer-recorded scalar (a recorded null is a
  // producer-declared unknown, held, never counted; a disagreement withholds
  // the count, exactly as reportFold does); a conflicted run identity keeps
  // an explicitly unknown row; closure rows treat one commit closing several
  // findings as multiplicity (a todo disagreement makes the count unknown);
  // baseline rows are admitted by unitId and must each be completed with a
  // known count — a placeholder, uncompleted or conflicting unit makes the
  // denominator unknown, with the known subtotal withheld, never mixed in.
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
    // A producer-declared unknown (recorded null) or a scalar disagreeing
    // with the distinct verified count withholds the figure — one rule,
    // reportFold parity.
    const numerator =
      run.recordedNumerator !== undefined && run.recordedNumerator !== counted ? null : counted;
    // Baseline rows are admitted by unitId: identical duplicates count once;
    // disagreeing ones conflict. A unit counts only when its probe completed
    // with a known count — a placeholder, uncompleted or conflicting unit
    // makes the denominator unknown, subtotal withheld. Known means a
    // non-negative safe integer: an undefined, string or fractional count is
    // corrupt, so it makes the denominator unknown rather than summing to NaN
    // or a concatenated string.
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
      units.every(
        (unit) => unit.completed === true && Number.isSafeInteger(unit.count) && unit.count >= 0,
      );
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
        ...(unattested
          ? {
              '/evidenceAvailability': avail(
                'not-collected',
                'report-level availability was not provided; completeness is claimed over leaves and the unknown bucket only',
              ),
            }
          : {}),
      },
    },
  };
}
