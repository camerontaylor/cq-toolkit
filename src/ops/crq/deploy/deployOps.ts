/**
 * Checkout-state operations ported from `apps/crq-python/ops/prepare-host.py`:
 * `root_check`, `inactive`, `record`, `verify_target`, `switch`,
 * `legacy_check` and `prepare`. Inactive and unimported. Every filesystem,
 * process, lock and clock access is an injected seam; the control flow,
 * ordering and refusal messages are the Python ones.
 */
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  type JsonValue,
} from '../../../policy/crq/jsonValue.js';
import { ledgerValueEqual } from '../../../policy/crq/ledger.js';
import {
  apply,
  CONFIG,
  digest,
  driftCheck,
  encode,
  PythonError,
  render,
  truthy,
  ValueError,
  withKey,
} from './hostOverlay.js';
import { gitText, nameOf, pyText, splitLines } from './renderService.js';
import { posixStr, validateUnitTemplate } from './unitRender.js';

export const POLICY_FLOOR = 'f748fd43e75505f4e89098a4ffe28fa2a179a50c';
export const LEGACY_SHA = '0e35cd11153fc7ad681f002d580b9b22feb22092';

/** Python `subprocess.CalledProcessError`. */
export class CalledProcessError extends Error {
  override name = 'CalledProcessError';
  constructor(
    readonly returncode: number,
    readonly stderr: string,
    message = `Command returned non-zero exit status ${returncode}.`,
  ) {
    super(message);
  }
}

/** `git -C <root> <args>` stdout bytes; rejects with CalledProcessError on non-zero. */
export interface GitEffects {
  git(args: readonly string[]): Promise<Uint8Array>;
}

// ---- Python str helpers -------------------------------------------------

const PY_SPACE = new Set('\t\n\v\f\r\u001c\u001d\u001e\u001f \u0085                 　');
/** Python `str.strip()` and `str.split()` use `str.isspace`, not JS `trim`. */
function pyStrip(s: string): string {
  const chars = [...s];
  let a = 0;
  let b = chars.length;
  while (a < b && PY_SPACE.has(chars[a] as string)) a++;
  while (b > a && PY_SPACE.has(chars[b - 1] as string)) b--;
  return chars.slice(a, b).join('');
}
function pySplit(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of s) {
    if (PY_SPACE.has(ch)) {
      if (cur !== '') out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur !== '') out.push(cur);
  return out;
}
const codePointCompare = (a: string, b: string): number => {
  const x = [...a].map((c) => c.codePointAt(0) as number);
  const y = [...b].map((c) => c.codePointAt(0) as number);
  for (let i = 0; i < Math.min(x.length, y.length); i++)
    if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  return x.length - y.length;
};

const ONE = JsonNumber.int(1);
const ZERO = JsonNumber.int(0);
const FIVE = JsonNumber.int(5);

// ---- root_check ---------------------------------------------------------

export interface RootCheckEffects extends GitEffects {
  /** `Path(path).resolve()` as a string. */
  resolve(path: string): string;
}
export async function rootCheck(
  effects: RootCheckEffects,
  root: string,
  overlay: JsonObject,
): Promise<void> {
  const deploy = overlay.get('deploy_root');
  if (typeof deploy !== 'string') throw new PythonError('TypeError', 'deploy_root is not a string');
  if (effects.resolve(root) !== effects.resolve(deploy))
    throw new ValueError('not the overlay deployment checkout');
  if ((await gitText(effects, ['rev-parse', '--show-toplevel'])) !== effects.resolve(root))
    throw new ValueError('deploy_root must be the full monorepo checkout');
  if ((await gitText(effects, ['rev-parse', '--abbrev-ref', 'HEAD'])) !== 'HEAD')
    throw new ValueError('deployment checkout must be detached');
}

// ---- inactive -----------------------------------------------------------

