/**
 * Source-bound unit rendering ported from `apps/crq-python/ops/prepare-host.py`:
 * `render_service` and `render_units`. Inactive and unimported.
 *
 * Every git call goes through one seam that returns raw stdout bytes, so the
 * text-mode behaviour of Python's `run` (strict UTF-8, universal newlines) and
 * the byte-exact `run_bytes` are both reproduced here. `artifact_identity`
 * (which executes package-runner's inventory semantics) stays an injected
 * seam, as do directory creation and the atomic write.
 */
import { createHash } from 'node:crypto';
import {
  hostPath,
  posixStr,
  renderServiceText,
  splitLinesKeepEnds,
  UNIT_COMMANDS,
  unitCommand,
  validateUnitTemplate,
  ValueError,
} from './unitRender.js';

export interface RenderServiceEffects {
  /** `git -C <root> <args>` stdout bytes; throws when git exits non-zero. */
  git(args: readonly string[]): Promise<Uint8Array>;
}
export interface ArtifactEffects {
  /** Whole-artifact identity of a packaged node runner (`artifact_identity`). */
  artifactIdentity(artifactRoot: string, runtime: string): Promise<unknown>;
}
export interface RenderUnitsEffects extends RenderServiceEffects {
  mkdir(path: string): Promise<void>;
  /** `atomic_bytes`: temp file, fsync, rename, fsync the directory. */
  atomicWrite(path: string, data: Uint8Array): Promise<void>;
}

export interface RenderedService {
  readonly unit: string;
  readonly runtime: string;
  readonly sourceSha: string;
  readonly templatePath: string;
  readonly templateBlobOid: string;
  readonly templateSha256: string;
  readonly execStart: string | null;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly artifact: unknown;
}

const sha256 = (data: Uint8Array | string): string =>
  createHash('sha256').update(data).digest('hex');
const decodeUtf8 = (data: Uint8Array): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    throw new ValueError('invalid UTF-8');
  }
};
/** `subprocess.run(text=True).stdout`: strict UTF-8, universal newlines. */
export const pyText = (data: Uint8Array): string => decodeUtf8(data).replace(/\r\n?/g, '\n');
/** `git()`: text stdout without trailing newlines. */
export const gitText = async (fx: RenderServiceEffects, args: readonly string[]): Promise<string> =>
  pyText(await fx.git(args)).replace(/\n+$/, '');

/** Python `str.splitlines()`. */
export function splitLines(text: string): string[] {
  return splitLinesKeepEnds(text).map((line) => {
    if (line.endsWith('\r\n')) return line.slice(0, -2);
    const last = line.at(-1) ?? '';
    return last !== '' && '\n\r\v\f\u001c\u001d\u001e\u0085\u2028\u2029'.includes(last)
      ? line.slice(0, -1)
      : line;
  });
}

/** `Path(root)/'apps/crq-python'` after `host_path`. */
const runnerRoot = (root: string): string => `${hostPath(root)}/apps/crq-python`;

const SOURCE_DIR = 'apps/crq-python/ops/systemd/';

