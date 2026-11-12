// M4b1: import self-declared acceptances from a recorded PR-comment and
// PR-review snapshot (ADR-0008 T20; docs/measurement/import-acceptance.md). Pure and
// offline: no files, no network, no `gh`. Independence is self-declared —
// most agents post as the same GitHub account, so the comment's own header
// is the only basis and /independent records exactly that. A review header
// posted by the cq-review GitHub App (cq-review[bot], via the agents repo's
// cq-review-post) is attested instead: its reviewerId is
// `app:cq-review:<reviewer>` and /independent says so. Rows feed M10e's
// acceptances input; near-miss headers, missing bases, corrupt or
// conflicting rows are unknown entries with a reason, never a zero.
const SHA40 = /^[0-9a-f]{40}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/; // strict UTC
// Anchored first-line forms only: no substring search, no case folding.
const REVIEW =
  /^\*\*Independent review \(([A-Za-z][A-Za-z0-9.+ -]{0,39})\): (PASS|ITERATE) for `([0-9a-f]{40})`\*\*$/;
const CARRY = /^\*\*Independent PASS carried to (?:rebased )?head `([0-9a-f]{40})`\.\*\*$/;
// A whole-line HTML comment before the header is a publisher's run marker
// (crq's `<!-- crq-findings run=… -->` on findings-mode review bodies).
const MARKER = /^<!--(?:(?!-->).)*-->$/;
const REFERENCED = /https?:\/\/\S*?issuecomment-\d+/g;
const INDEPENDENT_REASON =
  'self-declared in review comment header; reviewer identity not verified (shared GitHub account)';
// The comment author is recorded from GitHub's API (user.login), which only
// the App's own token can produce for this login.
const REVIEW_APP_LOGIN = 'cq-review[bot]';
const ATTESTED_REASON =
  'posted by the cq-review GitHub App (cq-review[bot]), an identity separate from the owner account; reviewer name self-declared in the header';
const text = (v) => typeof v === 'string' && v.length > 0;
const map_ = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const bad = (source, kind, reason) => ({ source, kind, reason });
// Rows and unknowns are built here with a fixed key order, so stringify is
// their stable equivalence (the M10b fingerprint role).
const shapely = (s) => map_(s) && map_(s.pr) && text(s.pr.user?.login) && Array.isArray(s.comments);

/** Strict UTC instant normalised to milliseconds; null when invalid. */
function instant(v) {
  if (!text(v) || !ISO.test(v)) return null;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) return null;
  // Round trip: calendar-invalid dates (2026-02-30 rolls to March) and
  // out-of-range clock fields never survive; deeper fractions truncate.
  const tail = /(?:\.\d+)?Z$/.exec(v)[0];
  const normal = `${v.slice(0, -tail.length)}.${(tail.slice(1, -1) + '000').slice(0, 3)}Z`;
  return new Date(ms).toISOString() === normal ? normal : null;
}

/** The header line: the first line after any leading marker lines, one
 * trailing `\r` trimmed. A header anywhere later is not a header. */
function headerLine(body) {
  const lines = body.split('\n').map((line) => line.replace(/\r$/, ''));
  let i = 0;
  while (i < lines.length - 1 && MARKER.test(lines[i])) i += 1;
  return lines[i];
}

// Issue comments carry created_at; PR reviews (findings mode posts one)
// carry submitted_at. Reason strings keep each kind's own noun.
const KINDS = {
  comment: { list: 'snapshot comments', time: 'created_at' },
  review: { list: 'snapshot reviews', time: 'submitted_at' },
};

