/**
 * Minimal XML property-list codec matching Python `plistlib.loads`/`dumps` (default
 * `sort_keys=True`, XML format) for the types launchd job files use: string, integer,
 * boolean, array, dict. Real, data, date, CDATA and entity declarations are refused
 * rather than guessed. Not wired into any runtime path.
 */
import { ValueError } from './hostOverlay.js';

export type PlistValue = string | bigint | boolean | readonly PlistValue[] | PlistDict;
export type PlistDict = ReadonlyMap<string, PlistValue>;

const HEADER =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
  '<plist version="1.0">\n';

function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_m, name: string) => {
    if (name[0] !== '#')
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name] as string;
    const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    if (!(code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0x10ffff)))
      throw new ValueError('invalid character reference in plist');
    return String.fromCodePoint(code);
  });
}

const codePointCmp = (a: string, b: string): number => {
  const x = Array.from(a, (c) => c.codePointAt(0) as number);
  const y = Array.from(b, (c) => c.codePointAt(0) as number);
  for (let i = 0; i < Math.min(x.length, y.length); i++)
    if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  return x.length - y.length;
};

export function parsePlist(source: string): PlistValue {
  let pos = 0;
  const fail = (msg: string): never => {
    throw new ValueError(`unsupported or malformed plist: ${msg}`);
  };
  const skipMisc = (): void => {
    for (;;) {
      const rest = source.slice(pos);
      const ws = /^\s+/.exec(rest);
      if (ws) pos += ws[0].length;
      else if (rest.startsWith('<?')) {
        const end = source.indexOf('?>', pos);
        if (end < 0) fail('unterminated processing instruction');
        pos = end + 2;
      } else if (rest.startsWith('<!--')) {
        const end = source.indexOf('-->', pos);
        if (end < 0) fail('unterminated comment');
        pos = end + 3;
      } else if (rest.startsWith('<!DOCTYPE')) {
        const m = /^<!DOCTYPE[^[>]*>/.exec(rest);
        if (!m) fail('DOCTYPE with an internal subset');
        pos += (m as RegExpExecArray)[0].length;
      } else return;
    }
  };
  const readText = (): string => {
    const end = source.indexOf('<', pos);
    if (end < 0) fail('unterminated element');
    const text = source.slice(pos, end);
    pos = end;
    return unescapeXml(text);
  };
  const expectClose = (tag: string): void => {
    if (!source.startsWith(`</${tag}>`, pos)) fail(`expected </${tag}>`);
    pos += tag.length + 3;
  };
  const value = (): PlistValue => {
    skipMisc();
    const m = /^<([A-Za-z]+)(\/?)>/.exec(source.slice(pos));
    if (!m) return fail('expected an element');
    const tag = (m as RegExpExecArray)[1] as string;
    const empty = (m as RegExpExecArray)[2] === '/';
    pos += (m as RegExpExecArray)[0].length;
    switch (tag) {
      case 'true':
      case 'false':
        if (!empty) expectClose(tag);
        return tag === 'true';
      case 'string': {
        if (empty) return '';
        const text = readText();
        expectClose('string');
        return text;
      }
      case 'integer': {
        if (empty) return fail('empty integer');
        const text = readText().trim();
        expectClose('integer');
        if (!/^[+-]?[0-9]+$/.test(text) && !/^0[xX][0-9A-Fa-f]+$/.test(text)) fail('bad integer');
        return BigInt(text.replace(/^\+/, ''));
      }
      case 'array': {
        const items: PlistValue[] = [];
        if (empty) return items;
        skipMisc();
        while (!source.startsWith('</array>', pos)) {
          items.push(value());
          skipMisc();
        }
        pos += 8;
        return items;
      }
      case 'dict': {
        const dict = new Map<string, PlistValue>();
        if (empty) return dict;
        skipMisc();
        while (!source.startsWith('</dict>', pos)) {
          if (!source.startsWith('<key>', pos)) fail('expected <key>');
          pos += 5;
          const key = readText();
          expectClose('key');
          dict.set(key, value());
          skipMisc();
        }
        pos += 7;
        return dict;
      }
      default:
        return fail(`element <${tag}>`);
    }
  };
  skipMisc();
  const open = /^<plist(\s[^>]*)?>/.exec(source.slice(pos));
  if (!open) fail('missing <plist>');
  pos += (open as RegExpExecArray)[0].length;
  const root = value();
  skipMisc();
  expectClose('plist');
  skipMisc();
  if (pos !== source.length) fail('trailing content');
  return root;
}

function escapeXml(text: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))
    throw new ValueError('strings can not contain control characters; encode as bytes instead');
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function dumpPlist(root: PlistValue): string {
  const lines: string[] = [];
  const emit = (v: PlistValue, depth: number): void => {
    const pad = '\t'.repeat(depth);
    if (typeof v === 'string') lines.push(`${pad}<string>${escapeXml(v)}</string>`);
    else if (typeof v === 'bigint') {
      if (v >= 1n << 64n || v < -(1n << 63n)) throw new ValueError('integer out of range');
      lines.push(`${pad}<integer>${v}</integer>`);
    } else if (typeof v === 'boolean') lines.push(`${pad}<${v}/>`);
    else if (Array.isArray(v)) {
      if (v.length === 0) lines.push(`${pad}<array/>`);
      else {
        lines.push(`${pad}<array>`);
        for (const item of v) emit(item as PlistValue, depth + 1);
        lines.push(`${pad}</array>`);
      }
    } else {
      const dict = v as PlistDict;
      if (dict.size === 0) lines.push(`${pad}<dict/>`);
      else {
        lines.push(`${pad}<dict>`);
        for (const key of [...dict.keys()].sort(codePointCmp)) {
          lines.push(`${pad}\t<key>${escapeXml(key)}</key>`);
          emit(dict.get(key) as PlistValue, depth + 1);
        }
        lines.push(`${pad}</dict>`);
      }
    }
  };
  emit(root, 0);
  return `${HEADER}${lines.join('\n')}\n</plist>\n`;
}
