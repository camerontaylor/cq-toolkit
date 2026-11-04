// Offline measurement input reader for M10b (ADR-0008 vocabulary). Explicit local
// bundle directories only (the M8a shape): no ambient scan, no cwd walk, no
// network. bundleVersion and every stored sha256 are validated, and reports are
// validated against the strict v2 report schema from the built engine (the
// M6c self-host pattern) — including the v2 payload embedded at reportV2 in
// persisted operation reports, which is the only form production writers
// emit. Missing, corrupt, unverifiable or ambiguous evidence
// goes to the UNKNOWN bucket with a reason, never to a fallback zero — and any
// unknown, torn or partially observed input forces partial or unavailable
// totals, never a known one.
//
// Leaf dedup identity is (repo, runId, invocation). repo is the archive-safe
// provenance.repoId; a null repo (no remote exists) keys as the empty identity
// and is DISTINCT from any named repo: a null-repo row never adopts a named
// repo's rows and vice versa, and two named repos never collide on one
// invocation. That identity under two workIds is a conflict (unknown), never
// a silent dedup — one invocation cannot belong to two works. Parent rows
// (session index) are keyed by (repo, workId, runId) —
// a composition run may span several works — and are derived aggregates: a row
// is not added when leaves of its identity are observed, so costs count once,
// and a row whose observed leaves fall short of its claims is recorded as a
// partial unknown that forces partial totals.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { sanitizeEvidenceText } from './archive-measurement-evidence.mjs';
import { ReportV2Schema } from '../dist/kernel/schema.js';

const BUNDLE = 1,
  REPORT = 2,
  INDEX = 1,
  MAX = 8 * 1024 * 1024;
const KNOWN_STATES = new Set(['known', 'known-zero']);
const REL = /^(?!\/)(?!\.\.?(?:\/|$))(?!.*\/\.\.?(?:\/|$))[^\\\0]+$/;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const num = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const text = (v) => typeof v === 'string' && v.length > 0;
const bad = (source, kind, reason) => ({ source, kind, reason });