export interface SystemctlResult {
  readonly code: number;
  /** Text-mode stdout and stderr (strict UTF-8, universal newlines). */
  readonly stdout: string;
  readonly stderr: string;
}
export interface InactiveEffects {
  /** Names matching `<root>/apps/crq-python/ops/systemd/crq-*`. */
  unitFiles(): Promise<string[]>;
  /** `systemctl --user ...`; resolves with the exit status instead of throwing. */
  systemctl(args: readonly string[]): Promise<SystemctlResult>;
}
export async function inactive(effects: InactiveEffects): Promise<void> {
  const names = new Set(await effects.unitFiles());
  for (const command of ['list-unit-files', 'list-units']) {
    const args = ['--user', command, '--no-legend', '--no-pager', '--plain'];
    if (command === 'list-units') args.push('--all');
    const result = await effects.systemctl([...args, 'crq-*']);
    let output = result.stdout;
    if (result.code !== 0) {
      // A unit-file pattern that matches nothing exits 1 with no diagnostic.
      if (command !== 'list-unit-files' || result.code !== 1 || pyStrip(result.stderr) !== '')
        throw new CalledProcessError(result.code, result.stderr);
      output = '';
    }
    for (const line of splitLines(output)) {
      const parts = pySplit(line);
      const name = parts[0] ?? '';
      if (!name.startsWith('crq-') || !/^[A-Za-z0-9_.@:-]+$/.test(name))
        throw new ValueError('unrecognized CRQ unit listing');
      names.add(name);
    }
  }
  for (const name of [...names].sort(codePointCompare)) {
    const shown = await effects.systemctl([
      '--user',
      'show',
      '--property=ActiveState',
      '--value',
      name,
    ]);
    if (shown.code !== 0) throw new CalledProcessError(shown.code, shown.stderr);
    const state = pyStrip(shown.stdout);
    if (state !== 'inactive' && state !== 'failed')
      throw new ValueError(`refusing active or unknown unit: ${name}`);
  }
}

// ---- record -------------------------------------------------------------

export interface RecordEffects extends GitEffects {
  /** `require_outside_git(directory)`: throws ValueError inside a checkout. */
  requireOutsideGit(directory: string): Promise<void>;
  /** `mkdir(mode=0o700, parents=True, exist_ok=True)`. */
  mkdirPrivate(directory: string): Promise<void>;
  /** `stat().st_mode`. */
  mode(directory: string): Promise<number>;
  /** `datetime.now(timezone.utc).isoformat()`. */
  nowIso(): string;
  /** `uuid.uuid4().hex`. */
  uuidHex(): string;
  atomicWrite(path: string, data: Uint8Array): Promise<void>;
}
export async function record(
  effects: RecordEffects,
  overlay: JsonObject,
  raw: Uint8Array,
  config: Uint8Array,
  operation: string,
  extra: ReadonlyArray<readonly [string, JsonValue]> = [],
): Promise<JsonObject> {
  const dir = overlay.get('record_dir');
  if (typeof dir !== 'string') throw new PythonError('TypeError', 'record_dir is not a string');
  await effects.requireOutsideGit(dir);
  await effects.mkdirPrivate(dir);
  if (((await effects.mode(dir)) & 0o077) !== 0)
    throw new ValueError('private record directory must have mode 0700');
  const sha = await gitText(effects, ['rev-parse', 'HEAD']);
  const data = new JsonObject([
    ['schema_version', ONE],
    ['operation', operation],
    ['at', effects.nowIso()],
    ['record_type', 'render-intent'],
    ['sha', sha],
    ['overlay_sha256', digest(raw)],
    ['config_sha256', digest(config)],
    ...extra,
  ]);
  const base = posixStr(dir);
  await effects.atomicWrite(`${base === '/' ? '' : base}/${effects.uuidHex()}.json`, encode(data));
  return data;
}

// ---- verify_target ------------------------------------------------------

const committed = async (effects: GitEffects, sha: string, path = CONFIG): Promise<JsonValue> =>
  parseJsonValue(pyText(await effects.git(['show', `${sha}:${path}`])), {
    parseConstant: () => null,
  });

/** `.get(key, default)` on a JSON value the way Python would call it. */
function pyGet(value: JsonValue, key: string, fallback: JsonValue): JsonValue {
  if (!(value instanceof JsonObject))
    throw new PythonError('AttributeError', "object has no attribute 'get'");
  return value.has(key) ? (value.get(key) as JsonValue) : fallback;
}

