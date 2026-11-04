// M10e: harm and missed-defect panels over explicit observation records in
// the merged report v2 payload shapes (ADR-0008). Pure and offline: no files
// are read and no unmerged lineage inputs are assumed. The M10b discipline
// governs every row: malformed, conflicting or missing-lineage evidence
// lands in the unknown list with a reason — never a count, never a zero.
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const CI_RED = new Set(['flake', 'regression', 'infrastructure']);
// A re-fix stops being a harm candidate only when its own evidence records
// prior-correctness (the prior fix held) or a finding-edit (the finding
// changed between observations, so it is not the same defect).
const EXONERATING = /prior-correctness|finding-edit/;
const text = (v) => typeof v === 'string' && v.length > 0;
const sha = (v) => typeof v === 'string' && SHA.test(v);
const bad = (source, kind, reason) => ({ source, kind, reason });

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
  Array.isArray(d.evidence) &&
  d.evidence.every(text) &&
  sha(d.observedHead) &&
  ISO.test(d.observedAt ?? '');
const reviewOk = (r) =>
  r !== null &&
  typeof r === 'object' &&
  sha(r.baseSha) &&
  sha(r.headSha) &&
  Array.isArray(r.findingFingerprints) &&
  r.findingFingerprints.every(fingerprintOk) &&
  text(r.source) &&
  Number.isSafeInteger(r.round) &&
  r.round >= 0;
const acceptanceOk = (a) =>
  a !== null &&
  typeof a === 'object' &&
  sha(a.headSha) &&
  sha(a.reviewedBaseSha) &&
  text(a.reviewerId) &&
  ['PASS', 'HOLD', 'RETRACT'].includes(a.verdict);

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

