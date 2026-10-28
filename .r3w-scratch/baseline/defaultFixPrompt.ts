// Load the canonical fixer prompt as package data. The build copies the
// Markdown beside this module, so source and published-package imports use
// the same bytes while preserving the synchronous `defaultFixPrompt` API.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const defaultFixPrompt: string = readFileSync(
  fileURLToPath(new URL('./fix.default.md', import.meta.url)),
  'utf8',
);
