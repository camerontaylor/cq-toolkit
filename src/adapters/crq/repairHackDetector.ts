/**
 * `crq_repair.hack_detector(cq_bin, diff, cwd)` (apps/crq-python/crq_repair/__init__.py:104):
 * the verdict logic `repair_tick.harvest` (through `crq_repair.mechanical`) and
 * `repair_tick.publish` run over a repair diff. Inactive: nothing imports this from a
 * runtime entry point.
 *
 * The decision is pure over one detector invocation: {@link DetectorRun} stands in for
 * Python's `command(['node', cq_bin, 'gates.hackDetector', '--diff=' + diff, '--json'])`
 * and returns the exit code and the two text streams. Python's classes are kept:
 * `DetectorRejection` (a verdict over this exact diff) is a plain `ValueError`,
 * `DetectorUnavailable` (no verdict; a later tick may succeed) is the `DetectorUnavailable`
 * kind, which `isPyError` already treats as a `ValueError` subclass.
 *
 * {@link inProcessDetector} is the default runner: it calls the pure `gates.hackDetector` op
 * in this process and renders the result the way the CLI's `--json` mode does (`{status,
 * value}` with exit 0 for `ok`, 1 for `failed`/`indeterminate`, 3 for needs-human classes),
 * so no `node` child, no `cq_bin` and no network are involved. A thrown op is rendered as
 * the CLI's `CliErrorArtifact` (`{error: {...}}`, exit 1), which is the one shape Python
 * reads as "the op never ran".
 *
 * Deviations from Python, all disclosed:
 * - The detector runs in process, so there is no `cwd`, no process timeout and no spawn
 *   failure of its own; an injected runner may still throw `PyError('OSError')` or
 *   `PyError('TimeoutExpired')` and gets Python's `did not complete` text.
 * - A diff holding a lone surrogate cannot be UTF-8 encoded: Python's `diff.encode()` raises
 *   `UnicodeEncodeError` (a `ValueError`), as here, before any detector call.
 */
import { pyStrip } from '../../ops/crq/deploy/gitGuards.js';
import { hackDetector } from '../../ops/gates/hackDetector.js';
import { isPyError, PyError } from '../../queue-runner/pyErrors.js';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  pythonNonFinite,
  type JsonValue,
} from '../../policy/crq/jsonValue.js';
import { pythonJsonText } from '../../policy/crq/pythonJson.js';
import { pythonStr } from '../../policy/crq/prReviewFindings.js';
import { clip } from './publicationGitReads.js';

/** `MAX_HACK_DETECTOR_DIFF_BYTES`. */
export const MAX_HACK_DETECTOR_DIFF_BYTES = 120_000;

/** One finished detector process: Python's `CompletedProcess` (text mode). */
export interface DetectorProcess {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** `command([... 'gates.hackDetector', '--diff=' + diff, '--json'], cwd=...)`. */
export type DetectorRun = (diff: string) => Promise<DetectorProcess>;

/** Python truthiness of a decoded JSON value. */
function truthy(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null || value === false || value === '') return false;
  if (value instanceof JsonNumber)
    return value.kind === 'int' ? value.integer !== 0n : value.float !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof JsonObject) return value.entries.length > 0;
  return true;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** `len(text.encode())`, refusing a lone surrogate as `str.encode` does. */
function utf8Length(text: string): number {
  if (LONE_SURROGATE.test(text)) {
    throw new PyError(
      'UnicodeEncodeError',
      "'utf-8' codec can't encode character: surrogates not allowed",
    );
  }
  return Buffer.byteLength(text, 'utf8');
}

const unavailable = (message: string): PyError => new PyError('DetectorUnavailable', message);

/**
 * `hack_detector`: resolves with the parsed verdict when the op returned `ok` with no
 * findings. A rejection is `PyError('ValueError')`, a missing verdict is
 * `PyError('DetectorUnavailable')`.
 */
export async function runHackDetector(diff: string, run: DetectorRun): Promise<JsonValue> {
  const bytes = utf8Length(diff);
  if (bytes > MAX_HACK_DETECTOR_DIFF_BYTES) {
    throw new PyError(
      'ValueError',
      `hack detector did not pass: repair diff too large to scan (${bytes} bytes)`,
    );
  }
  let process: DetectorProcess;
  try {
    process = await run(diff);
  } catch (error) {
    // `except (subprocess.TimeoutExpired, OSError)`
    if (isPyError(error, 'TimeoutExpired', 'OSError')) {
      throw unavailable(`hack detector did not complete: ${clip(error.message, 300)}`);
    }
    throw error;
  }
  let data: JsonValue;
  try {
    data = parseJsonValue(process.stdout, { parseConstant: pythonNonFinite });
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw unavailable(
      `hack detector did not pass: unreadable output (exit ${process.code}): ${clip(
        process.stderr !== '' ? process.stderr : process.stdout,
        300,
      )}`,
    );
  }
  if (!(data instanceof JsonObject)) {
    throw unavailable(
      `hack detector did not pass: unexpected output shape: ${clip(process.stdout, 300)}`,
    );
  }
  const value = data.get('value');
  if (
    process.code !== 0 ||
    data.get('status') !== 'ok' ||
    !Array.isArray(value) ||
    value.length > 0
  ) {
    let detail: string;
    if (Array.isArray(value) && value.length > 0) {
      const rows = value
        .filter((finding): finding is JsonObject => finding instanceof JsonObject)
        .map(
          (finding) =>
            new JsonObject(
              (['kind', 'file', 'message'] as const).map(
                (key) => [key, finding.get(key) ?? null] as const,
              ),
            ),
        );
      detail = pythonJsonText(rows, { asciiOnly: true, sortKeys: false, spacedSeparators: true });
    } else {
      const picked = [data.get('detail'), data.get('error'), data.get('status')].find(truthy);
      detail = pythonStr(picked ?? data.get('status') ?? null);
    }
    const message = `hack detector did not pass: ${clip(detail, 600)}`;
    // `{"error": {...}}` is the CLI's CliErrorArtifact: the op never ran.
    throw data.get('error') instanceof JsonObject
      ? unavailable(message)
      : new PyError('ValueError', message);
  }
  return data;
}

/** The default runner: the pure op in process, rendered as the CLI's `--json` artifact. */
export const inProcessDetector: DetectorRun = async (diff) => {
  try {
    const result = await hackDetector({ diff });
    const code =
      result.status === 'ok'
        ? 0
        : result.status === 'failed'
          ? 1
          : result.status === 'indeterminate'
            ? 1
            : 3;
    return { code, stdout: JSON.stringify(result), stderr: '' };
  } catch (error) {
    const message = pyStrip(error instanceof Error ? error.message : String(error));
    return {
      code: 1,
      stdout: JSON.stringify({
        error: { kind: 'thrown', subcommand: 'gates.hackDetector', message, exitCode: 1 },
      }),
      stderr: '',
    };
  }
};
