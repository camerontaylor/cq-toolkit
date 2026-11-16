/** Bounded Python re syntax translator for inactive CRQ review scanning. */
import { pythonUnicode16SpaceRanges, pythonUnicode16WordRanges } from './pythonUnicode16.js';

function unicodeClass(ranges: readonly number[]): string {
  let result = '';
  for (let i = 0; i < ranges.length; i += 2) {
    const start = ranges[i];
    const end = ranges[i + 1];
    if (start === undefined || end === undefined) throw new Error('invalid Unicode ranges');
    result += `\\u{${start.toString(16)}}`;
    if (end !== start) result += `-\\u{${end.toString(16)}}`;
  }
  return result;
}
const word = `[${unicodeClass(pythonUnicode16WordRanges())}]`;
const space = unicodeClass(pythonUnicode16SpaceRanges());
const boundary = `(?:(?<!${word})(?=${word})|(?<=${word})(?!${word}))`;
const atEnd = '(?:(?![\\s\\S])|(?=\\n(?![\\s\\S])))';
const punctuation = new Set('\\.^$|?*+()[]{}-/');
function escapedLiteral(ch: string): string {
  return `\\u{${ch.codePointAt(0)?.toString(16)}}`;
}

/** Rejects unsupported Python regex constructs instead of approximating them. */
export function translatePythonReviewPattern(pattern: string): string {
  let index = 0;
  const fail = (): never => {
    throw new Error('unsupported review regex');
  };
  const expression = (inGroup: boolean): { text: string; hasAssertion: boolean } => {
    let result = '';
    let hasAtom = false;
    let quantifiable = false;
    let hasAssertion = false;
    while (index < pattern.length) {
      const ch = pattern[index];
      if (ch === ')') {
        if (!inGroup || !hasAtom) return fail();
        return { text: result, hasAssertion };
      }
      if (ch === '|') {
        if (!hasAtom) return fail();
        result += '|';
        index++;
        hasAtom = false;
        quantifiable = false;
        continue;
      }
      if (ch === '*' || ch === '+' || ch === '?' || ch === '{') {
        if (!quantifiable) return fail();
        if (ch === '{') {
          const match = /^\{([0-9]+)(?:,([0-9]*))?\}/.exec(pattern.slice(index));
          if (!match) return fail();
          const minimum = Number(match[1]);
          const maximum =
            match[2] === undefined ? minimum : match[2] === '' ? Infinity : Number(match[2]);
          if (
            !Number.isSafeInteger(minimum) ||
            minimum > 10000 ||
            (match[2] !== undefined && match[2] !== '' && !Number.isSafeInteger(maximum)) ||
            maximum < minimum ||
            (maximum > 10000 && maximum !== Infinity)
          )
            return fail();
          result += match[0];
          index += match[0].length;
        } else {
          result += ch;
          index++;
        }
        quantifiable = false;
        continue;
      }
      if (ch === '(') {
        index++;
        let prefix = '(';
        if (pattern[index] === '?') {
          if (pattern.slice(index, index + 2) !== '?:') return fail();
          index += 2;
          prefix = '(?:';
        }
        const inner = expression(true);
        if (pattern[index] !== ')') return fail();
        index++;
        result += `${prefix}${inner.text})`;
        hasAtom = true;
        quantifiable = !inner.hasAssertion;
        hasAssertion ||= inner.hasAssertion;
        continue;
      }
      if (ch === '[') {
        index++;
        let negated = false;
        if (pattern[index] === '^') {
          negated = true;
          index++;
        }
        let content = '';
        let count = 0;
        const classAtom = (): { text: string; code: number | null } => {
          const current = pattern[index++];
          if (current === undefined || current === ']' || current === '-') return fail();
          if (current === '\\') {
            const next = pattern[index++];
            if (next === 's') return { text: space, code: null };
            if (next === undefined || !punctuation.has(next)) return fail();
            return { text: escapedLiteral(next), code: next.codePointAt(0) ?? null };
          }
          if (current.codePointAt(0)! > 127 || current === '[') return fail();
          return { text: escapedLiteral(current), code: current.codePointAt(0) ?? null };
        };
        while (index < pattern.length && pattern[index] !== ']') {
          if (pattern[index] === '-' && (count === 0 || pattern[index + 1] === ']')) {
            content += escapedLiteral('-');
            index++;
            count++;
            continue;
          }
          const first = classAtom();
          if (pattern[index] === '-' && pattern[index + 1] !== ']') {
            index++;
            const last = classAtom();
            if (first.code === null || last.code === null || first.code > last.code) return fail();
            content += `${first.text}-${last.text}`;
          } else {
            content += first.text;
            if (pattern[index] === '-' && pattern[index + 1] === ']') {
              content += escapedLiteral('-');
              index++;
            }
          }
          count++;
        }
        if (!count || pattern[index] !== ']') return fail();
        index++;
        result += `[${negated ? '^' : ''}${content}]`;
        hasAtom = true;
        quantifiable = true;
        continue;
      }
      if (ch === '\\') {
        index++;
        const next = pattern[index++];
        if (next === 'b') {
          result += boundary;
          quantifiable = false;
          hasAssertion = true;
        } else if (next === 's') {
          result += `[${space}]`;
          quantifiable = true;
        } else if (next !== undefined && punctuation.has(next)) {
          result += escapedLiteral(next);
          quantifiable = true;
        } else return fail();
        hasAtom = true;
        continue;
      }
      if (ch === '^' || ch === '$') {
        result += ch === '^' ? '^' : atEnd;
        quantifiable = false;
        hasAssertion = true;
        index++;
        hasAtom = true;
        continue;
      }
      if (ch === '.') {
        result += '[^\\n]';
        index++;
        hasAtom = true;
        quantifiable = true;
        continue;
      }
      if (ch === undefined || ch.codePointAt(0)! > 127 || '{}]'.includes(ch)) return fail();
      result += escapedLiteral(ch);
      index++;
      hasAtom = true;
      quantifiable = true;
    }
    if (!hasAtom || inGroup) return fail();
    return { text: result, hasAssertion };
  };
  const { text: result } = expression(false);
  if (index !== pattern.length) return fail();
  try {
    new RegExp(result, 'u');
  } catch {
    return fail();
  }
  return result;
}