export async function verifyTarget(
  effects: GitEffects,
  target: string,
  tag: string | null = null,
): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(target)) throw new ValueError('target must be a full commit SHA');
  if (tag !== null) {
    if (!/^crq-runner\/[0-9]{8}-[0-9]+$/.test(tag))
      throw new ValueError('runner tag must be crq-runner/YYYYMMDD-N');
    const ref = `refs/tags/${tag}`;
    if (
      (await gitText(effects, ['cat-file', '-t', ref])) !== 'tag' ||
      (await gitText(effects, ['rev-parse', `${ref}^{commit}`])) !== target
    )
      throw new ValueError('annotated tag does not name target');
  }
  await gitText(effects, ['merge-base', '--is-ancestor', target, 'refs/remotes/origin/main']);
  await gitText(effects, ['merge-base', '--is-ancestor', POLICY_FLOOR, target]);
  if (await gitText(effects, ['ls-tree', '-r', '--name-only', target, 'apps/crq-python/state/']))
    throw new ValueError('target must not track runner state');
  const config = await committed(effects, target);
  const raw = pyGet(config, 'promotion', null);
  const promotion: JsonValue = truthy(raw) ? raw : new JsonObject([]);
  if (
    !ledgerValueEqual(pyGet(promotion, 'merges_trigger', ONE), ONE) ||
    !ledgerValueEqual(pyGet(promotion, 'dispatch_after_min', ZERO), ZERO)
  )
    throw new ValueError('target predates the every-green-tip policy floor');
  if (!(await gitText(effects, ['ls-tree', target, 'apps/crq-python/ops/prepare-host.py'])))
    throw new ValueError('target lacks monorepo deploy helper');
  const templates = splitLines(
    await gitText(effects, [
      'ls-tree',
      '-r',
      '--name-only',
      target,
      'apps/crq-python/ops/systemd/',
    ]),
  ).filter((path) => nameOf(path).startsWith('crq-'));
  if (!templates.length) throw new ValueError('target lacks CRQ unit templates');
  for (const path of templates)
    validateUnitTemplate(nameOf(path), await gitText(effects, ['show', `${target}:${path}`]));
}

// ---- switch -------------------------------------------------------------

export interface SwitchEffects extends GitEffects, RootCheckEffects, InactiveEffects {
  /** Run `fn` while holding the tick lock; releases on return or throw. */
  withTickLock<T>(fn: () => Promise<T>): Promise<T>;
  /** Bytes of the live `<root>/apps/crq-python/config.json`. */
  readConfig(): Promise<Uint8Array>;
  writeConfig(data: Uint8Array): Promise<void>;
  /** `record(root, overlay, raw, config, operation, **extra)`. */
  record(
    config: Uint8Array,
    operation: string,
    extra: ReadonlyArray<readonly [string, JsonValue]>,
  ): Promise<void>;
}
const renderAt = (effects: GitEffects, overlay: JsonObject, sha = 'HEAD'): Promise<Uint8Array> =>
  render(
    { gitShow: async (s, p) => pyText(await effects.git(['show', `${s}:${p}`])) },
    overlay,
    sha,
  );

const STATUS = ['status', '--porcelain', '--untracked-files=all'] as const;

export async function switchCheckout(
  effects: SwitchEffects,
  root: string,
  overlay: JsonObject,
  target: string,
  tag: string | null = null,
): Promise<string> {
  await rootCheck(effects, root, overlay);
  await verifyTarget(effects, target, tag);
  // Validate the destination config before changing anything.
  const destination = await renderAt(effects, overlay, target);
  await inactive(effects);
  await effects.withTickLock(async () => {
    await inactive(effects);
    const current = await renderAt(effects, overlay);
    await driftCheck(current, () => effects.readConfig());
    const changes = splitLines(await gitText(effects, STATUS));
    if (changes.some((line) => line !== ` M ${CONFIG}`))
      throw new ValueError('checkout has changes other than rendered config');
    const previous = await gitText(effects, ['rev-parse', 'HEAD']);
    await effects.record(current, 'switch-before', [
      ['target', target],
      ['tag', tag],
    ]);
    await gitText(effects, ['restore', '--', CONFIG]);
    try {
      if (await gitText(effects, STATUS))
        throw new ValueError('checkout not clean after config restore');
      await gitText(effects, ['checkout', '--detach', target]);
    } catch (error) {
      await effects.writeConfig(current);
      throw error;
    }
    // Same tick lock spans drift check, checkout, render and audit.
    await effects.record(destination, 'switch-render', [
      ['previous_sha', previous],
      ['tag', tag],
    ]);
    await effects.writeConfig(destination);
    const status = await gitText(effects, STATUS);
    if (status !== '' && status !== ` M ${CONFIG}`)
      throw new ValueError('post-switch status must contain only rendered config');
  });
  return target;
}

