// Offline measurement input reader for M10b (ADR-0008 vocabulary). Explicit local
// bundle directories only (the M8a shape): no ambient scan, no cwd walk, no
// network. bundleVersion and every stored sha256 are validated. Missing, corrupt,
// unverifiable or ambiguous evidence goes to the UNKNOWN bucket with a reason,
// never to a fallback zero. Dedup identity is (repo, runId, invocation); a
// session-index row is a derived parent aggregate and is not added when its run's
// attempt-finished leaves are observed, so costs count once.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sanitizeEvidenceText } from './archive-measurement-evidence.mjs';

const BUNDLE = 1,
  REPORT = 2,
  INDEX = 1,
  MAX = 8 * 1024 * 1024;
const CLASSES = new Set(['retriable', 'terminal', 'infrastructure', 'budget', 'human']);
const REL = /^(?!\/)(?!\.\.?(?:\/|$))(?!.*\/\.\.?(?:\/|$))[^\\\0]+$/;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const num = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const text = (v) => typeof v === 'string' && v.length > 0;
const bad = (source, kind, reason) => ({ source, kind, reason });

/** Read a bundle-relative file: per-component symlink refusal, O_NOFOLLOW, dev/ino identity. */
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
    handle = await open(component, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino)
      return bad(rel, 'untrusted', 'file changed');
    if (opened.size > MAX) return bad(rel, 'unsupported', 'exceeds 8 MiB');
    const bytes = await handle.readFile();
    if (bytes.length > MAX) return bad(rel, 'unsupported', 'exceeds 8 MiB');
    return bytes.length === opened.size ? { bytes } : bad(rel, 'untrusted', 'file changed');
  } catch (error) {
    return bad(
      rel,
      error?.code === 'ENOENT' ? 'missing' : 'unavailable',
      `read failed (${error?.code ?? 'unknown'})`,
    );
  } finally {
    await handle?.close();
  }
}

/** Validate an attempt-finished payload against the ADR-0008 attempt row. */
function problem(p) {
  if (p === null || typeof p !== 'object') return 'payload is not an object';
  if (p.tier !== 'worker' && p.tier !== 'rescue') return 'tier is not worker or rescue';
  if (p.model !== null && !(text(p.model?.model) && text(p.model?.provider)))
    return 'model is malformed';
  if (p.tokens !== null && !count(p.tokens)) return 'tokens is not a count';
  if (p.wallMs !== null && !num(p.wallMs)) return 'wallMs is not a number';
  if (p.modeledUsd !== null && !num(p.modeledUsd)) return 'modeledUsd is not a number';
  if (!text(p.stopReason) || !text(p.stopCode)) return 'stop identity is absent';
  if (!CLASSES.has(p.class)) return 'class is not an ADR stop class';
  return p.error !== null && typeof p.error !== 'object' ? 'error is malformed' : null;
}

function addLeaf(record, result) {
  const key = `${record.runId}\u0000${record.invocation}`;
  const prior = result.byKey.get(key);
  if (prior === undefined) {
    result.byKey.set(key, record);
    result.inputs.push(record);
    return;
  }
  const conflict =
    (prior.repo !== null && record.repo !== null && prior.repo !== record.repo) ||
    prior.tokens !== record.tokens ||
    prior.wallMs !== record.wallMs ||
    prior.modeledUsd !== record.modeledUsd;
  if (!conflict) return void (prior.repo ??= record.repo);
  result.byKey.delete(key);
  result.inputs.splice(result.inputs.indexOf(prior), 1);
  result.unknown.push(
    bad(`${prior.source} + ${record.source}`, 'conflict', `invocation ${record.invocation}`),
  );
}

function addAttempt(event, repo, source, result) {
  const p = event?.payload;
  if (event?.type !== 'attempt-finished' || !text(event.runId) || !text(p?.invocation))
    return void result.unknown.push(bad(source, 'corrupt', 'attempt lacks identity'));
  const issue = problem(p);
  if (issue !== null)
    return void result.unknown.push(bad(source, 'corrupt', `attempt ${p.invocation}: ${issue}`));
  addLeaf({ ...p, repo, runId: event.runId, invocation: p.invocation, source }, result);
}

