// Python skip/xfail marker recognition for the hack detector (#774). The
// shipped skip/only default treats added pytest and unittest skip and
// expected-failure markers in a Python test file exactly like the JS/TS
// skip/focus markers: same `new-skip-only` finding kind.
//
// Pure text analysis over the lines a diff section shows in NEW-file order
// (context and added lines; removed lines belong to the old file and never
// feed this state). Per line it:
//   - blanks string-literal contents and `#` comments, carrying
//     triple-quoted string state across lines, so a marker named in a
//     docstring, string or comment does not flag;
//   - records import aliases (`import pytest as pt`, `from pytest import
//     mark`, `from unittest.case import skip as s`, …) from every visible
//     line;
//   - tracks the enclosing `def` stack by indentation, seeded by the hunk
//     header's function context, to decide whether a line is in a test body.
//
// FAIL CLOSED ON UNKNOWN STRING STATE: a hunk that does not start at line 1
// may start inside a multi-line string, so its first triple quote could open
// OR close one. The scanner keeps every live hypothesis (outside a string,
// inside `"""`, inside `'''`) and an added line flags when ANY hypothesis
// reads a marker in it. A marker is therefore never hidden by a guessed
// string state; the accepted cost is that prose in a docstring of such a
// hunk can flag.
//
// Added lines are only CANDIDATES until the section ends, so an alias
// imported anywhere in the visible section resolves a marker in an earlier
// hunk. Imports usually sit outside the visible hunks, so these syntactic
// forms flag with no visible import:
//   - `mark.skip`/`mark.skipif`/`mark.xfail` anywhere, after any receiver
//     (`pytest.mark.skip`, `pt.mark.xfail`, `pytestmark = mark.skip`,
//     `marks=mark.xfail`);
//   - decorators `@skip`, `@skipIf`, `@skipUnless`, `@expectedFailure`,
//     bare or through any attribute path (`@ut.skip`, `@unittest.case.skip`);
//   - `raise SkipTest` through any attribute path, and
//     `raise <x>.skip.Exception`;
//   - `<x>.skipTest(...)`, any `xfail(...)` call, `pytest.skip(...)`, and a
//     `<x>.skip(...)` statement whose first argument is a string literal or
//     `reason=`/`msg=`/`allow_module_level=`.
// What still needs the import visible: a bare `skip(...)` call (imported
// from pytest) and an aliased `skip(...)`/`importorskip(...)` call whose
// alias is not one of the forms above.
//
// `importorskip` flags only inside a test function body — the visible
// enclosing `def` chain contains a `test*` function. At module level, in a
// fixture or helper, or with no visible enclosing function it is a
// dependency guard, not a skipped test, and does not flag. Every other
// marker flags wherever it is added in the file, including module-level
// `pytestmark` and `pytest.skip(..., allow_module_level=True)`.

/** Triple-quoted string state: outside (`null`) or inside `"""` / `'''`. */
type StringState = null | '"""' | "'''";

/** One added line awaiting evaluation at the end of its section. */
interface Candidate {
  line: number;
  content: string;
  /** The line's code under every live string-state hypothesis (distinct). */
  codes: string[];
  inTestBody: boolean;
}

/** A resolved Python marker on an added line. */
export interface PythonSkipMarker {
  line: number;
  content: string;
  /** Canonical marker name, e.g. `pytest.mark.skip` or `self.skipTest`. */
  marker: string;
}

const PYTEST_IMPORTABLE = new Set(['mark', 'skip', 'xfail', 'importorskip']);
const UNITTEST_IMPORTABLE = new Set([
  'skip',
  'skipIf',
  'skipUnless',
  'expectedFailure',
  'SkipTest',
]);
const UNITTEST_MODULES = new Set(['unittest', 'unittest.case']);

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
const DOTTED = `${IDENT}(?:\\.${IDENT})*`;
/** Regex prefix: an identifier start, not an attribute access or a longer name. */
const PRE = '(?<![A-Za-z0-9_.])';
/** Regex suffix: the identifier ends here. */
const POST = '(?![A-Za-z0-9_])';
/** Zero or more `name.` receivers, never a `mark.` (that is pytest's path). */
const RECEIVERS = `(?:(?!mark${POST})${IDENT}\\s*\\.\\s*)*`;

