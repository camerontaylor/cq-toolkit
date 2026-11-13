// M10e: harm and missed-defect panels over explicit observation records in
// the merged report v2 payload shapes (ADR-0008). Pure and offline: no files
// are read and no unmerged lineage inputs are assumed. The M10b discipline
// governs every row: malformed, conflicting or missing-lineage evidence
// lands in the unknown list with a reason — never a count, never a zero.
// Rows whose own availability map marks consumed fields incomplete are
// unknown ('unavailable'), and CI red counts are null unless the caller
// states which heads' CI was examined (unknown is never zero).
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// z.iso.datetime({ precision: 3 }) as in ReportV2Schema, plus the calendar
// round-trip in instant(): shape, parse and round-trip must all agree.
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CI_RED = new Set(['flake', 'regression', 'infrastructure']);
// A re-fix stops being a harm candidate only when its own evidence carries
// an exact leading marker — prior-correctness (the prior fix held) or
// finding-edit (the finding changed between observations). Substring
// matches in human prose never exonerate (ADR-0008 T-classification rule).
const EXONERATING = /^(?:prior-correctness|finding-edit)(?::|$)/;
const text = (v) => typeof v === 'string' && v.length > 0;
const strings = (v) => Array.isArray(v) && v.every((item) => typeof item === 'string');
const map_ = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha = (v) => typeof v === 'string' && SHA.test(v);
const instant = (v) => {
  if (!text(v) || !ISO.test(v)) return false;
  const ms = Date.parse(v);
  return !Number.isNaN(ms) && new Date(ms).toISOString() === v;
};
const bad = (source, kind, reason) => ({ source, kind, reason });
const KNOWN = new Set(['known', 'known-zero']);

/** Stable serialization: same content, same key (the M10b fingerprint). */
const canonical = (v) =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(',')}]`
    : v !== null && typeof v === 'object'
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
          .join('')}}`
      : JSON.stringify(v);

const fingerprintOk = (f) =>
  f !== null &&
  typeof f === 'object' &&
  f.version === 1 &&
  text(f.checkId) &&
  (f.rule === null || text(f.rule)) &&
  typeof f.path === 'string' &&
  (f.spanContentHash === null || text(f.spanContentHash));
const dispositionOk = (d) =>
  d !== null &&
  typeof d === 'object' &&
  fingerprintOk(d.fingerprint) &&
  ['fixed', 'rejected', 'deferred'].includes(d.status) &&
  typeof d.reason === 'string' &&
  text(d.owner) &&
  strings(d.evidence) &&
  (d.reviewTrigger === null || text(d.reviewTrigger)) &&
  (d.status !== 'deferred' || text(d.reviewTrigger)) &&
  sha(d.observedHead) &&
  instant(d.observedAt) &&
  (d.acceptedRisk === null || typeof d.acceptedRisk === 'string') &&
  map_(d.availability);
const reviewOk = (r) =>
  r !== null &&
  typeof r === 'object' &&
  sha(r.baseSha) &&
  sha(r.headSha) &&
  Array.isArray(r.findingFingerprints) &&
  r.findingFingerprints.every(fingerprintOk) &&
  typeof r.coverage === 'string' &&
  (r.initialBlocking === null ||
    (Array.isArray(r.initialBlocking) && r.initialBlocking.every(fingerprintOk))) &&
  text(r.reviewerId) &&
  text(r.source) &&
  Number.isSafeInteger(r.round) &&
  r.round >= 0 &&
  strings(r.delivered) &&
  strings(r.completed) &&
  strings(r.omissions) &&
  ['completed', 'not-completed', 'unknown'].includes(r.vendorCompletion) &&
  map_(r.availability);
const acceptanceOk = (a) =>
  a !== null &&
  typeof a === 'object' &&
  sha(a.headSha) &&
  sha(a.reviewedBaseSha) &&
  text(a.reviewerId) &&
  text(a.authorId) &&
  typeof a.independent === 'boolean' &&
  ['PASS', 'HOLD', 'RETRACT'].includes(a.verdict) &&
  strings(a.evidence) &&
  map_(a.availability);