/** Read-only, source-bound render of one unit at an immutable commit. */
export async function renderService(
  effects: RenderServiceEffects & ArtifactEffects,
  root: string,
  unit: string,
  home: string,
  options: { runtime?: string; sha?: string; artifactRoot?: string | null } = {},
): Promise<RenderedService> {
  const runtime = options.runtime ?? 'python';
  const sha = options.sha ?? 'HEAD';
  if (!Object.prototype.hasOwnProperty.call(UNIT_COMMANDS, unit))
    throw new ValueError('unknown runtime unit');
  const command = unitCommand(unit, runtime, home);
  const commit = await gitText(effects, ['rev-parse', `${sha}^{commit}`]);
  if (!/^[0-9a-f]{40}$/.test(commit))
    throw new ValueError('source commit must resolve to a full SHA');
  const sources = splitLines(
    await gitText(effects, ['ls-tree', '-r', '--name-only', commit, SOURCE_DIR]),
  );
  const sourcePath = SOURCE_DIR + unit;
  if (!sources.includes(sourcePath))
    throw new ValueError('unit template is absent from the pinned commit');
  const blob = await gitText(effects, ['rev-parse', `${commit}:${sourcePath}`]);
  const raw = await effects.git(['cat-file', 'blob', blob]);
  const expected = createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${raw.length}\0`), raw]))
    .digest('hex');
  if (expected !== blob) throw new ValueError('template bytes do not match the pinned Git blob');
  const text = decodeUtf8(raw);
  validateUnitTemplate(unit, text);
  if (splitLines(text).filter((line) => line.startsWith('ExecStart=')).length !== 1)
    throw new ValueError(`unit must have exactly one ExecStart: ${unit}`);
  const rendered = renderServiceText(unit, text, runnerRoot(root), command);
  const encoded = Buffer.from(rendered, 'utf8');
  let artifact: unknown = null;
  if (runtime !== 'python') {
    const where =
      options.artifactRoot !== undefined && options.artifactRoot !== null
        ? posixStr(options.artifactRoot)
        : `${posixStr(home) === '/' ? '' : posixStr(home)}/.local/opt/crq-${runtime.slice(5)}`;
    artifact = await effects.artifactIdentity(where, runtime);
  }
  const execLine = splitLines(rendered).find((line) => line.startsWith('ExecStart='));
  return {
    unit,
    runtime,
    sourceSha: commit,
    templatePath: sourcePath,
    templateBlobOid: blob,
    templateSha256: sha256(raw),
    execStart:
      execLine === undefined ? null : execLine.slice('ExecStart='.length).replace(/\n+$/, ''),
    bytes: encoded,
    sha256: sha256(encoded),
    artifact,
  };
}

/** `Path(source).name`: the last non-empty component. */
export const nameOf = (source: string): string =>
  source
    .split('/')
    .filter((p) => p !== '' && p !== '.')
    .at(-1) ?? '';

/**
 * Render every committed CRQ unit template at one immutable commit into
 * `output`. All templates are validated and rendered before the first write.
 */
export async function renderUnits(
  effects: RenderUnitsEffects,
  root: string,
  output: string,
  home: string,
  options: { sha?: string; runtimes?: ReadonlyMap<string, unknown> | null } = {},
): Promise<string[]> {
  const commit = await gitText(effects, ['rev-parse', `${options.sha ?? 'HEAD'}^{commit}`]);
  const sources = splitLines(
    await gitText(effects, ['ls-tree', '-r', '--name-only', commit, SOURCE_DIR]),
  );
  const templates: [string, string][] = [];
  for (const source of sources)
    if (nameOf(source).startsWith('crq-'))
      templates.push([nameOf(source), pyText(await effects.git(['show', `${commit}:${source}`]))]);
  if (!templates.length) throw new ValueError('target lacks CRQ unit templates');
  for (const [name, text] of templates) validateUnitTemplate(name, text);
  const runtimes = options.runtimes ?? new Map<string, unknown>();
  if ([...runtimes.keys()].some((u) => !Object.prototype.hasOwnProperty.call(UNIT_COMMANDS, u)))
    throw new ValueError('unknown runtime unit');
  const present = new Set(templates.map(([name]) => name));
  if ([...runtimes.keys()].some((u) => !present.has(u)))
    throw new ValueError('runtime unit absent from target');
  const commands = new Map<string, string>();
  for (const [unit, runtime] of runtimes) {
    const command = unitCommand(unit, runtime, home);
    if (command !== null) commands.set(unit, command);
  }
  const runner = runnerRoot(root);
  const rendered = templates.map(([name, text]): [string, string] => [
    name,
    renderServiceText(name, text, runner, commands.get(name) ?? null),
  ]);
  const out = posixStr(output);
  await effects.mkdir(out);
  const paths: string[] = [];
  for (const [name, text] of rendered) {
    const target = `${out === '/' ? '' : out}/${name}`;
    await effects.atomicWrite(target, Buffer.from(text, 'utf8'));
    paths.push(target);
  }
  return paths;
}