// ---- legacy_check -------------------------------------------------------

export interface LegacyEffects extends GitEffects {
  /** Bytes of the legacy checkout's `config.json`. */
  readConfig(): Promise<Uint8Array>;
  record(
    config: Uint8Array,
    operation: string,
    extra: ReadonlyArray<readonly [string, JsonValue]>,
  ): Promise<void>;
}
/** Read-only first-deploy fence: accepted source + host overrides + 5→1 only. */
export async function legacyCheck(effects: LegacyEffects, overlay: JsonObject): Promise<void> {
  if ((await gitText(effects, ['rev-parse', 'HEAD'])) !== LEGACY_SHA)
    throw new ValueError('legacy checkout HEAD must match the accepted baseline');
  const tracked = splitLines(
    await gitText(effects, ['status', '--porcelain', '--untracked-files=no']),
  );
  if (tracked.some((line) => line !== ' M config.json'))
    throw new ValueError('legacy checkout has tracked changes other than config.json');
  const config = apply(await committed(effects, LEGACY_SHA, 'config.json'), overlay);
  const promotion = config.get('promotion');
  if (promotion === undefined) throw new PythonError('KeyError', "'promotion'");
  if (!(promotion instanceof JsonObject))
    throw new PythonError('TypeError', 'promotion is not subscriptable by string');
  const trigger = promotion.get('merges_trigger');
  if (trigger === undefined) throw new PythonError('KeyError', "'merges_trigger'");
  if (!ledgerValueEqual(trigger, FIVE)) throw new ValueError('unexpected accepted baseline policy');
  const data = encode(withKey(config, 'promotion', withKey(promotion, 'merges_trigger', ONE)));
  await driftCheck(data, () => effects.readConfig());
  // No live file/marker/lock writes on the old checkout, including no render.
  await effects.record(data, 'legacy-drift-check', [['baseline_sha', LEGACY_SHA]]);
}

// ---- prepare ------------------------------------------------------------

export interface PrepareEffects extends SwitchEffects {
  /** Render every unit into a fresh temporary directory; returns the file paths. */
  renderUnitsToTemp<T>(sha: string, use: (paths: string[]) => Promise<T>): Promise<T>;
  /** `systemd-analyze --user verify <paths>`; rejects on failure. */
  verifyUnits(paths: readonly string[]): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  /** `output.mkdir(parents=True, exist_ok=True)`. */
  mkdirOutput(): Promise<void>;
  /** Write below the units output directory. */
  writeOutput(name: string, data: Uint8Array): Promise<void>;
  /** `<root>/apps/crq-python/state/runner-disabled`. */
  writeMarker(data: Uint8Array): Promise<void>;
  daemonReload(): Promise<void>;
}
export async function prepare(
  effects: PrepareEffects,
  root: string,
  overlay: JsonObject,
  tag: string | null,
): Promise<void> {
  await rootCheck(effects, root, overlay);
  await inactive(effects);
  await effects.withTickLock(async () => {
    await inactive(effects);
    const sha = await gitText(effects, ['rev-parse', 'HEAD']);
    // Validate against the SHA read under the lock so a concurrent switch
    // cannot make prepare render from a commit the tag does not name.
    await verifyTarget(effects, sha, tag);
    const data = await renderAt(effects, overlay, sha);
    await effects.renderUnitsToTemp(sha, async (paths) => {
      await effects.verifyUnits(paths);
      const shas: [string, JsonValue][] = [];
      for (const path of paths) shas.push([nameOf(path), digest(await effects.readFile(path))]);
      await effects.record(data, 'prepare', [['unit_sha256', new JsonObject(shas)]]);
      await effects.mkdirOutput();
      for (const path of paths)
        await effects.writeOutput(nameOf(path), await effects.readFile(path));
    });
    // Marker first: a crash before the config write leaves the host inert
    // on its previous configuration instead of live without the marker.
    await effects.writeMarker(Buffer.from('Prepared inert; owner approval required to start.\n'));
    await effects.writeConfig(data);
  });
  await effects.daemonReload();
  // Deliberately no start or enable here.
}