/**
 * Admit rows by identity: malformed ones are corrupt unknowns; identical
 * duplicates keep one copy; disagreeing copies conflict and the whole
 * identity is excluded — order-independently, like the M10b tombstones.
 */
function admit(rows, ok, identity, label, unknown) {
  const groups = new Map();
  rows.forEach((row, i) => {
    if (!ok(row)) {
      unknown.push(bad(`${label}[${i}]`, 'corrupt', `${label} row is malformed`));
      return;
    }
    const key = identity(row);
    const group = groups.get(key) ?? [];
    group.push({ row, source: `${label}[${i}]` });
    groups.set(key, group);
  });
  const out = [];
  for (const group of groups.values()) {
    const first = canonical(group[0].row);
    if (group.every((entry) => canonical(entry.row) === first)) out.push(group[0].row);
    else
      unknown.push(
        bad(
          group.map((entry) => entry.source).join(' + '),
          'conflict',
          `conflicting ${label} observations`,
        ),
      );
  }
  return out;
}

/** Drop rows whose availability marks consumed fields incomplete (never known). */
function usable(rows, pointers, label, unknown) {
  return rows.filter((row) => {
    const pointer = pointers.find((p) => {
      const entry = row.availability?.[p];
      return entry !== undefined && !KNOWN.has(entry?.state);
    });
    if (pointer === undefined) return true;
    unknown.push(
      bad(
        `${label}${pointer === '' ? ' root' : pointer}`,
        'unavailable',
        'row availability marks consumed fields incomplete',
      ),
    );
    return false;
  });
}

/** A review establishes a covered range only with recorded, completed coverage. */
const covered = (r) =>
  (r.coverage.startsWith('v2:') || r.coverage.startsWith('legacy:')) &&
  r.vendorCompletion === 'completed';

