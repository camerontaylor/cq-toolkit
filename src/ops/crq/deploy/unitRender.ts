/**
 * Pure unit-template helpers ported from `apps/crq-python/ops/prepare-host.py`:
 * `validate_unit_template`, `UNIT_COMMANDS`, `unit_command` and
 * `render_service_text`. Inactive and unimported; no filesystem access.
 *
 * `unit_command`'s `home=None` branch reads `Path.home()`; here the caller
 * passes that value, so the home directory is an explicit argument.
 */

import { ValueError } from './hostOverlay.js';

export { ValueError };

export const UNIT_COMMANDS: Readonly<Record<string, string>> = Object.freeze({
  'crq-tick.service': 'tick',
  'crq-slot.service': 'slot',
  'crq-repair.service': 'repair',
  'crq-publisher.service': 'publish',
  'crq-backfill.service': 'backfill inventory',
  'crq-watchdog.service': 'watchdog',
});

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** `PurePosixPath(value)`'s string: '' and '.' components dropped, exactly two leading slashes kept. */
export function posixStr(value: string): string {
  const parts = value.split('/').filter((p) => p !== '' && p !== '.');
  const lead =
    value.startsWith('//') && !value.startsWith('///') ? '//' : value.startsWith('/') ? '/' : '';
  return lead + parts.join('/') || '.';
}

/** `PurePosixPath(name).suffix`. */
function suffix(name: string): string {
  const parts = name.split('/').filter((p) => p !== '' && p !== '.');
  const last = parts.at(-1) ?? '';
  const i = last.lastIndexOf('.');
  return i > 0 && last !== '..' ? last.slice(i) : '';
}

/** `host_path`: no systemd specifiers, whitespace, shell syntax or traversal. Returns `str(Path(value))`. */
export function hostPath(value: string): string {
  if (!/^\/[A-Za-z0-9_./-]+$/s.test(value))
    throw new ValueError('host paths must be absolute, without whitespace or specifiers');
  if (value.split('/').includes('..')) throw new ValueError('parent traversal is not a host path');
  return posixStr(value);
}

/** `.service` and `.path` templates must carry the monorepo root placeholder. */
export function validateUnitTemplate(name: string, text: string): void {
  if (['.service', '.path'].includes(suffix(name)) && !text.includes('@CRQ_ROOT@'))
    throw new ValueError(`unit lacks monorepo root placeholder: ${name}`);
}

/**
 * The renderer's ExecStart command for one per-unit pointer; `null` keeps the
 * committed Python ExecStart. `home` is `Path(home)` or `Path.home()`.
 */
export function unitCommand(unit: string, runtime: unknown, home: string): string | null {
  if (!hasOwn(UNIT_COMMANDS, unit)) throw new ValueError('unknown runtime unit');
  if (runtime === 'python') return null;
  if (typeof runtime !== 'string' || !/^node:[0-9a-f]{40}$/.test(runtime))
    throw new ValueError('runtime must be python or node:<full SHA>');
  const base = posixStr(home);
  const joined = base === '.' ? '.local/opt' : `${base === '/' ? '' : base}/.local/opt`;
  const artifact = hostPath(`${joined}/crq-${runtime.slice(5)}`);
  return `/usr/bin/env node ${artifact}/dist/queue-runner/crq.js ${UNIT_COMMANDS[unit]}`;
}

const LINE_BREAKS: ReadonlySet<string> = new Set([
  '\n',
  '\r',
  '\v',
  '\f',
  '\u001c',
  '\u001d',
  '\u001e',
  '\u0085',
  '\u2028',
  '\u2029',
]);

/** Python `str.splitlines(keepends=True)`: every Unicode line boundary. */
export function splitLinesKeepEnds(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!LINE_BREAKS.has(text[i] as string)) continue;
    if (text[i] === '\r' && text[i + 1] === '\n') i += 1;
    out.push(text.slice(start, i + 1));
    start = i + 1;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/**
 * Pure byte render. Establishes no source binding: the caller supplies the
 * template text.
 */
export function renderServiceText(
  templateName: string,
  templateText: unknown,
  runnerRoot: string,
  command: string | null = null,
): string {
  if (typeof templateText !== 'string') throw new ValueError('template text must be a string');
  let text = templateText.split('@CRQ_ROOT@').join(runnerRoot);
  if (text.includes('@CRQ_ROOT@')) throw new ValueError('unexpanded runner root');
  if (command !== null) {
    const lines = splitLinesKeepEnds(text);
    const matches = lines.flatMap((line, i) => (line.startsWith('ExecStart=') ? [i] : []));
    if (matches.length !== 1)
      throw new ValueError(`unit must have exactly one ExecStart: ${templateName}`);
    lines[matches[0] as number] = `ExecStart=${command}\n`;
    text = lines.join('');
  }
  return text;
}