/** Compute the M10e harm, missed-defect and population panels. */
export function computeOutcomePanels({
  reviews = [],
  dispositions = [],
  acceptances = [],
  ciRed = [],
  population = [],
  followUpDays,
  observedAt,
} = {}) {
  if (![reviews, dispositions, acceptances, ciRed, population].every(Array.isArray))
    throw new TypeError('computeOutcomePanels: the five record arguments must be arrays');
  if (!(typeof followUpDays === 'number' && Number.isFinite(followUpDays) && followUpDays > 0))
    throw new TypeError('computeOutcomePanels: followUpDays must be a positive number of days');
  if (!text(observedAt) || Number.isNaN(Date.parse(observedAt)))
    throw new TypeError('computeOutcomePanels: observedAt must be an ISO datetime');
  const unknown = [];
  const keptDispositions = admit(
    dispositions,
    dispositionOk,
    (d) => `${canonical(d.fingerprint)}\u0000${d.observedHead}\u0000${d.observedAt}`,
    'disposition',
    unknown,
  );
  const keptReviews = admit(
    reviews,
    reviewOk,
    (r) => `${r.baseSha}\u0000${r.headSha}\u0000${r.source}\u0000${r.round}`,
    'review',
    unknown,
  );
  const keptAcceptances = admit(
    acceptances,
    acceptanceOk,
    (a) => `${a.headSha}\u0000${a.reviewedBaseSha}\u0000${a.reviewerId}`,
    'acceptance',
    unknown,
  );

  // Harm panel 1 — re-fixes: a second-or-later `fixed` disposition for one
  // fingerprint. It is a harm candidate only while its lineage holds (some
  // review observed the finding at a covered range) and no evidence
  // exonerates it; an unreviewed re-fix is missing lineage.
  const reviewed = new Set(keptReviews.flatMap((r) => r.findingFingerprints.map(canonical)));
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
    // observedAt is fixed-width ISO, so string order is time order; the head
    // breaks ties.
    runs.sort((x, y) => (x.observedAt + x.observedHead < y.observedAt + y.observedHead ? -1 : 1));
    for (const d of runs.slice(1)) {
      if (!reviewed.has(key)) {
        refix.unknown++;
        unknown.push(
          bad(`disposition ${d.observedHead}`, 'missing', 're-fix with no reviewed range'),
        );
        continue;
      }
      if (d.evidence.some((line) => EXONERATING.test(line))) refix.explained++;
      else refix.candidates++;
    }
  }

  // Harm panel 2 — post-merge CI red: flake / regression / infrastructure /
  // unknown. An unrecognized or absent classification is unknown evidence,
  // never a guess.
  const ciRedPanel = { flake: 0, regression: 0, infrastructure: 0, unknown: 0 };
  for (const [i, row] of ciRed.entries()) {
    if (row === null || typeof row !== 'object' || !sha(row.sha) || !text(row.source)) {
      ciRedPanel.unknown++;
      unknown.push(bad(`ciRed[${i}]`, 'corrupt', 'CI red row is malformed'));
      continue;
    }
    if (CI_RED.has(row.classification)) ciRedPanel[row.classification]++;
    else if (row.classification === 'unknown') ciRedPanel.unknown++;
    else {
      ciRedPanel.unknown++;
      unknown.push(
        bad(
          `ciRed[${i}]`,
          'unsupported',
          `classification '${String(row.classification)}' is not recognized`,
        ),
      );
    }
  }

  // Missed panel — restored crq findings: a crq review based at an accepted
  // PR head is post-merge, and its findings count missed only when the
  // finding existed at the pre-merge covered range (a review at the range
  // the acceptance certifies observed it). Other findings there are new,
  // and an unlinkable review is missing lineage.
  const accepted = new Map(
    keptAcceptances.filter((a) => a.verdict === 'PASS').map((a) => [a.headSha, a]),
  );
  const fingerprintsAt = new Map();
  for (const r of keptReviews) {
    const key = `${r.headSha}\u0000${r.baseSha}`;
    const set = fingerprintsAt.get(key) ?? new Set();
    for (const f of r.findingFingerprints) set.add(canonical(f));
    fingerprintsAt.set(key, set);
  }
  const restored = { missed: 0, notMissed: 0, unknown: 0 };
  for (const r of keptReviews) {
    if (r.source !== 'crq') continue;
    const atHead = accepted.get(r.headSha);
    if (atHead !== undefined && atHead.reviewedBaseSha === r.baseSha) continue; // a pre-merge review itself
    const a = accepted.get(r.baseSha);
    if (a === undefined) {
      restored.unknown++;
      unknown.push(bad(`review ${r.headSha}`, 'missing', 'crq review base has no accepted head'));
      continue;
    }
    const pre = fingerprintsAt.get(`${a.headSha}\u0000${a.reviewedBaseSha}`);
    if (pre === undefined) {
      restored.unknown++;
      unknown.push(bad(`review ${r.headSha}`, 'missing', 'acceptance has no pre-merge review'));
      continue;
    }
    for (const f of r.findingFingerprints)
      pre.has(canonical(f)) ? restored.missed++ : restored.notMissed++;
  }

  // Population panel — eligibility is a PASS acceptance at the exact head;
  // a PR is mature once the explicit follow-up window has elapsed by the
  // observation instant, and a younger PR is explicitly right-censored.
  const populationPanel = { eligible: 0, mature: 0, rightCensored: 0, followUpDays };
  for (const [i, row] of population.entries()) {
    if (
      row === null ||
      typeof row !== 'object' ||
      !sha(row.headSha) ||
      !text(row.mergedAt) ||
      Number.isNaN(Date.parse(row.mergedAt))
    ) {
      unknown.push(bad(`population[${i}]`, 'corrupt', 'population row is malformed'));
      continue;
    }
    if (!accepted.has(row.headSha)) {
      unknown.push(bad(`population ${row.headSha}`, 'missing', 'PR head has no PASS acceptance'));
      continue;
    }
    populationPanel.eligible++;
    if (Date.parse(observedAt) - Date.parse(row.mergedAt) >= followUpDays * 86400000)
      populationPanel.mature++;
    else populationPanel.rightCensored++;
  }

  return {
    harm: { refix, ciRed: ciRedPanel },
    missed: { restored },
    population: populationPanel,
    unknown,
  };
}
