// Python skip/xfail marker recognition for the hack detector (#774). The
// shipped skip/only default treats added pytest and unittest skip and
// expected-failure markers in a Python test file exactly like the JS/TS
// skip/focus markers: same `new-skip-only` finding kind.
//
// Pure text analysis over the lines a diff section shows in NEW-file order
// (context and added lines; removed lines belong to the old file and never
// feed this state). Per line it:
//   - blanks string literals and `#` comments, carrying triple-quoted string
//     state across lines (reset at every hunk header, where the state is
//     unknowable), so a marker named in a docstring, string or comment never
//     flags;
//   - records import aliases (`import pytest as pt`, `from pytest import
//     mark`, `from unittest import skip as s`, …) from every visible line;
//   - tracks the enclosing `def` stack by indentation, seeded by the hunk
//     header's function context, to decide whether a line is in a test body.
//
// Added lines are only CANDIDATES until the section ends, so an alias
// imported anywhere in the visible section resolves a marker in an earlier
// hunk. Without a visible import the canonical module names `pytest` and
// `unittest` always resolve, and `@mark.skip`/`@mark.skipif`/`@mark.xfail`
// resolves in decorator position; any other alias imported outside the
// visible hunks is not resolvable from the diff and does not flag.
//
// `pytest.importorskip` (and an imported `importorskip`) flags only inside
// a test function body — the innermost visible enclosing `def` chain
// contains a `test*` function. At module level, in a fixture or helper, or
// with no visible enclosing function it is a dependency guard, not a
// skipped test, and does not flag. Every other marker flags wherever it is
// added in the file, including module-level `pytestmark` and
// `pytest.skip(..., allow_module_level=True)`.

/** One added line awaiting evaluation at the end of its section. */
interface Candidate {
  line: number;
  content: string;
  code: string;
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

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
const DEF_RE = new RegExp(`^(\\s*)(?:async\\s+)?def\\s+(${IDENT})`);
const CLASS_RE = new RegExp(`^(\\s*)class\\s+${IDENT}`);
const IMPORT_AS_RE = new RegExp(`^\\s*import\\s+(.+)$`);
const FROM_IMPORT_RE = new RegExp(`^\\s*from\\s+(${IDENT})\\s+import\\s+\\(?([^)]*)\\)?\\s*$`);

/** Python test-file section scanner; one instance per diff section. */
export class PythonSectionScanner {
  private readonly pytestNames = new Set(['pytest']);
  private readonly unittestNames = new Set(['unittest']);
  private readonly markNames = new Set<string>();
  /** local name → canonical `pytest.X` / `unittest.X` imported function. */
  private readonly importedFunctions = new Map<string, string>();
  private readonly candidates: Candidate[] = [];
  private openTriple: string | null = null;
  /** Module of an open parenthesized `from M import (` spanning lines. */
  private pendingFrom: string | null = null;
  private defs: { name: string; indent: number }[] = [];

  /** A hunk header: string state is unknowable; seed the def stack from its context. */
  hunk(header: string): void {
    this.openTriple = null;
    this.pendingFrom = null;
    this.defs = [];
    const context = /^@@ [^@]* @@ ?(.*)$/.exec(header)?.[1] ?? '';
    const def = DEF_RE.exec(context);
    if (def) {
      this.defs.push({ name: def[2]!, indent: def[1]!.length });
    }
  }

  /** A context or added line, in new-file order. */
  line(content: string, added: boolean, lineNumber: number): void {
    const startedInString = this.openTriple !== null;
    const code = this.codeOf(content);
    if (!startedInString && code.trim() !== '') {
      this.trackDefs(code);
      this.trackImports(code);
    }
    if (added && code.trim() !== '') {
      this.candidates.push({
        line: lineNumber,
        content,
        code,
        inTestBody: this.defs.some((d) => /^test/.test(d.name)),
      });
    }
  }

  /** Resolve every candidate against the section's final alias set. */
  markers(): PythonSkipMarker[] {
    const found: PythonSkipMarker[] = [];
    for (const candidate of this.candidates) {
      const marker = this.markerOf(candidate);
      if (marker !== null) {
        found.push({ line: candidate.line, content: candidate.content, marker });
      }
    }
    return found;
  }

