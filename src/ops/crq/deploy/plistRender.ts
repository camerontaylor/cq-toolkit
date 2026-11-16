/** Port of prepare-host.py `render_plists` and `live_render`. Inactive; effects injected. */
import { renderAt, rootCheck, type SwitchEffects } from './deployOps.js';
import { type JsonObject } from '../../../policy/crq/jsonValue.js';
import { dumpPlist, parsePlist, type PlistValue } from './plist.js';
import { posixStr } from './unitRender.js';

export interface PlistEffects {
  mkdir(): Promise<void>;
  /** Names matching `com.crq.*.plist` in `<root>/apps/crq-python/ops`. */
  listPlists(): Promise<readonly string[]>;
  readFile(name: string): Promise<Uint8Array>;
  atomicWrite(name: string, data: Uint8Array): Promise<void>;
  /** `str(Path(overlay_path).resolve())` and `str(Path.home())`. */
  overlayPath(): string;
  home(): string;
}

export async function renderPlists(effects: PlistEffects, root: string): Promise<void> {
  await effects.mkdir();
  const replacements: ReadonlyArray<readonly [string, string]> = [
    ['@CRQ_ROOT@', posixStr(`${root}/apps/crq-python`)],
    ['@OVERLAY@', effects.overlayPath()],
    ['@HOME@', effects.home()],
  ];
  const replace = (value: PlistValue): PlistValue => {
    if (typeof value === 'string')
      return replacements.reduce((text, [key, item]) => text.split(key).join(item), value);
    if (Array.isArray(value)) return value.map((v) => replace(v as PlistValue));
    if (value instanceof Map)
      return new Map(
        [...(value as ReadonlyMap<string, PlistValue>)].map(([k, v]) => [k, replace(v)] as const),
      );
    return value;
  };
  for (const name of [...(await effects.listPlists())].sort()) {
    const value = replace(parsePlist(Buffer.from(await effects.readFile(name)).toString('utf8')));
    await effects.atomicWrite(name, Buffer.from(dumpPlist(value)));
  }
}

export async function liveRender(
  effects: SwitchEffects,
  root: string,
  overlay: JsonObject,
): Promise<void> {
  await rootCheck(effects, root, overlay);
  await effects.withTickLock(async () => {
    const data = await renderAt(effects, overlay);
    // Audit before mutation; a failed record leaves the config untouched.
    await effects.record(data, 'live-config', []);
    await effects.writeConfig(data);
  });
}