/** Compute the M10e harm, missed-defect and population panels. */
export function computeOutcomePanels({
  reviews = [],
  dispositions = [],
  acceptances = [],
  ciRed = [],
  population = [],
  ciObservedHeads,
  followUpDays,
  observedAt,
} = {}) {
  if (![reviews, dispositions, acceptances, ciRed, population].every(Array.isArray))
    throw new TypeError('computeOutcomePanels: the five record arguments must be arrays');
  if (ciObservedHeads !== undefined && !strings(ciObservedHeads))
    throw new TypeError('computeOutcomePanels: ciObservedHeads must be an array of head shas');
  if (!(typeof followUpDays === 'number' && Number.isFinite(followUpDays) && followUpDays > 0))
    throw new TypeError('computeOutcomePanels: followUpDays must be a positive number of days');
  if (!instant(observedAt))
    throw new TypeError('computeOutcomePanels: observedAt must be an ISO datetime');
  const unknown = [];
  const keptDispositions = usable(
    admit(
      dispositions,
      dispositionOk,
      (d) => `${canonical(d.fingerprint)}\u0000${d.observedHead}\u0000${d.observedAt}`,
      'disposition',
      unknown,
    ),
    ['', '/fingerprint', '/evidence', '/observedHead', '/observedAt'],
    'disposition',
    unknown,
  );
  const keptReviews = usable(
    admit(
      reviews,
      reviewOk,
      (r) => `${r.baseSha}\u0000${r.headSha}\u0000${r.source}\u0000${r.round}`,
      'review',
      unknown,
    ),
    // Root and the consumed finding list only: availability gates just the
    // fields the panels read. The coverage-proof pointers (/delivered,
    // /completed, /omissions) and /reviewerId mark unconsumed fields —
    // /reviewerId is not-collected whenever a source has no cycle id and
    // /omissions on every legacy proof — and covered() already gates
    // coverage and vendor completion, so a not-collected marker there must
    // not drop a valid covered range.
    ['', '/findingFingerprints'],
    'review',
    unknown,
  );
  const keptAcceptances = usable(
    admit(
      acceptances,
      acceptanceOk,
      (a) => `${a.headSha}\u0000${a.reviewedBaseSha}\u0000${a.reviewerId}`,
      'acceptance',
      unknown,
    ),
    // Acceptance field pointers have no producer yet (T20), so the root
    // record governs; a torn acceptance never makes a PR eligible.
    [''],
    'acceptance',
    unknown,
  );

  // Harm panel 1 — re-fixes: a second-or-later `fixed` disposition for one
  // fingerprint. It is a harm candidate only while its lineage holds (a
  // covered review observed the finding at its range) and no evidence
  // exonerates it; an unreviewed re-fix is missing lineage.
  const reviewed = new Set(
    keptReviews.filter(covered).flatMap((r) => r.findingFingerprints.map(canonical)),
  );
  const runsByFingerprint = new Map();
  for (const d of keptDispositions) {
    if (d.status !== 'fixed') continue;
    const key = canonical(d.fingerprint);
    const runs = runsByFingerprint.get(key) ?? [];
    runs.push(d);
    runsByFingerprint.set(key, runs);
  }
  const refix = { candidates: 0, explained: 0, unknown: 0 };
  for (const [key, runs] of runsByFingerprint) {
    // Instant order with the head breaking exact-time ties.
    runs.sort(
      (x, y) =>
        Date.parse(x.observedAt) - Date.parse(y.observedAt) ||
        (x.observedHead < y.observedHead ? -1 : 1),
    );
    for (const d of runs.slice(1)) {
      if (!reviewed.has(key)) {
        refix.unknown++;
        unknown.push(
          bad(`disposition ${d.observedHead}`, 'missing', 're-fix with no reviewed range'),
        );
        continue;
      }
      if (d.evidence.some((line) => EXONERATING.test(line.trim()))) refix.explained++;
      else refix.candidates++;
    }
  }

  // Missed panel — restored crq findings: a crq review based at an
  // independently accepted PR head is post-merge, and its findings count
  // missed only when the finding existed at the pre-merge covered range.
  // Two independent PASSes certifying different bases leave that range
  // ambiguous: unknown, whichever acceptance arrived first.
  const qualifying = new Map();
  for (const a of keptAcceptances)
    if (a.verdict === 'PASS' && a.independent) {
      const bases = qualifying.get(a.headSha) ?? new Set();
      bases.add(a.reviewedBaseSha);
      qualifying.set(a.headSha, bases);
    }
  const fingerprintsAt = new Map();
  for (const r of keptReviews.filter(covered)) {
    const key = `${r.headSha}\u0000${r.baseSha}`;
    const set = fingerprintsAt.get(key) ?? new Set();
    for (const f of r.findingFingerprints) set.add(canonical(f));
    fingerprintsAt.set(key, set);
  }
  const restored = { missed: 0, notMissed: 0, unknown: 0 };
  for (const r of keptReviews) {
    if (r.source !== 'crq') continue;
    if (qualifying.get(r.headSha)?.has(r.baseSha)) continue; // a pre-merge review itself
    const bases = qualifying.get(r.baseSha);
    if (bases === undefined) {
      restored.unknown++;
      unknown.push(bad(`review ${r.headSha}`, 'missing', 'crq review base has no accepted head'));
      continue;
    }
    if (bases.size > 1) {
      restored.unknown++;
      unknown.push(
        bad(
          `review ${r.headSha}`,
          'conflict',
          'two independent PASSes certify different pre-merge ranges',
        ),
      );
      continue;
    }
    const pre = fingerprintsAt.get(`${r.baseSha}\u0000${[...bases][0]}`);
    if (pre === undefined) {
      restored.unknown++;
      unknown.push(bad(`review ${r.headSha}`, 'missing', 'acceptance has no pre-merge review'));
      continue;
    }
    for (const f of r.findingFingerprints)
      pre.has(canonical(f)) ? restored.missed++ : restored.notMissed++;
  }

  // Population panel — eligibility is an independent PASS acceptance at the
  // exact head; a PR is mature once the explicit follow-up window has
  // elapsed by the observation instant, and a younger PR is explicitly
  // right-censored. One declared PR is one row: duplicates collapse and
  // disagreeing declarations conflict out.
  const keptPopulation = admit(
    population,
    (row) =>
      row !== null &&
      typeof row === 'object' &&
      sha(row.headSha) &&
      instant(row.mergedAt) &&
      // A merge after the observation snapshot is inconsistent evidence.
      Date.parse(row.mergedAt) <= Date.parse(observedAt),
    (row) => row.headSha,
    'population',
    unknown,
  );
  const populationPanel = { eligible: 0, mature: 0, rightCensored: 0, followUpDays };
  const eligibleHeads = [];
  for (const row of keptPopulation) {
    if (!qualifying.has(row.headSha)) {
      unknown.push(
        bad(`population ${row.headSha}`, 'missing', 'PR head has no independent PASS acceptance'),
      );
      continue;
    }
    populationPanel.eligible++;
    eligibleHeads.push(row.headSha);
    if (Date.parse(observedAt) - Date.parse(row.mergedAt) >= followUpDays * 86400000)
      populationPanel.mature++;
    else populationPanel.rightCensored++;
  }

  // Harm panel 2 — post-merge CI red: flake / regression / infrastructure /
  // unknown, over one observation per (sha, source). The four counts describe
  // examined reds only: with no coverage declaration — or a corrupt one — the
  // counts are null (unknown, never zero), and a red at an unexamined head is
  // a top-level partial entry, never a count.
  const ciRedPanel = {
    flake: 0,
    regression: 0,
    infrastructure: 0,
    unknown: 0,
    observedHeads: null,
    unobservedHeads: null,
  };
  const noCoverage = (reason) => {
    ciRedPanel.flake =
      ciRedPanel.regression =
      ciRedPanel.infrastructure =
      ciRedPanel.unknown =
        null;
    unknown.push(bad('ciRed', 'unavailable', reason));
  };
  if (ciObservedHeads === undefined) noCoverage('no CI coverage declared');
  else {
    const examined = new Set();
    let corrupt = false;
    ciObservedHeads.forEach((head, i) => {
      if (!sha(head)) {
        corrupt = true;
        unknown.push(bad(`ciObservedHeads[${i}]`, 'corrupt', 'examined head is not a sha'));
      } else examined.add(head);
    });
    if (corrupt) noCoverage('the CI coverage declaration is corrupt; counts are unknown');
    else {
      ciRedPanel.observedHeads = [...examined].sort();
      ciRedPanel.unobservedHeads = eligibleHeads.filter((head) => !examined.has(head)).sort();
      for (const row of admit(
        ciRed,
        (row) => row !== null && typeof row === 'object' && sha(row.sha) && text(row.source),
        (row) => `${row.sha}\u0000${row.source}`,
        'ciRed',
        unknown,
      )) {
        if (!examined.has(row.sha)) {
          unknown.push(bad(`ciRed ${row.sha}`, 'partial', 'CI red at an unexamined head'));
          continue;
        }
        if (CI_RED.has(row.classification)) ciRedPanel[row.classification]++;
        else if (row.classification === 'unknown') ciRedPanel.unknown++;
        else {
          ciRedPanel.unknown++;
          unknown.push(
            bad(
              `ciRed ${row.sha}`,
              'unsupported',
              `classification '${String(row.classification)}' is not recognized`,
            ),
          );
        }
      }
    }
  }

  return {
    harm: { refix, ciRed: ciRedPanel },
    missed: { restored },
    population: populationPanel,
    unknown,
  };
}
