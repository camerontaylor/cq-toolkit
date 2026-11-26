/**
 * Pure driver-output validators for the crq repair drivers (slice S4).
 *
 * Ports the validation halves of `crq_repair/drivers/{codex,paseo,cq}.py`
 * `invoke` (commits 48eedd939, c6a87eb95, a508c93ca, 2eb6b4770). No process is
 * spawned here and nothing is routed: the live driver shells (class C) stay
 * unbuilt, so these functions take already-captured output.
 */
import { compareCodePoints } from '../../policy/crq/pythonJson.js';
import { pythonStrip } from '../../policy/crq/repairBinding.js';
import {
  JsonObject,
  parseJsonValue,
  pythonNonFinite,
  type JsonValue,
} from '../../policy/crq/jsonValue.js';
import { isPyError, PyError } from '../../queue-runner/pyErrors.js';

const JUDGE_VERDICTS: ReadonlySet<string> = new Set(['valid', 'invalid', 'unsure']);

/** Python `json.loads(text)` over the codex `last.json`; any `ValueError` (incl. bad UTF-8) is null. */
function pythonLoads(bytes: Uint8Array): JsonValue | null {
  try {
    // `Path.read_text()` is strict UTF-8 (UnicodeDecodeError is a ValueError); the BOM is kept
    // so `json.loads` refuses it as Python does.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return parseJsonValue(text, { parseConstant: pythonNonFinite });
  } catch {
    return null;
  }
}

/** A failed attempt's driver result (`codex._failure`): a judge failure is always `unsure`. */
export interface CodexFailure {
  stop: 'error';
  changed: false;
  summary: string;
  commits: [];
  verdict?: 'unsure';
  reason?: string;
}

function codexFailure(judge: boolean, summary: string): CodexFailure {
  const result: CodexFailure = { stop: 'error', changed: false, summary, commits: [] };
  if (judge) {
    result.verdict = 'unsure';
    result.reason = summary;
  }
  return result;
}

export type CodexOutputOutcome =
  | { ok: true; result: JsonObject }
  | { ok: false; failure: CodexFailure };

/** `{**parsed, 'stop': 'ok'}`: other keys pass through; an existing `stop` keeps its position. */
function withStopOk(parsed: JsonObject): JsonObject {
  const entries: Array<readonly [string, JsonValue]> = [];
  let replaced = false;
  for (const [key, value] of parsed.entries) {
    if (key === 'stop') {
      entries.push(['stop', 'ok']);
      replaced = true;
    } else entries.push([key, value]);
  }
  if (!replaced) entries.push(['stop', 'ok']);
  return new JsonObject(entries);
}

/**
 * The tail of `codex.invoke` after `last.json` exists: parse, required fields
 * (with fixer field types, 48eedd939) and the judge verdict enum (c6a87eb95).
 * `output` is the raw `last.json` bytes.
 */
export function validateCodexOutput(output: Uint8Array, judge: boolean): CodexOutputOutcome {
  const parsed = pythonLoads(output);
  if (!(parsed instanceof JsonObject)) {
    return { ok: false, failure: codexFailure(judge, 'codex output unparseable') };
  }
  const required = judge ? ['verdict', 'reason'] : ['changed', 'summary', 'commits'];
  const missing = required.some((key) => !parsed.has(key));
  if (missing || (!judge && !fixerFieldTypesOk(parsed))) {
    return { ok: false, failure: codexFailure(judge, 'codex output misses required fields') };
  }
  if (judge) {
    const verdict = parsed.get('verdict');
    if (typeof verdict !== 'string' || !JUDGE_VERDICTS.has(verdict)) {
      return { ok: false, failure: codexFailure(judge, 'codex verdict outside schema enum') };
    }
  }
  return { ok: true, result: withStopOk(parsed) };
}

/** `changed` bool, `summary` str, `commits` a list of str (Python `isinstance`, so ints are not bools). */
function fixerFieldTypesOk(parsed: JsonObject): boolean {
  const commits = parsed.get('commits');
  return (
    typeof parsed.get('changed') === 'boolean' &&
    typeof parsed.get('summary') === 'string' &&
    Array.isArray(commits) &&
    commits.every((sha) => typeof sha === 'string')
  );
}

/**
 * Index just past the first JSON object that starts at `text[0]` (`{`), or -1.
 * Only the end matters: validity is then decided by the Python-faithful parser, and a
 * malformed object is a `ValueError` on both sides.
 */