const DEF_RE = new RegExp(`^(\\s*)(?:async\\s+)?def\\s+(${IDENT})`);
const CLASS_RE = new RegExp(`^(\\s*)class\\s+${IDENT}`);
const IMPORT_RE = /^\s*import\s+(.+)$/;
const FROM_IMPORT_RE = new RegExp(`^\\s*from\\s+(${DOTTED})\\s+import\\s+\\(?([^)]*)\\)?\\s*$`);
const HUNK_START_RE = /^@@ -\d+(?:,\d+)? \+(\d+)/;
const ALL_STATES: readonly StringState[] = [null, '"""', "'''"];

/** Net open brackets on a lexed line (string contents and comments blanked). Signed. */
function bracketBalance(code: string): number {
  let depth = 0;
  for (const ch of code) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
  }
  return depth;
}

/** Shipped syntactic forms that need no visible import (see the module comment). */
const FALLBACKS: readonly { re: RegExp; marker: (m: RegExpExecArray) => string }[] = [
  {
    re: new RegExp(`(?<![A-Za-z0-9_])mark\\s*\\.\\s*(skipif|skip|xfail)${POST}`, 'g'),
    marker: (m) => `pytest.mark.${m[1]!}`,
  },
  {
    re: new RegExp(`@\\s*${RECEIVERS}(skipIf|skipUnless|skip|expectedFailure)${POST}`, 'g'),
    marker: (m) => `unittest.${m[1]!}`,
  },
  {
    re: new RegExp(`\\braise\\s+${RECEIVERS}SkipTest${POST}`, 'g'),
    marker: () => 'unittest.SkipTest',
  },
  {
    re: new RegExp(`\\braise\\s+${RECEIVERS}skip\\s*\\.\\s*Exception${POST}`, 'g'),
    marker: () => 'pytest.skip',
  },
  { re: /\.\s*skipTest\s*\(/g, marker: () => 'self.skipTest' },
  { re: /(?<![A-Za-z0-9_])xfail\s*\(/g, marker: () => 'pytest.xfail' },
  {
    re: new RegExp(
      `^\\s*(?:${IDENT}\\s*\\.\\s*)+skip\\s*\\(\\s*(?:[rRbBuUfF]{0,2}["']|(?:reason|msg|allow_module_level)\\s*=)`,
      'g',
    ),
    marker: () => 'pytest.skip',
  },
];

/** Python test-file section scanner; one instance per diff section. */
export class PythonSectionScanner {
  private readonly pytestNames = new Set(['pytest']);
  private readonly unittestNames = new Set(['unittest']);
  private readonly markNames = new Set<string>();
  /** local name → canonical `pytest.X` / `unittest.X` imported function. */
  private readonly importedFunctions = new Map<string, string>();
  private readonly candidates: Candidate[] = [];
  /** Live string-state hypotheses; a section starts outside any string. */
  private states: StringState[] = [null];
  /** Module of an open parenthesized `from M import (` spanning lines. */
  private pendingFrom: string | null = null;
  private defs: { name: string; indent: number }[] = [];
  /** Open brackets of a multi-line `def`/`class` signature still awaiting their closer. */
  private signatureParens = 0;

  /**
   * A hunk header. Unless the hunk starts at line 1, the string state is
   * unknown, so every hypothesis goes live; the def stack is seeded from
   * the header's function context.
   */
  hunk(header: string): void {
    const start = Number(HUNK_START_RE.exec(header)?.[1] ?? '0');
    this.states = start <= 1 ? [null] : [...ALL_STATES];
    this.pendingFrom = null;
    this.defs = [];
    // A hunk is scanned independently: its opening line is not guaranteed to
    // close its brackets inside this hunk, so the signature state starts fresh.
    this.signatureParens = 0;
    const context = /^@@ [^@]* @@ ?(.*)$/.exec(header)?.[1] ?? '';
    const def = DEF_RE.exec(context);
    if (def) {
      this.defs.push({ name: def[2]!, indent: def[1]!.length });
    }
  }

  /** A context or added line, in new-file order. */
  line(content: string, added: boolean, lineNumber: number): void {
    const lexed = this.states.map((state) => ({ start: state, ...lex(content, state) }));
    this.states = [...new Set(lexed.map((l) => l.end))];
    // Def and import tracking reads the line as code only under a hypothesis
    // in which the line starts outside a string.
    const asCode = lexed.find((l) => l.start === null)?.code;
    if (asCode !== undefined && asCode.trim() !== '') {
      this.trackDefs(asCode);
      this.trackImports(asCode);
    } else {
      // The line starts inside a multi-line string, so it is never code for
      // def tracking — but the text after the closing delimiter can still
      // close an open signature (`"""):`). Count only that suffix's brackets,
      // or the signature depth stays open and suppresses later defs.
      const closed = lexed.find((l) => l.start !== null && l.end === null)?.code;
      if (closed !== undefined) this.trackSignatureSuffix(closed);
    }
    if (!added) return;
    const codes = [...new Set(lexed.map((l) => l.code))].filter((code) => code.trim() !== '');
    if (codes.length > 0) {
      this.candidates.push({
        line: lineNumber,
        content,
        codes,
        inTestBody: this.defs.some((d) => /^test/.test(d.name)),
      });
    }
  }

  /** Resolve every candidate against the section's final alias set. */
  markers(): PythonSkipMarker[] {
    const rules = this.aliasRules();
    const found: PythonSkipMarker[] = [];
    for (const candidate of this.candidates) {
      for (const code of candidate.codes) {
        const marker = markerOf(code, candidate.inTestBody, rules);
        if (marker !== null) {
          found.push({ line: candidate.line, content: candidate.content, marker });
          break;
        }
      }
    }
    return found;
  }

  /** Rules that depend on the visible imports, plus the shipped fallbacks. */
  private aliasRules(): Rule[] {
    const pytest = alternation(this.pytestNames);
    const unittest = alternation(this.unittestNames);
    const rules: Rule[] = FALLBACKS.map((f) => ({ re: f.re, marker: f.marker }));
    rules.push({
      re: new RegExp(`${PRE}(?:${pytest})\\s*\\.\\s*(skip|xfail)\\s*\\(`, 'g'),
      marker: (m) => `pytest.${m[1]!}`,
    });
    rules.push({
      re: new RegExp(`(?<![A-Za-z0-9_])importorskip\\s*\\(`, 'g'),
      marker: () => 'pytest.importorskip',
      testBodyOnly: true,
    });
    rules.push({
      re: new RegExp(
        `${PRE}(?:${unittest})(?:\\s*\\.\\s*case)?\\s*\\.\\s*(skipIf|skipUnless|skip|expectedFailure)${POST}`,
        'g',
      ),
      marker: (m) => `unittest.${m[1]!}`,
    });
    if (this.markNames.size > 0) {
      rules.push({
        re: new RegExp(
          `${PRE}(?:${alternation(this.markNames)})\\s*\\.\\s*(skipif|skip|xfail)${POST}`,
          'g',
        ),
        marker: (m) => `pytest.mark.${m[1]!}`,
      });
    }
    for (const [local, canonical] of this.importedFunctions) {
      const name = escapeRe(local);
      if (canonical === 'unittest.SkipTest') {
        rules.push({ re: new RegExp(`\\braise\\s+${name}${POST}`, 'g'), marker: () => canonical });
      } else if (canonical.startsWith('unittest.')) {
        rules.push({
          re: new RegExp(`@\\s*${name}${POST}|${PRE}${name}\\s*\\(`, 'g'),
          marker: () => canonical,
        });
      } else {
        rules.push({
          re: new RegExp(`${PRE}${name}\\s*\\(`, 'g'),
          marker: () => canonical,
          testBodyOnly: canonical === 'pytest.importorskip',
        });
      }
    }
    return rules;
  }

  private trackDefs(code: string): void {
    // A `def`/`class` signature can span lines on any indentation (an
    // unindented parameter, `):`, `) -> None:`): every line until its
    // brackets balance continues the def, so its indent must not pop the
    // def stack. The signature opens only on a `def`/`class` line, so a
    // hunk that starts inside one still falls back to plain indentation.
    if (this.signatureParens > 0) {
      this.signatureParens = Math.max(0, this.signatureParens + bracketBalance(code));
      return;
    }
    // A hunk can START inside a signature whose opening line is not visible,
    // so the bracket depth is unknown here: a line that begins with a closing
    // bracket continues that signature and must not pop the def stack.
    if (/^\s*[)\]}]/.test(code)) return;
    const indent = /^\s*/.exec(code)![0].length;
    while (this.defs.length > 0 && this.defs.at(-1)!.indent >= indent) {
      this.defs.pop();
    }
    const def = DEF_RE.exec(code);
    if (def) {
      this.defs.push({ name: def[2]!, indent });
    } else if (CLASS_RE.test(code)) {
      // A class body is not a function body: it hides any enclosing test def.
      this.defs.push({ name: '<class>', indent });
    } else {
      return;
    }
    this.signatureParens = Math.max(0, bracketBalance(code));
  }

  /** Close an open signature from a line whose prefix is a multi-line string. */
  private trackSignatureSuffix(code: string): void {
    if (this.signatureParens === 0) return;
    this.signatureParens = Math.max(0, this.signatureParens + bracketBalance(code));
  }

  private trackImports(code: string): void {
    if (this.pendingFrom !== null) {
      const closed = code.includes(')');
      this.bindFrom(this.pendingFrom, code.replace(/\).*$/, ''));
      if (closed) this.pendingFrom = null;
      return;
    }
    const from = FROM_IMPORT_RE.exec(code);
    if (from) {
      if (code.includes('(') && !code.includes(')')) this.pendingFrom = from[1]!;
      this.bindFrom(from[1]!, from[2]!);
      return;
    }
    const plain = IMPORT_RE.exec(code);
    if (plain) {
      for (const [name, local] of importedNames(plain[1]!)) {
        if (local.includes('.')) continue; // `import a.b` binds `a`, a default name
        if (name === 'pytest') this.pytestNames.add(local);
        else if (UNITTEST_MODULES.has(name)) this.unittestNames.add(local);
      }
    }
  }

  private bindFrom(module: string, list: string): void {
    for (const [name, local] of importedNames(list)) {
      if (module === 'pytest' && PYTEST_IMPORTABLE.has(name)) {
        if (name === 'mark') this.markNames.add(local);
        else this.importedFunctions.set(local, `pytest.${name}`);
      } else if (UNITTEST_MODULES.has(module) && UNITTEST_IMPORTABLE.has(name)) {
        this.importedFunctions.set(local, `unittest.${name}`);
      }
    }
  }
}