function ingestJson(parsed, source, result) {
  if (parsed?.reportVersion !== undefined) {
    if (parsed.reportVersion !== REPORT)
      return void result.unknown.push(
        bad(source, 'unsupported', `reportVersion ${String(parsed.reportVersion)}`),
      );
    if (!Array.isArray(parsed.attempts))
      return void result.unknown.push(bad(source, 'corrupt', 'report.attempts is not an array'));
    const repo = typeof parsed.provenance?.repoId === 'string' ? parsed.provenance.repoId : null;
    for (const event of parsed.attempts) addAttempt(event, repo, source, result);
    return;
  }
  if (parsed?.indexVersion === undefined) return; // a receipt-shaped JSON, not an input
  if (parsed.indexVersion !== INDEX || !Array.isArray(parsed.sessions))
    return void result.unknown.push(
      bad(source, 'unsupported', `indexVersion ${String(parsed.indexVersion)}`),
    );
  for (const row of parsed.sessions) {
    if (
      !text(row?.runId) ||
      (row.tokens !== null && !count(row.tokens)) ||
      (row.wallMs !== null && !num(row.wallMs))
    )
      return void result.unknown.push(bad(source, 'corrupt', 'session row is malformed'));
    const prior = result.parentByRun.get(row.runId);
    if (prior !== undefined && prior.tokens === row.tokens && prior.wallMs === row.wallMs) continue;
    if (prior !== undefined) {
      result.parents.splice(result.parents.indexOf(prior), 1);
      result.parentByRun.delete(row.runId);
      result.unknown.push(bad(`${prior.source} + ${source}`, 'conflict', `run ${row.runId}`));
      continue;
    }
    const parent = {
      runId: row.runId,
      parentWorkId: typeof row.parentWorkId === 'string' ? row.parentWorkId : null,
      tokens: row.tokens,
      wallMs: row.wallMs,
      mirrored: false,
    };
    result.parentByRun.set(row.runId, parent);
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
  for (const entry of Array.isArray(parsed.files) ? parsed.files : []) {
    // Receipts are not measurement inputs; stream files are the named M10b cut
    // (their attempt rows are mirrored in report v2, which this reader reads).
    if (entry?.root === 'git-common-dir' || entry?.path?.endsWith?.('.ndjson')) continue;
    const source = `${dir}:${entry?.root ?? '?'}/${entry?.path ?? '?'}`;
    const artifact =
      entry?.root === 'session-index' ||
      (typeof entry?.path === 'string' && entry.path.endsWith('.json'));
    if (entry?.state !== 'present') {
      if (artifact)
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
        ingestJson(JSON.parse(read.bytes.toString('utf8')), source, result);
      } catch {
        result.unknown.push(bad(source, 'corrupt', 'artifact is not JSON'));
      }
    }
  }
}

function aggregate(records, field, label) {
  const known = records.filter((record) => record[field] !== null);
  if (records.length === 0)
    return { value: null, state: 'n-a', reason: `no ${label} evidence was observed` };
  if (known.length === 0)
    return { value: null, state: 'not-collected', reason: `no ${label} value was observed` };
  const value = known.reduce((sum, record) => sum + record[field], 0);
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
  const result = { inputs: [], parents: [], unknown: [], byKey: new Map(), parentByRun: new Map() };
  for (const dir of [...new Set(dirs)]) await readBundle(dir, result);
  const leafRuns = new Set(result.inputs.map((record) => record.runId));
  for (const parent of result.parents) parent.mirrored = leafRuns.has(parent.runId);
  const contributors = [
    ...result.inputs,
    ...result.parents
      .filter((parent) => !parent.mirrored)
      .map((parent) => ({ tokens: parent.tokens, wallMs: parent.wallMs, modeledUsd: null })),
  ];
  const tokens = aggregate(contributors, 'tokens', 'token');
  const wallMs = aggregate(contributors, 'wallMs', 'wall');
  const modeledUsd = aggregate(contributors, 'modeledUsd', 'modeled USD');
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
      attempts: result.inputs.length,
      tokens: tokens.value,
      wallMs: wallMs.value,
      modeledUsd: modeledUsd.value,
      availability,
    },
  });
}
