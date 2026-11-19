/**
 * Decode a path from a git patch header (`+++ `/`--- ` body).
 *
 * Git C-quotes names with control bytes, `"`, `\` or (by default) non-ASCII
 * bytes: `"b/src/a\tb.ts"`, `"b/secr\303\251t.env"`. Matching path rules against
 * the quoted form skips them, so decode first, then strip the `a/`/`b/` prefix.
 * Returns `null` when a quoted name cannot be decoded safely.
 */
const SIMPLE_ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
};

export function decodeGitHeaderPath(candidate: string): string | null {
  let name = candidate.replace(/\t.*$/, '');
  if (name.startsWith('"')) {
    if (name.length < 2 || !name.endsWith('"')) return null;
    const body = name.slice(1, -1);
    const bytes: number[] = [];
    for (let i = 0; i < body.length; i += 1) {
      const ch = body[i]!;
      if (ch === '"') return null;
      if (ch !== '\\') {
        bytes.push(...Buffer.from(ch, 'utf8'));
        continue;
      }
      const next = body[i + 1];
      if (next === undefined) return null;
      if (/[0-3]/.test(next) && /^[0-7]{3}/.test(body.slice(i + 1, i + 4))) {
        bytes.push(Number.parseInt(body.slice(i + 1, i + 4), 8));
        i += 3;
        continue;
      }
      const simple = SIMPLE_ESCAPES[next];
      if (simple === undefined) return null;
      bytes.push(simple);
      i += 1;
    }
    name = Buffer.from(bytes).toString('utf8');
  }
  return name.startsWith('a/') || name.startsWith('b/') ? name.slice(2) : name;
}
