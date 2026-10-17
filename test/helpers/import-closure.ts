/**
 * The module-loading edges of one TypeScript source, FAIL CLOSED: the scan
 * behind test/ops/gates/protectedPaths.test.ts, which holds every file a
 * trusted job executes to policy/protected-paths.json (residual R1,
 * docs/protected-scope.md).
 *
 * Method: Node's own type stripper erases the type-only imports (they never
 * execute), then a single-pass lexer drops comments and replaces every
 * string literal with a numbered placeholder, so prose and string contents
 * cannot look like code. Every `import`, `from '…'`, `require` and
 * loader-hook token left in the code must belong to a recognised form with
 * a LITERAL specifier; anything else is a problem the caller fails on,
 * never a silently skipped edge. That over-approximates (a value import
 * that tsc would elide is still walked), which errs toward protection.
 */
import { stripTypeScriptTypes } from 'node:module';

export interface ModuleScan {
  /** Literal specifiers of static, re-export, side-effect and dynamic imports. */
  specifiers: string[];
  /** Load forms the scan cannot resolve to a literal specifier. */
  problems: string[];
}

/** Keywords after which `/` starts a regex literal rather than a division. */
const REGEX_AFTER_WORD = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/** Code with comments dropped and each string literal replaced by `'@<n>'`. */
function lex(js: string): { code: string; strings: string[] } {
  const strings: string[] = [];
  let code = '';
  let i = 0;
  // One entry per open template: the `${` brace depth inside it.
  const templates: number[] = [];
  const fail = (what: string): never => {
    throw new Error(`import scan: ${what} at offset ${i}`);
  };
  const regexAllowed = (): boolean => {
    const before = code.trimEnd();
    if (before === '') return true;
    const last = before[before.length - 1]!;
    if ('(,=:[!&|?{};+-*%<>~^'.includes(last)) return true;
    const word = /([A-Za-z_$][\w$]*)$/.exec(before)?.[1];
    return word !== undefined && REGEX_AFTER_WORD.has(word);
  };
  /** Scan template text from `i` (just past a backtick or `}`) to its end or the next `${`. */
  const templateText = (): void => {
    let text = '';
    while (true) {
      if (i >= js.length) fail('unterminated template');
      const c = js[i]!;
      if (c === '\\') {
        text += js.slice(i, i + 2);
        i += 2;
      } else if (c === '`') {
        i += 1;
        strings.push(text);
        code += `'@${strings.length - 1}'\``;
        templates.pop();
        return;
      } else if (c === '$' && js[i + 1] === '{') {
        i += 2;
        strings.push(text);
        code += `'@${strings.length - 1}'\${`;
        return;
      } else {
        text += c;
        i += 1;
      }
    }
  };
  while (i < js.length) {
    const c = js[i]!;
    const next = js[i + 1];
    if (c === '/' && next === '/') {
      while (i < js.length && js[i] !== '\n') i += 1;
    } else if (c === '/' && next === '*') {
      const end = js.indexOf('*/', i + 2);
      if (end < 0) fail('unterminated block comment');
      i = end + 2;
      code += ' ';
    } else if (c === "'" || c === '"') {
      let text = '';
      i += 1;
      while (js[i] !== c) {
        if (i >= js.length || js[i] === '\n') fail('unterminated string');
        if (js[i] === '\\') {
          text += js.slice(i, i + 2);
          i += 2;
        } else {
          text += js[i];
          i += 1;
        }
      }
      i += 1;
      strings.push(text);
      code += `'@${strings.length - 1}'`;
    } else if (c === '`') {
      i += 1;
      code += '`';
      templates.push(0);
      templateText();
    } else if (c === '{' && templates.length > 0) {
      templates[templates.length - 1]! += 1;
      code += c;
      i += 1;
    } else if (c === '}' && templates.length > 0 && templates[templates.length - 1] === 0) {
      code += '}';
      i += 1;
      templateText();
    } else if (c === '}' && templates.length > 0) {
      templates[templates.length - 1]! -= 1;
      code += c;
      i += 1;
    } else if (c === '/' && regexAllowed()) {
      let inClass = false;
      i += 1;
      while (inClass || js[i] !== '/') {
        if (i >= js.length || js[i] === '\n') fail('unterminated regex literal');
        if (js[i] === '\\') i += 1;
        else if (js[i] === '[') inClass = true;
        else if (js[i] === ']') inClass = false;
        i += 1;
      }
      i += 1;
      while (i < js.length && /[a-z]/.test(js[i]!)) i += 1;
      code += '/@re/';
    } else {
      code += c;
      i += 1;
    }
  }
  if (templates.length > 0) fail('unterminated template expression');
  return { code, strings };
}

/** Scan one TypeScript source for the modules it can load. */
export function scanModuleLoads(source: string): ModuleScan {
  const js = stripTypeScriptTypes(source, { mode: 'strip' });
  const { code, strings } = lex(js);
  const specifiers: string[] = [];
  const claimed = new Set<number>();
  const LIT = String.raw`'@(\d+)'`;
  const forms = [
    // import … from / export … from: the clause holds no string, `;` or template.
    new RegExp(String.raw`\b(?:import|export)\b[^;'\`]*?\bfrom\s*${LIT}`, 'g'),
    // Side-effect import.
    new RegExp(String.raw`\bimport\s*${LIT}`, 'g'),
    // Dynamic import of a literal (no template, no expression, no options).
    new RegExp(String.raw`\bimport\s*\(\s*${LIT}\s*\)`, 'g'),
  ];
  for (const re of forms) {
    for (const m of code.matchAll(re)) {
      specifiers.push(strings[Number(m[1])]!);
      for (const token of m[0].matchAll(/\b(?:import|from)\b/g)) claimed.add(m.index + token.index);
    }
  }
  const problems: string[] = [];
  const at = (index: number): string =>
    code
      .slice(Math.max(0, index - 20), index + 40)
      .replace(/\s+/g, ' ')
      .trim();
  for (const m of code.matchAll(/\bimport\b(?!\s*\.\s*meta\b)/g)) {
    if (!claimed.has(m.index)) problems.push(`unrecognised import form: ${at(m.index)}`);
  }
  for (const m of code.matchAll(/\bfrom\s*'@/g)) {
    if (!claimed.has(m.index)) problems.push(`unrecognised from-clause: ${at(m.index)}`);
  }
  for (const m of code.matchAll(/\b(?:require|createRequire|registerHooks|Worker)\b/g)) {
    problems.push(`runtime module loading: ${at(m.index)}`);
  }
  return { specifiers, problems };
}