/** One marker rule: a global regex and the canonical name a match reports. */
interface Rule {
  re: RegExp;
  marker: (m: RegExpExecArray) => string;
  /** Only inside a visible test function body (`importorskip`). */
  testBodyOnly?: boolean;
}

/** The earliest marker on one line of code, or null. */
function markerOf(code: string, inTestBody: boolean, rules: readonly Rule[]): string | null {
  let best: { index: number; marker: string } | null = null;
  for (const rule of rules) {
    if (rule.testBodyOnly === true && !inTestBody) continue;
    // matchAll clones the regex, so no lastIndex state leaks between lines.
    for (const m of code.matchAll(rule.re)) {
      if (best === null || m.index < best.index) best = { index: m.index, marker: rule.marker(m) };
      break;
    }
  }
  return best?.marker ?? null;
}

/**
 * One line lexed under a starting string state: string contents (all but
 * each literal's opening quote character) and `#` comments become spaces.
 * Returns the code and the triple-quote state at the end of the line.
 */
function lex(content: string, start: StringState): { code: string; end: StringState } {
  let state = start;
  let out = '';
  let i = 0;
  while (i < content.length) {
    if (state !== null) {
      const close = findClose(content, i, state);
      if (close === -1) return { code: out, end: state };
      out += ' '.repeat(close + 3 - i);
      i = close + 3;
      state = null;
      continue;
    }
    const ch = content[i]!;
    if (ch === '#') return { code: out, end: null };
    if (ch === '"' || ch === "'") {
      const triple = ch === '"' ? '"""' : "'''";
      if (content.startsWith(triple, i)) {
        state = triple;
        out += `${ch}  `;
        i += 3;
        continue;
      }
      const close = findClose(content, i + 1, ch);
      const end = close === -1 ? content.length : close + 1;
      out += ch + ' '.repeat(end - i - 1);
      i = end;
      continue;
    }
    out += ch;
    i++;
  }
  return { code: out, end: state };
}

function alternation(names: ReadonlySet<string>): string {
  return [...names].map(escapeRe).join('|');
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `a, b.c as d` → [[a, a], [b.c, d]]; unparseable parts are dropped. */
function importedNames(list: string): [string, string][] {
  const pairs: [string, string][] = [];
  for (const part of list.split(',')) {
    const m = new RegExp(`^\\s*(${DOTTED})(?:\\s+as\\s+(${IDENT}))?\\s*$`).exec(part);
    if (m) pairs.push([m[1]!, m[2] ?? m[1]!]);
  }
  return pairs;
}

/** Index of the next unescaped `quote` at or after `from`, or -1. */
function findClose(content: string, from: number, quote: string): number {
  for (let i = from; i < content.length; i++) {
    if (content[i] === '\\') {
      i++;
      continue;
    }
    if (content.startsWith(quote, i)) return i;
  }
  return -1;
}
