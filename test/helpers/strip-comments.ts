/**
 * Remove comments from TypeScript source with a SINGLE-PASS scanner that
 * understands string and template literals. Why hand-rolled: regex passes
 * get the order wrong in one of two directions — block-first stripping lets
 * a `/*` inside a `//` line comment open a phantom block that swallows real
 * import statements, while string-erasing stripping DELETES the quoted
 * module specifiers the import scan needs to match. This walker keeps
 * literal contents verbatim (specifiers stay matchable), honors escapes,
 * and drops both comment forms.
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let mode: 'code' | 'single' | 'double' | 'template' = 'code';
  while (i < source.length) {
    const c = source[i] as string;
    const next = i + 1 < source.length ? (source[i + 1] as string) : undefined;
    if (mode === 'code') {
      if (c === "'" || c === '"' || c === '`') {
        mode = c === "'" ? 'single' : c === '"' ? 'double' : 'template';
        out += c;
        i += 1;
        continue;
      }
      if (c === '/' && next === '/') {
        while (i < source.length && source[i] !== '\n') i += 1;
        continue;
      }
      if (c === '/' && next === '*') {
        i += 2;
        while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
        i += 2;
        out += ' ';
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    // Inside a literal: honor escapes, copy everything verbatim.
    if (c === '\\') {
      out += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (
      (mode === 'single' && c === "'") ||
      (mode === 'double' && c === '"') ||
      (mode === 'template' && c === '`')
    ) {
      mode = 'code';
    }
    out += c;
    i += 1;
  }
  return out;
}