  private markerOf(candidate: Candidate): string | null {
    const { code, inTestBody } = candidate;
    const hits: { index: number; marker: string }[] = [];
    const add = (re: RegExp, marker: (m: RegExpExecArray) => string | null): void => {
      for (const m of code.matchAll(new RegExp(re.source, 'g'))) {
        const name = marker(m);
        if (name !== null) hits.push({ index: m.index, marker: name });
      }
    };
    const pytest = alternation(this.pytestNames);
    const unittest = alternation(this.unittestNames);
    add(
      new RegExp(`${pre}(?:${pytest})\\s*\\.\\s*mark\\s*\\.\\s*(skipif|skip|xfail)${post}`),
      (m) => `pytest.mark.${m[1]!}`,
    );
    if (this.markNames.size > 0) {
      add(
        new RegExp(`${pre}(?:${alternation(this.markNames)})\\s*\\.\\s*(skipif|skip|xfail)${post}`),
        (m) => `pytest.mark.${m[1]!}`,
      );
    }
    add(/@\s*mark\s*\.\s*(skipif|skip|xfail)(?![A-Za-z0-9_])/, (m) => `pytest.mark.${m[1]!}`);
    add(new RegExp(`${pre}(?:${pytest})\\s*\\.\\s*(skip|xfail|importorskip)\\s*\\(`), (m) =>
      m[1] === 'importorskip' && !inTestBody ? null : `pytest.${m[1]!}`,
    );
    add(
      new RegExp(`${pre}(?:${unittest})\\s*\\.\\s*(skipIf|skipUnless|skip|expectedFailure)${post}`),
      (m) => `unittest.${m[1]!}`,
    );
    add(
      new RegExp(`\\braise\\s+(?:(?:${unittest})\\s*\\.\\s*)SkipTest${post}`),
      () => 'unittest.SkipTest',
    );
    add(/\.\s*skipTest\s*\(/, () => 'self.skipTest');
    for (const [local, canonical] of this.importedFunctions) {
      const name = escapeRe(local);
      if (canonical === 'unittest.SkipTest') {
        add(new RegExp(`\\braise\\s+${name}${post}`), () => canonical);
      } else if (canonical === 'pytest.importorskip') {
        add(new RegExp(`${pre}${name}\\s*\\(`), () => (inTestBody ? canonical : null));
      } else if (canonical.startsWith('unittest.')) {
        add(new RegExp(`@\\s*${name}${post}|${pre}${name}\\s*\\(`), () => canonical);
      } else {
        add(new RegExp(`${pre}${name}\\s*\\(`), () => canonical);
      }
    }
    if (hits.length === 0) return null;
    hits.sort((a, b) => a.index - b.index);
    return hits[0]!.marker;
  }

  private trackDefs(code: string): void {
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
    }
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
    const plain = IMPORT_AS_RE.exec(code);
    if (plain) {
      for (const [name, local] of importedNames(plain[1]!)) {
        if (name === 'pytest') this.pytestNames.add(local);
        else if (name === 'unittest') this.unittestNames.add(local);
      }
    }
  }

  private bindFrom(module: string, list: string): void {
    for (const [name, local] of importedNames(list)) {
      if (module === 'pytest' && PYTEST_IMPORTABLE.has(name)) {
        if (name === 'mark') this.markNames.add(local);
        else this.importedFunctions.set(local, `pytest.${name}`);
      } else if (module === 'unittest' && UNITTEST_IMPORTABLE.has(name)) {
        this.importedFunctions.set(local, `unittest.${name}`);
      }
    }
  }

  /** The line with string contents and comments blanked; updates triple-quote state. */
  private codeOf(content: string): string {
    let out = '';
    let i = 0;
    while (i < content.length) {
      if (this.openTriple !== null) {
        const close = findClose(content, i, this.openTriple);
        if (close === -1) return out;
        out += ' '.repeat(close + 3 - i);
        i = close + 3;
        this.openTriple = null;
        continue;
      }
      const ch = content[i]!;
      if (ch === '#') return out;
      if (ch === '"' || ch === "'") {
        const triple = ch.repeat(3);
        if (content.startsWith(triple, i)) {
          this.openTriple = triple;
          out += '   ';
          i += 3;
          continue;
        }
        const close = findClose(content, i + 1, ch);
        const end = close === -1 ? content.length : close + 1;
        out += ' '.repeat(end - i);
        i = end;
        continue;
      }
      out += ch;
      i++;
    }
    return out;
  }
}

/** Regex prefix: an identifier start, not an attribute access or a longer name. */
const pre = '(?<![A-Za-z0-9_.])';
/** Regex suffix: the identifier ends here. */
const post = '(?![A-Za-z0-9_])';

function alternation(names: ReadonlySet<string>): string {
  return [...names].map(escapeRe).join('|');
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `a, b as c` → [[a, a], [b, c]]; dotted `import a.b` yields nothing usable. */
function importedNames(list: string): [string, string][] {
  const pairs: [string, string][] = [];
  for (const part of list.split(',')) {
    const m = new RegExp(`^\\s*(${IDENT})(?:\\s+as\\s+(${IDENT}))?\\s*$`).exec(part);
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
