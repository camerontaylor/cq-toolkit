// copy-prompt-assets — the build's asset step: worker prompt templates are
// DATA, not TypeScript, so tsc never emits them. Copies every
// src/ops/merge/prompts/*.md into dist/ops/merge/prompts/ so the shipped
// package resolves them at runtime (resolveConflict's defaultLoadPrompt
// reads the file beside the compiled module). Cross-platform by
// construction — node:fs/promises + node:path, no shell.
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(repoRoot, 'src', 'ops', 'merge', 'prompts');
const distDir = path.join(repoRoot, 'dist', 'ops', 'merge', 'prompts');

await mkdir(distDir, { recursive: true });
const files = (await readdir(srcDir)).filter((file) => file.endsWith('.md'));
for (const file of files) {
  await copyFile(path.join(srcDir, file), path.join(distDir, file));
}
console.log(
  `copy-prompt-assets: ${String(files.length)} prompt asset(s) → dist/ops/merge/prompts/`,
);
