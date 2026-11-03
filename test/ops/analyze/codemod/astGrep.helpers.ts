// Split provenance: test/ops/analyze/codemod/astGrep.test.ts was split into
// astGrep.parse.test.ts, astGrep.scan.test.ts, astGrep.collision.test.ts,
// astGrep.diff.test.ts, astGrep.codemod-approval.test.ts,
// astGrep.codemod-plan.test.ts, astGrep.codemod-write-safety.test.ts and
// astGrep.codemod-target-policy.test.ts. The fixtures below are shared by the
// codemod test files.
import type { RawCheckOutput, RunCheck } from '../../../../src/ops/gates/checkRunner.js';
import type { AnalyzeFileStore } from '../../../../src/ops/analyze/analysisStore.js';
import type { ApprovalAuthority, ApprovalState } from '../../../../src/ops/analyze/approval.js';
import { makeInMemoryNonceLedger } from '../../../../src/adapters/store/nonceLedger.js';
import {
  makeApprovalAuthority,
  makeProcessLocalMutationLocks,
} from '../../../../src/ops/analyze/approval.js';
import { AnalysisStoreError } from '../../../../src/ops/analyze/analysisStore.js';
import { makeAstGrepCodemod } from '../../../../src/ops/analyze/codemod/astGrep.js';

/**
 * An in-memory store recording writes; same idiom as the render tests. The
 * paths are used verbatim (the unit under test builds them).
 */
export function memoryStore(files: Record<string, string>): AnalyzeFileStore & {
  written: Map<string, Uint8Array>;
} {
  const backing = new Map<string, Uint8Array>(
    Object.entries(files).map(([path, text]) => [path, Buffer.from(text, 'utf8')]),
  );
  const written = new Map<string, Uint8Array>();
  return {
    written,
    readBytes: async (path) => {
      const bytes = backing.get(path);
      if (bytes === undefined) {
        throw new AnalysisStoreError(`analysis store: '${path}' does not resolve`);
      }
      return Uint8Array.from(bytes);
    },
    readText: async (path) => Buffer.from(backing.get(path) as Uint8Array).toString('utf8'),
    writeBytes: async (path, bytes) => {
      const copy = Uint8Array.from(bytes);
      written.set(path, copy);
      backing.set(path, copy);
    },
    isDirectory: async () => true,
  };
}

/** A fake runner returning one canned raw output and recording the command. */
export function fakeRunner(
  response: Omit<RawCheckOutput, never>,
): RunCheck & { commands: unknown[] } {
  const runner = async (cmd: Parameters<RunCheck>[0]) => {
    runner.commands.push(cmd);
    return response;
  };
  runner.commands = [] as unknown[];
  return runner as RunCheck & { commands: unknown[] };
}

/** One ast-grep scan match with a fix, over a byte range (the documented wire shape). */
export function matchOf(file: string, start: number, end: number, replacement: string): object {
  return {
    text: 'matched bytes',
    range: {
      byteOffset: { start, end },
      start: { line: 0, column: 0 },
      end: { line: 0, column: end - start },
    },
    file,
    lines: 'matched bytes',
    charCount: { leading: 0, trailing: 0 },
    replacement,
    replacementOffsets: { start, end },
    language: 'TypeScript',
    ruleId: 'consumer-rule',
    severity: 'hint',
    note: null,
    message: 'consumer rule message',
  };
}

export const FIXTURE_FILES = {
  'src/a.ts': 'const foo_bar = 1;\nconst other = foo_bar;\n',
  'src/b.ts': 'export const baz_qux = 2;\n',
};
export const EDITS = [
  { file: 'src/a.ts', startByte: 6, endByte: 13, replacement: 'fooBar' },
  { file: 'src/a.ts', startByte: 33, endByte: 40, replacement: 'fooBar' },
  { file: 'src/b.ts', startByte: 13, endByte: 20, replacement: 'bazQux' },
];

export function scanRunner(): RunCheck & { commands: unknown[] } {
  return fakeRunner({
    stdout: JSON.stringify(
      EDITS.map((e) => matchOf(e.file, e.startByte, e.endByte, e.replacement)),
    ),
    stderr: '',
    exitCode: 0,
  });
}

/**
 * A REAL approval authority for the op's own write (ADR-0003), over a real
 * in-memory nonce ledger and the real mutation lock. Only the kernel's
 * verified-approval seam and the workspace state reader are substituted.
 *
 * The default in `makeAstGrepCodemod` is the DENY-ALL authority, so this
 * helper binds one explicitly — otherwise every apply-path test below would
 * be refused at the mutation, which is a separate test below.
 */
export function trustedAuthority(workspace = '/ws'): ApprovalAuthority {
  const state: ApprovalState = { workspace, headSha: 'codemod-head', treeClean: true };
  return makeApprovalAuthority({
    approvals: {
      verifiedFor: (subject) =>
        Promise.resolve({ nonce: `codemod-${subject.inputDigest.slice(0, 12)}`, state }),
    },
    ledger: makeInMemoryNonceLedger(),
    locks: makeProcessLocalMutationLocks(),
    readState: { read: () => Promise.resolve(state) },
  });
}

/**
 * A scan runner scoped to the files the op was ASKED to touch. The shared
 * {@link scanRunner} answers with edits for BOTH fixture files, so an op
 * asked for `src/a.ts` alone meets the pre-existing canonicalization rule
 * that rejects a reported match outside the requested set — a real fault,
 * correctly raised. These tests are about the APPROVAL boundary, not about
 * multi-file scans, so the fake must answer for the request it is given.
 */
export function scanRunnerFor(...files: string[]): RunCheck & { commands: unknown[] } {
  return fakeRunner({
    stdout: JSON.stringify(
      EDITS.filter((edit) => files.includes(edit.file)).map((edit) =>
        matchOf(edit.file, edit.startByte, edit.endByte, edit.replacement),
      ),
    ),
    stderr: '',
    exitCode: 0,
  });
}

export function makeOp(store: AnalyzeFileStore, run: RunCheck = scanRunner()) {
  return makeAstGrepCodemod(run, () => store, trustedAuthority());
}
