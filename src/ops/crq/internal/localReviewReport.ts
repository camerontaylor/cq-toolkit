import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  type JsonValue,
} from '../../../policy/crq/jsonValue.js';
import { pythonFloatRepr, pythonJsonText } from '../../../policy/crq/pythonJson.js';
import { pyTruthy } from '../../../policy/crq/queueDoc.js';
import { pythonStrip } from '../../../policy/crq/repairBinding.js';

function reprString(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === quote || char === '\\') out += `\\${char}`;
    else if (code === 9) out += '\\t';
    else if (code === 10) out += '\\n';
    else if (code === 13) out += '\\r';
    else if (code < 32 || code === 127) out += `\\x${code.toString(16).padStart(2, '0')}`;
    else if (code === 32 || !/[\p{C}\p{Z}]/u.test(char)) out += char;
    else if (code <= 255) out += `\\x${code.toString(16).padStart(2, '0')}`;
    else if (code <= 65535) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += `\\U${code.toString(16).padStart(8, '0')}`;
  }
  return quote + out + quote;
}
function pyString(value: JsonValue): string {
  if (value === null) return 'None';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (value instanceof JsonNumber) {
    if (value.integer !== null) return value.integer.toString();
    const n = value.float!;
    return Number.isNaN(n)
      ? 'nan'
      : n === Infinity
        ? 'inf'
        : n === -Infinity
          ? '-inf'
          : pythonFloatRepr(n);
  }
  const repr = (v: JsonValue): string => (typeof v === 'string' ? reprString(v) : pyString(v));
  if (Array.isArray(value)) return `[${value.map(repr).join(', ')}]`;
  return `{${value.entries.map(([k, v]) => `${reprString(k)}: ${repr(v)}`).join(', ')}}`;
}
function required(value: JsonObject, key: string): JsonValue {
  const result = value.get(key);
  if (result === undefined) throw new Error(`missing ${key}`);
  return result;
}
function lines(text: string): string[] {
  const separators = new Set([10, 11, 12, 13, 28, 29, 30, 133, 0x2028, 0x2029]);
  const output: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!separators.has(text.charCodeAt(i))) continue;
    output.push(text.slice(start, i));
    if (text.charCodeAt(i) === 13 && text.charCodeAt(i + 1) === 10) i++;
    start = i + 1;
  }
  output.push(text.slice(start));
  return output;
}
/** Python crq.findings_md. The original NDJSON bytes are replacement-decoded, never hashed here. */
export function renderLocalReviewFindings(
  bytes: Uint8Array | null,
  meta: JsonObject,
  cls: JsonObject,
): string {
  const jsonCounts = pythonJsonText(required(cls, 'severity_counts'), {
    asciiOnly: true,
    sortKeys: false,
    keyOrder: 'insertion',
    indent: null,
    spacedSeparators: true,
  });
  const out = [
    `# CodeRabbit CLI findings — ${pyString(required(meta, 'item_id'))} (${pyString(required(meta, 'label'))})`,
    '',
    `- run: \`${pyString(required(meta, 'run_id'))}\`  outcome: **${pyString(required(cls, 'outcome'))}**  counted: ${pyString(required(cls, 'counted'))}`,
    `- base \`${pyString(required(meta, 'base'))}\` → head \`${pyString(required(meta, 'head'))}\` (clean tree)`,
    `- severity counts: ${jsonCounts}`,
    '',
  ];
  let n = 0;
  for (const line of lines(bytes === null ? '' : Buffer.from(bytes).toString('utf8'))) {
    let event: JsonValue;
    try {
      event = parseJsonValue(line, {
        parseConstant: (raw) =>
          JsonNumber.float(raw === 'NaN' ? NaN : raw === 'Infinity' ? Infinity : -Infinity),
      });
    } catch {
      continue;
    }
    if (!(event instanceof JsonObject) || event.get('type') !== 'finding') continue;
    n++;
    const codegen = event.get('codegenInstructions');
    const comment = event.get('comment');
    const chosen = pyTruthy(codegen) ? codegen : pyTruthy(comment) ? comment : '';
    const body = [...pythonStrip(pyString(chosen ?? null))].slice(0, 4000).join('');
    out.push(
      `## F${n} [${pyString(event.get('severity') ?? null)}] ${pyString(event.get('fileName') ?? null)}`,
      '',
      '```text',
      body,
      '```',
      '',
    );
  }
  return out.join('\n') + '\n';
}