function objectEnd(text: string): number {
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (character === '\\') index += 1;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

export interface PaseoJudgeVerdict {
  /** The parsed answer exactly as Python persists it to `judge-result.json` (source key order). */
  answer: JsonObject;
  /** `{**answer, 'stop': 'ok'}`. */
  result: JsonObject;
}

function valueError(message: string): PyError {
  return new PyError('ValueError', message);
}

/**
 * The verdict half of `paseo.invoke` after the agent went idle: the first `{`
 * must open one JSON object, nothing but whitespace may follow it (a508c93ca),
 * and its key set must be exactly `{verdict, reason}`. Python raises
 * `ValueError` (kept as a `PyError`) for every rejection; the caller's budget
 * and cleanup handling is not ported.
 */
export function validatePaseoJudgeAnswer(
  logsStdout: string,
  logsReturncode: number,
): PaseoJudgeVerdict {
  const start = logsStdout.indexOf('{');
  if (logsReturncode !== 0 || start < 0) throw valueError('judge returned no JSON verdict');
  const rest = logsStdout.slice(start);
  const end = objectEnd(rest);
  if (end < 0) throw valueError('judge output is not a JSON object');
  let answer: JsonValue;
  try {
    answer = parseJsonValue(rest.slice(0, end), { parseConstant: pythonNonFinite });
  } catch {
    throw valueError('judge output is not a JSON object');
  }
  if (
    pythonStrip(rest.slice(end)) !== '' ||
    !(answer instanceof JsonObject) ||
    answer.entries.length !== 2 ||
    !answer.has('verdict') ||
    !answer.has('reason')
  ) {
    throw valueError('invalid judge output');
  }
  const verdict = answer.get('verdict');
  if (typeof verdict !== 'string' || !JUDGE_VERDICTS.has(verdict)) {
    throw valueError('invalid judge output');
  }
  if (typeof answer.get('reason') !== 'string') throw valueError('invalid judge output');
  return { answer, result: withStopOk(answer) };
}

/** `PurePath(name).stem` (3.14): the name minus its last suffix, unless only dots would remain. */
export function pythonPathStem(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot !== -1 && name.slice(0, dot).replace(/^\.+/, '') !== '') return name.slice(0, dot);
  return name;
}

/** What `session.json` carries for a cq run (`cq.py` best-effort session link, 2eb6b4770). */
export interface CqSessionRecord {
  harness: 'cq';
  sessionId: string | null;
  sessionIds: string[];
  sessionsDir: string | null;
  workId: string | null;
}

/** Filesystem reads the link needs, each of which may raise `OSError` (Python swallows it). */
export interface CqSessionLinkEffects {
  /** `sessions_dir.is_dir()` */
  isDirectory(): boolean;
  /** Names matching `sessions_dir.glob('*.jsonl')`. */
  listJsonl(): string[];
  /** `any(sessions_dir.iterdir())` */
  hasEntries(): boolean;
  /** `atomic(directory/'session.json', record)`. */
  writeSession(record: CqSessionRecord): void;
}

export interface CqSessionLinkInput {
  /** Absolute `sessions_dir` rendered as `str(path)`. */
  sessionsDir: string;
  /** The session files THIS invocation created (listing after minus listing before). */
  created: ReadonlySet<string>;
  /**
   * `result.get('sessionId')` on the normal path (a non-empty string wins); absent on the
   * wall-clock path, where no parsed result survives the kill.
   */
  valueSessionId?: JsonValue | undefined;
  /** `os.environ.get('CQ_WORK_ID')`. */
  workId: string | null;
}

/**
 * Write the cq `session.json` link, best effort: an `OSError` anywhere in the
 * gathering or the write is swallowed (the link never outranks the verdict);
 * any other failure propagates, as in Python. Only files THIS invocation
 * created identify the current session. Returns the record written, or null.
 */
export function writeCqSessionLink(
  input: CqSessionLinkInput,
  effects: CqSessionLinkEffects,
): CqSessionRecord | null {
  try {
    const isDir = effects.isDirectory();
    const stored = isDir ? effects.listJsonl().map(pythonPathStem).sort(compareCodePoints) : [];
    let sessionId: string | null =
      typeof input.valueSessionId === 'string' && input.valueSessionId !== ''
        ? input.valueSessionId
        : null;
    if (sessionId === null && input.created.size === 1) {
      sessionId = pythonPathStem([...input.created][0] as string);
    }
    const record: CqSessionRecord = {
      harness: 'cq',
      sessionId,
      sessionIds: stored,
      sessionsDir: isDir && effects.hasEntries() ? input.sessionsDir : null,
      workId: input.workId,
    };
    effects.writeSession(record);
    return record;
  } catch (error) {
    if (isPyError(error, 'OSError')) return null;
    throw error;
  }
}