/** Stable serialization for duplicate comparison: same content, same string. */
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value !== null && typeof value === 'object'
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(',')}}`
      : JSON.stringify(value);

/**
 * Leaf fingerprint: the whole attempt payload, minus the file source and the
 * key fields already equal within a key (repo, runId). workId stays in: the
 * same (repo, runId, invocation) under two works is a conflict, not a silent
 * dedup that drops one work's evidence while its index row re-adds the cost.
 */
function leafFingerprint(record) {
  const { repo: _repo, runId: _runId, source: _source, ...payload } = record;
  return canonical(payload);
}

/**
 * Unknown-never-zero: an availability entry that is not known or known-zero
 * marks the totals it covers incomplete. An absent entry states nothing and
 * flags nothing; a present value with a non-known availability (a measured
 * zero included) is never complete.
 */
function flagAvailability(result, map, pointer, fields) {
  const entry = map?.[pointer];
  if (entry !== undefined && !KNOWN_STATES.has(entry?.state))
    for (const field of fields) result.incomplete[field] = true;
}

/** Read a bundle-relative file: per-component symlink refusal, O_NOFOLLOW|O_NONBLOCK open, dev/ino identity, bounded read. */
async function readInside(root, rel) {
  if (!text(rel) || !REL.test(rel) || rel.includes('//'))
    return bad(rel, 'untrusted', 'unsafe relative path');
  let handle;
  try {
    let component = root;
    let stat;
    for (const part of rel.split('/')) {
      component = join(component, part);
      stat = await lstat(component);
      if (stat.isSymbolicLink() || (await realpath(component)) !== component)
        return bad(rel, 'untrusted', 'symlink path component');
    }
    if (!stat.isFile()) return bad(rel, 'unsupported', 'not a regular file');
    // O_NONBLOCK: a FIFO swapped in between lstat and open must not block the
    // process forever; the handle is checked below and regular reads are
    // unaffected by the flag.
    handle = await open(
      component,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const opened = await handle.stat();
    if (!opened.isFile()) return bad(rel, 'unsupported', 'not a regular file');
    if (opened.dev !== stat.dev || opened.ino !== stat.ino)
      return bad(rel, 'untrusted', 'file changed');
    if (opened.size > MAX) return bad(rel, 'unsupported', 'exceeds 8 MiB');
    // Bound allocation even if a producer grows the file after stat (the M8a
    // loop); any growth or shrink past the stat size is untrusted.
    const buffer = Buffer.alloc(Math.min(opened.size + 1, MAX + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX) return bad(rel, 'unsupported', 'exceeds 8 MiB');
    return length === opened.size
      ? { bytes: buffer.subarray(0, length) }
      : bad(rel, 'untrusted', 'file changed');
  } catch (error) {
    if (error?.code === 'ENOENT') return bad(rel, 'missing', 'read failed (ENOENT)');
    if (error?.code === 'ELOOP') return bad(rel, 'untrusted', 'symlink encountered while opening');
    return bad(rel, 'unavailable', `read failed (${error?.code ?? 'unknown'})`);
  } finally {
    await handle?.close();
  }
}

function addLeaf(record, result) {
  const key = `${record.repo ?? ''}\u0000${record.runId}\u0000${record.invocation}`;
  // A conflicted identity stays conflicted: every later copy goes to unknown,
  // so the result never depends on the order of dirs or manifest entries.
  if (result.conflictedLeaves.has(key))
    return void result.unknown.push(
      bad(record.source, 'conflict', `invocation ${record.invocation}`),
    );
  const prior = result.byKey.get(key);
  if (prior === undefined) {
    result.byKey.set(key, record);
    result.inputs.push(record);
    return;
  }
  // Duplicate comparison covers the whole payload, not only the cost numbers.
  if (leafFingerprint(prior) === leafFingerprint(record)) return;
  result.byKey.delete(key);
  result.conflictedLeaves.add(key);
  result.inputs.splice(result.inputs.indexOf(prior), 1);
  result.unknown.push(
    bad(`${prior.source} + ${record.source}`, 'conflict', `invocation ${record.invocation}`),
  );
}

// Producer report paths — a report is recognised by WHERE the producers write
// it, not only by its markers: review.address persists a fixed basename
// (src/ops/review/address.ts) and runFix persists fix-run-report-<uuid>.json
// (src/ops/fix/runFix.ts, crypto.randomUUID()); a bundle capture keeps that
// basename under the captured root (scripts/archive-measurement-evidence.mjs).
// The session-index root is an index root, never a report path.
const FIX_RUN_REPORT_NAME =
  /^fix-run-report-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;

/** Is this artifact one of the persisted report paths the producers write? */
function producerReportPath(root, path) {
  if (root === 'session-index' || typeof path !== 'string') return false;
  const name = basename(path);
  return name === 'review-address-report.json' || FIX_RUN_REPORT_NAME.test(name);
}

function ingestJson(parsed, source, result, producerReport) {
  // Persisted operation reports (fix runs, review-address) carry the v2
  // payload embedded at reportV2: runFix and review.address assign the
  // assembled payload to the outer report and persist that, and no writer
  // emits a standalone v2 report — so in real bundles the embedded payload is
  // where the attempt evidence lives. Unwrap it before classification; the
  // strict schema below still governs admission. A session index is never
  // unwrapped (indexVersion stays authoritative for indexes).
  if (
    parsed?.reportVersion === undefined &&
    parsed?.indexVersion === undefined &&
    parsed?.reportV2 !== undefined
  ) {
    if (parsed.reportV2?.reportVersion === undefined)
      return void result.unknown.push(
        bad(source, 'corrupt', 'reportV2 is not a v2 report payload'),
      );
    parsed = parsed.reportV2;
  }
  if (parsed?.reportVersion !== undefined) {
    if (parsed.reportVersion !== REPORT)
      return void result.unknown.push(
        bad(source, 'unsupported', `reportVersion ${String(parsed.reportVersion)}`),
      );
    // The full strict v2 report schema: every attempt row, envelope and
    // availability map is validated before any leaf is admitted.
    const check = ReportV2Schema.safeParse(parsed);
    if (!check.success)
      return void result.unknown.push(bad(source, 'corrupt', 'report failed v2 schema validation'));
    const { attempts, correlation, provenance, availability } = check.data;
    const repo = provenance.repoId;
    // A torn report or an uncollected attempts list makes every total
    // incomplete: the attempts array is not the whole story.
    flagAvailability(result, availability, '', ['tokens', 'wallMs', 'modeledUsd']);
    flagAvailability(result, availability, '/attempts', ['tokens', 'wallMs', 'modeledUsd']);
    for (const event of attempts) {
      const { payload } = event;
      // A leaf's own availability marks its totals incomplete — the root
      // pointer ('' — valid per AvailabilityMapSchema, relative to the
      // containing payload) covers every field, exactly as the report root
      // does; the field pointers mark their own totals.
      flagAvailability(result, payload.availability, '', ['tokens', 'wallMs', 'modeledUsd']);
      flagAvailability(result, payload.availability, '/tokens', ['tokens']);
      flagAvailability(result, payload.availability, '/wallMs', ['wallMs']);
      flagAvailability(result, payload.availability, '/modeledUsd', ['modeledUsd']);
      addLeaf({ ...payload, repo, workId: correlation.workId, runId: event.runId, source }, result);
    }
    return;
  }
  // No measurement marker at all (no reportVersion, reportV2 or indexVersion):
  // WHERE the artifact sits decides. At a producer report path it is a legacy
  // report from before the markers existed — an unknown that degrades totals,
  // never a silent skip that could leave a too-low known total. Anywhere else
  // it is a non-measurement .json — package.json and similar under custom
  // roots — skipped silently; a marker that is present but fails validation
  // stays unknown below.
  if (parsed?.indexVersion === undefined) {
    if (producerReport)
      return void result.unknown.push(
        bad(source, 'unsupported', 'no reportVersion, reportV2 or indexVersion (legacy report)'),
      );
    return;
  }
  if (parsed.indexVersion !== INDEX || !Array.isArray(parsed.sessions))
    return void result.unknown.push(
      bad(source, 'unsupported', `indexVersion ${String(parsed.indexVersion)}`),
    );
  for (const [i, row] of parsed.sessions.entries()) {
    if (
      !text(row?.runId) ||
      !text(row?.workId) ||
      !count(row?.attempts) ||
      (row?.repo !== null && typeof row?.repo !== 'string') ||
      (row.tokens !== null && !count(row.tokens)) ||
      (row.wallMs !== null && !num(row.wallMs))
    ) {
      // One malformed row is skipped; the rest of the index is still read.
      result.unknown.push(bad(source, 'corrupt', `sessions[${i}] is malformed`));
      continue;
    }
    // Row availability: a torn row ('') marks every total, and the field
    // pointers mark their own totals.
    flagAvailability(result, row.availability, '', ['tokens', 'wallMs', 'modeledUsd']);
    flagAvailability(result, row.availability, '/tokens', ['tokens']);
    flagAvailability(result, row.availability, '/wallMs', ['wallMs']);
    const key = `${row.repo ?? ''}\u0000${row.workId}\u0000${row.runId}`;
    if (result.conflictedParents.has(key)) {
      result.unknown.push(bad(source, 'conflict', `run ${row.runId}`));
      continue;
    }
    const prior = result.parentByKey.get(key);
    if (prior !== undefined) {
      // Duplicate comparison covers the whole row, not only the numbers.
      if (canonical(prior.row) === canonical(row)) continue;
      result.parents.splice(result.parents.indexOf(prior.parent), 1);
      result.parentByKey.delete(key);
      result.conflictedParents.add(key);
      result.unknown.push(
        bad(`${prior.parent.source} + ${source}`, 'conflict', `run ${row.runId}`),
      );
      continue;
    }
    const parent = {
      repo: row.repo,
      runId: row.runId,
      workId: row.workId,
      parentWorkId: typeof row.parentWorkId === 'string' ? row.parentWorkId : null,
      attempts: row.attempts,
      tokens: row.tokens,
      wallMs: row.wallMs,
      source,
      mirrored: false,
    };
    result.parentByKey.set(key, { parent, row });
    result.parents.push(parent);
  }
}

async function readBundle(dir, result) {
  let root;
  try {
    root = await realpath(resolve(dir));
    if (!(await lstat(root)).isDirectory())
      return void result.unknown.push(bad(dir, 'missing', 'not a directory'));
  } catch (error) {
    return void result.unknown.push(
      bad(dir, error?.code === 'ENOENT' ? 'missing' : 'unavailable', 'bundle root unavailable'),
    );
  }
  const manifest = await readInside(root, 'manifest.json');
  if (manifest.bytes === undefined)
    return void result.unknown.push(bad(dir, manifest.kind, 'manifest.json unreadable'));
  let parsed;
  try {
    parsed = JSON.parse(manifest.bytes.toString('utf8'));
  } catch {
    return void result.unknown.push(bad(dir, 'corrupt', 'manifest.json is not JSON'));
  }
  if (parsed?.bundleVersion !== BUNDLE)
    return void result.unknown.push(
      bad(dir, 'unsupported', `bundleVersion ${String(parsed?.bundleVersion)}`),
    );
  if (!Array.isArray(parsed.files))
    return void result.unknown.push(bad(dir, 'corrupt', 'manifest.files is not an array'));
  for (const entry of parsed.files) {
    // Measurement inputs are recognised artifacts only: report/index JSON and
    // the session index. Receipts (git-common-dir roots), .ndjson streams and
    // other files (.log and similar) are not measurement inputs — their state
    // or damage never corrupts the measurement totals. (Stream files are the
    // named M10b cut: their attempt rows are mirrored in report v2, which
    // this reader reads.)
    const artifact =
      entry?.root !== 'git-common-dir' &&
      (entry?.root === 'session-index' ||
        (typeof entry?.path === 'string' && entry.path.endsWith('.json')));
    if (!artifact) continue;
    const source = `${dir}:${entry?.root ?? '?'}/${entry?.path ?? '?'}`;
    if (entry?.state !== 'present') {
      result.unknown.push(
        bad(source, entry.state === 'missing' ? 'missing' : 'untrusted', 'artifact absent'),
      );
      continue;
    }
    if (!text(entry.pointer) || !text(entry.sha256)) {
      result.unknown.push(bad(source, 'untrusted', 'present artifact has no checksum'));
      continue;
    }
    const read = await readInside(root, entry.pointer);
    if (read.bytes === undefined) result.unknown.push(bad(source, read.kind, read.reason));
    else if (sha256(read.bytes) !== entry.sha256)
      result.unknown.push(bad(source, 'untrusted', 'checksum mismatch'));
    else {
      try {
        ingestJson(
          JSON.parse(read.bytes.toString('utf8')),
          source,
          result,
          producerReportPath(entry?.root, entry?.path),
        );
      } catch {
        result.unknown.push(bad(source, 'corrupt', 'artifact is not JSON'));
      }
    }
  }
}

function aggregate(records, field, label, incomplete) {
  const known = records.filter((record) => record[field] !== null);
  // Incomplete evidence never yields a known total: with no observed value
  // the state is unavailable; with some it is partial, even at a measured
  // zero (never known-zero).
  if (incomplete && known.length === 0)
    return {
      value: null,
      state: 'unavailable',
      reason: `no ${label} value was observed; measurement inputs were rejected, incomplete or unavailable`,
    };
  if (records.length === 0)
    return { value: null, state: 'n-a', reason: `no ${label} evidence was observed` };
  if (known.length === 0)
    return { value: null, state: 'not-collected', reason: `no ${label} value was observed` };
  const value = known.reduce((sum, record) => sum + record[field], 0);
  if (incomplete)
    return {
      value,
      state: 'partial',
      reason: `observed ${known.length} of ${records.length} ${label} values; measurement inputs were rejected, incomplete or unavailable`,
    };
  return {
    value,
    state: known.length === records.length ? (value === 0 ? 'known-zero' : 'known') : 'partial',
    reason: `observed ${known.length} of ${records.length} ${label} values`,
  };
}

const sanitizeDeep = (value) =>
  typeof value === 'string'
    ? sanitizeEvidenceText(value)
    : Array.isArray(value)
      ? value.map(sanitizeDeep)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeDeep(v)]))
        : value;

/** Read measurement inputs from explicit local bundle directories; nothing is discovered. */
export async function readMeasurementInputs({ dirs } = {}) {
  if (!Array.isArray(dirs) || dirs.some((dir) => !text(dir)))
    throw new TypeError('readMeasurementInputs: dirs must be an array of local directories');
  const result = {
    inputs: [],
    parents: [],
    unknown: [],
    byKey: new Map(),
    parentByKey: new Map(),
    conflictedLeaves: new Set(),
    conflictedParents: new Set(),
    incomplete: { tokens: false, wallMs: false, modeledUsd: false },
  };
  for (const dir of [...new Set(dirs)]) await readBundle(dir, result);
  // Leaves observed per (repo, workId, runId). A parent mirrors its leaves as
  // soon as one is seen (the aggregate is not added), but it is complete only
  // when every leaf its row claims was observed and the leaf token and
  // wall-time sums reach the row totals; otherwise the shortfall is a partial
  // unknown. With no leaf observed the row aggregate is the evidence and its
  // own availability governs completeness.
  const leaves = new Map();
  for (const record of result.inputs) {
    const key = `${record.repo ?? ''}\u0000${record.workId}\u0000${record.runId}`;
    const seen = leaves.get(key) ?? { count: 0, tokens: 0, wallMs: 0 };
    seen.count += 1;
    seen.tokens += record.tokens ?? 0;
    seen.wallMs += record.wallMs ?? 0;
    leaves.set(key, seen);
  }
  for (const parent of result.parents) {
    const seen = leaves.get(`${parent.repo ?? ''}\u0000${parent.workId}\u0000${parent.runId}`);
    parent.mirrored = seen !== undefined && seen.count > 0;
    if (!parent.mirrored) continue;
    if (seen.count < parent.attempts)
      result.unknown.push(
        bad(
          parent.source,
          'partial',
          `run ${parent.runId}: ${seen.count} of ${parent.attempts} leaves observed`,
        ),
      );
    else if (parent.tokens !== null && seen.tokens < parent.tokens)
      result.unknown.push(
        bad(
          parent.source,
          'partial',
          `run ${parent.runId}: leaf token sum ${seen.tokens} is below the row total ${parent.tokens}`,
        ),
      );
    else if (parent.wallMs !== null && seen.wallMs < parent.wallMs)
      result.unknown.push(
        bad(
          parent.source,
          'partial',
          `run ${parent.runId}: leaf wall-time sum ${seen.wallMs} is below the row total ${parent.wallMs}`,
        ),
      );
  }
  const unmirrored = result.parents.filter((parent) => !parent.mirrored);
  const contributors = [
    ...result.inputs,
    ...unmirrored.map((parent) => ({
      tokens: parent.tokens,
      wallMs: parent.wallMs,
      modeledUsd: null,
    })),
  ];
  // Any unknown entry is measurement evidence that could not be used, so no
  // total may claim completeness while one exists.
  const anyUnknown = result.unknown.length > 0;
  const tokens = aggregate(contributors, 'tokens', 'token', anyUnknown || result.incomplete.tokens);
  const wallMs = aggregate(contributors, 'wallMs', 'wall', anyUnknown || result.incomplete.wallMs);
  const modeledUsd = aggregate(
    contributors,
    'modeledUsd',
    'modeled USD',
    anyUnknown || result.incomplete.modeledUsd,
  );
  const availability = Object.fromEntries(
    [tokens, wallMs, modeledUsd].map((item, index) => [
      ['/tokens', '/wallMs', '/modeledUsd'][index],
      { state: item.state, reason: item.reason, source: null },
    ]),
  );
  return sanitizeDeep({
    inputs: result.inputs,
    parents: result.parents,
    unknown: result.unknown,
    totals: {
      // Every admitted leaf is one measured attempt; an unmirrored parent row
      // contributes its stated attempt count (the same double-count guard as
      // costs — a mirrored row's attempts are its leaves, already counted), so
      // an index-only bundle never reports measured costs beside zero
      // attempts.
      attempts: result.inputs.length + unmirrored.reduce((sum, parent) => sum + parent.attempts, 0),
      tokens: tokens.value,
      wallMs: wallMs.value,
      modeledUsd: modeledUsd.value,
      availability,
    },
  });
}