/** Import from one recorded snapshot; see the header comment for shape. */
export function importAcceptance(snapshot) {
  const unknown = [];
  const rows = [];
  if (!shapely(snapshot)) {
    unknown.push(bad('snapshot', 'corrupt', 'snapshot is absent or malformed'));
    return { acceptances: [], meta: [], unknown };
  }
  const bases = map_(snapshot.bases) ? snapshot.bases : {};
  // Snapshots recorded before the reviews step (2026-11-08) have no
  // `reviews`: PR-review acceptances are then unknown, never zero.
  let reviews = [];
  if (!Object.hasOwn(snapshot, 'reviews'))
    unknown.push(bad('snapshot', 'unavailable', 'PR reviews not recorded'));
  else if (!Array.isArray(snapshot.reviews))
    unknown.push(bad('snapshot reviews', 'corrupt', 'reviews is not an array'));
  else reviews = snapshot.reviews;
  const entries = [
    ...snapshot.comments.map((item) => ['comment', item]),
    ...reviews.map((item) => ['review', item]),
  ];
  for (const [kind, comment] of entries) {
    if (!map_(comment)) {
      unknown.push(bad(KINDS[kind].list, 'corrupt', `${kind} entry is not an object`));
      continue;
    }
    const url = text(comment.html_url) ? comment.html_url : null;
    const source = url ?? `${kind} ${JSON.stringify(comment.id ?? null)}`;
    if (typeof comment.body !== 'string') {
      unknown.push(bad(source, 'corrupt', `${kind} body is not a string`));
      continue;
    }
    const first = headerLine(comment.body);
    const review = REVIEW.exec(first);
    const carry = review === null ? CARRY.exec(first) : null;
    if (review === null && carry === null) {
      // A near-miss header is never dropped silently; anything else is
      // simply not an acceptance and yields nothing.
      if (first.startsWith('**Independent'))
        unknown.push(bad(source, 'unavailable', 'malformed acceptance header'));
      continue;
    }
    if (url === null) {
      unknown.push(bad(source, 'corrupt', `acceptance ${kind} is missing html_url`));
      continue;
    }
    const time = KINDS[kind].time;
    const at = instant(comment[time]);
    if (at === null) {
      unknown.push(bad(source, 'corrupt', `${kind} ${time} is not a UTC instant`));
      continue;
    }
    const headSha = review?.[3] ?? carry[1];
    const base = bases[headSha];
    if (typeof base !== 'string' || !SHA40.test(base)) {
      unknown.push(bad(source, 'unavailable', 'reviewed base not recorded'));
      continue;
    }
    // Carry-overs stay self-declared: the coordinator posts them by hand.
    const attested = review !== null && comment.user?.login === REVIEW_APP_LOGIN;
    const reviewerId =
      review === null
        ? 'self-declared:coordinator'
        : `${attested ? 'app:cq-review' : 'self-declared'}:${review[1]}`;
    const refs = carry === null ? [] : (comment.body.match(REFERENCED) ?? []);
    rows.push({
      key: `${headSha}\u0000${base}\u0000${reviewerId}`,
      at,
      source,
      payload: {
        headSha,
        reviewedBaseSha: base,
        reviewerId,
        authorId: `github:${snapshot.pr.user.login}`,
        independent: true,
        verdict: review === null || review[2] === 'PASS' ? 'PASS' : 'HOLD',
        evidence: [comment.html_url, ...refs],
        availability: {
          '/independent': {
            state: 'known',
            reason: attested ? ATTESTED_REASON : INDEPENDENT_REASON,
            source: comment.html_url,
          },
        },
      },
    });
  }
  // One admission path on the M10e key (head, base, reviewer): identical
  // duplicates keep one copy; disagreeing copies conflict and emit nothing.
  const groups = new Map();
  for (const row of rows) groups.set(row.key, [...(groups.get(row.key) ?? []), row]);
  const acceptances = [];
  const meta = [];
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key);
    const first = JSON.stringify(group[0]);
    if (group.every((row) => JSON.stringify(row) === first)) {
      acceptances.push(group[0].payload);
      meta.push({ at: group[0].at });
    } else {
      const sources = group
        .map((row) => row.source)
        .sort()
        .join(' + ');
      unknown.push(bad(sources, 'conflict', 'conflicting acceptance observations'));
    }
  }
  if (snapshot.complete === false) {
    const step = text(snapshot.failed_step) ? `'${snapshot.failed_step}'` : 'not recorded';
    unknown.push(bad('snapshot', 'partial', `incomplete snapshot; failed_step ${step}`));
  }
  // Deterministic output whatever order the comments were recorded in.
  unknown.sort((a, b) => {
    const x = JSON.stringify(a);
    const y = JSON.stringify(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return { acceptances, meta, unknown };
}
