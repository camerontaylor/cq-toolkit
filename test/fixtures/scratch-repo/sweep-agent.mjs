// Fake sweep agent — the D4 e2e's fixer worker (the subprocess driver's CLI
// leg). Dependency-free, node: builtins only, spawned by the toolkit's real
// subprocess driver as
//
//   node test/fixtures/scratch-repo/sweep-agent.mjs -p --output-format
//        stream-json --verbose --allowedTools edit --model sweep-fake
//
// with the PROMPT on stdin (the driver's headless contract). It speaks the
// stream-json event shapes the driver parses:
//   {type:'system', subtype:'init', session_id, model}
//   {type:'assistant', message:{content:[{type:'text',text}], usage}}
//   {type:'result', subtype:'success', is_error:false, session_id, usage, model}
//
// THE INSTRUCTION: the unit op's prompt (composed by the e2e's prompt
// builder, not by the toolkit) carries ONE machine-readable line,
//
//   @SWEEP-AGENT <json>
//
// whose payload steers the fixture — the agent itself has no sweep
// knowledge (the model is the script, exactly like the T1.5 fixture):
//   {edit:{file,oldText,newText}}  perform ONE literal first-occurrence
//                                  replacement in cwd (the worktree), the
//                                  alpha fix or the beta break
//   {write:{file,text}}            ADD one new file in cwd (the worktree) —
//                                  the tamper-guard e2e's new-file hack
//   {delete:file}                  REMOVE one file in cwd (with {write} this
//                                  is a working-tree rename — the
//                                  rename-side allowlist e2e)
//   {fault:"why"}                  stderr + exit 1 with NO result event —
//                                  the driver's 'error' stop reason (the
//                                  mid-run fault the interrupt test reaps)
//   {}                             honest no-op ('nothing to fix')
//
// Fixed usage everywhere: {input_tokens:10, output_tokens:5,
// cache_read_input_tokens:2, cache_creation_input_tokens:3}.
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import process from 'node:process';

const USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 2,
  cache_creation_input_tokens: 3,
};

const model = process.argv.includes('--model')
  ? process.argv[process.argv.indexOf('--model') + 1]
  : 'sweep-fake';
const sessionId = `sweep-agent-${process.pid}-${Date.now().toString(36)}`;

const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

/** The last @SWEEP-AGENT instruction line in the prompt, or the no-op {}. */
async function instructionOf() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const prompt = Buffer.concat(chunks).toString('utf8');
  const lines = prompt.split('\n').filter((line) => line.startsWith('@SWEEP-AGENT '));
  const last = lines[lines.length - 1];
  if (last === undefined) return {};
  try {
    const parsed = JSON.parse(last.slice('@SWEEP-AGENT '.length));
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** Workspace containment, lexical only (the T1.5 fixture's posture). */
function resolveInside(path) {
  const root = resolve(process.cwd());
  const abs = resolve(root, path);
  return abs === root || abs.startsWith(root + sep) ? abs : undefined;
}

/** The one literal edit; returns the summary text, never throws. */
async function performEdit(edit) {
  const file = typeof edit.file === 'string' ? edit.file : '';
  const abs = resolveInside(file);
  if (file === '' || abs === undefined) return `refused: '${file}' resolves outside the checkout`;
  let content;
  try {
    content = await readFile(abs, 'utf8');
  } catch (err) {
    return `refused: cannot read '${file}' — ${String(err.message ?? err)}`;
  }
  if (!content.includes(edit.oldText)) return `nothing to fix: '${file}' has no seeded failure`;
  await writeFile(abs, content.replace(edit.oldText, edit.newText), 'utf8');
  return `fixed '${file}' (one replacement)`;
}

/**
 * The one new-file write ({write:{file,text}}) — how a "fixer" ADDS a file
 * (the tamper-guard e2e's new-file hack: the unit op stages before it
 * scans, so the staged diff must carry exactly this).
 */
async function performWrite(write) {
  const file = typeof write.file === 'string' ? write.file : '';
  const abs = resolveInside(file);
  if (file === '' || abs === undefined) return `refused: '${file}' resolves outside the checkout`;
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, String(write.text ?? ''), 'utf8');
  return `added '${file}'`;
}

/** The one removal ({delete:file}) — the rename-side allowlist e2e's half of a working-tree rename. */
async function performDelete(file) {
  const abs = resolveInside(typeof file === 'string' ? file : '');
  if (abs === undefined) return `refused: '${file}' resolves outside the checkout`;
  await rm(abs, { force: true });
  return `removed '${file}'`;
}

const instruction = await instructionOf();
out({ type: 'system', subtype: 'init', session_id: sessionId, model });

// The TRANSIENT fault ({faultOnce:{marker,why}}): faults ONLY the first
// invocation (the marker file is created outside the checkout); a re-dispatch
// sees the marker and proceeds — the rescue lane's attempt-1/attempt-2 shape.
let faulted = false;
if (
  instruction.faultOnce !== undefined &&
  instruction.faultOnce !== null &&
  typeof instruction.faultOnce.marker === 'string' &&
  instruction.faultOnce.marker !== ''
) {
  if (!existsSync(instruction.faultOnce.marker)) {
    const { writeFile: writeMarker } = await import('node:fs/promises');
    const { dirname: dirOf } = await import('node:path');
    await mkdir(dirOf(instruction.faultOnce.marker), { recursive: true });
    await writeMarker(instruction.faultOnce.marker, 'faulted\n');
    faulted = true;
  }
}
if (typeof instruction.fault === 'string' && instruction.fault !== '') {
  faulted = true;
}
if (faulted) {
  const why =
    instruction.faultOnce !== undefined && instruction.faultOnce !== null
      ? String(instruction.faultOnce.why ?? 'transient fault')
      : String(instruction.fault ?? 'fault');
  process.stderr.write(`sweep-agent: ${why}\n`);
  process.exitCode = 1; // no result event — the driver's 'error' stop reason
} else {
  const texts = [];
  if (instruction.write !== undefined && instruction.write !== null) {
    texts.push(await performWrite(instruction.write));
  }
  if (typeof instruction.delete === 'string' && instruction.delete !== '') {
    texts.push(await performDelete(instruction.delete));
  }
  if (instruction.edit !== undefined && instruction.edit !== null) {
    texts.push(await performEdit(instruction.edit));
  }
  if (instruction.selfCommit !== undefined && instruction.selfCommit !== null) {
    // The #174 attack shape: the DRIVER commits the fix itself, so the
    // op's stage step later finds nothing to stage and its scan/commit
    // gates never see these bytes.
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['add', '-A'], { cwd: process.cwd() });
    execFileSync(
      'git',
      ['commit', '-m', String(instruction.selfCommit.message ?? 'driver self-commit')],
      { cwd: process.cwd() },
    );
    texts.push('committed the fix directly (driver self-commit)');
  }
  const text = texts.length === 0 ? 'nothing to fix' : texts.join('; ');
  out({ type: 'assistant', message: { content: [{ type: 'text', text }], usage: USAGE } });
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: sessionId,
    usage: USAGE,
    model,
  });
}
