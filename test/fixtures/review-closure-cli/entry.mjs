// Production CLI with a scripted fixer in an isolated fixture registry.
import { fileURLToPath } from 'node:url';
import { runCli } from '../../../dist/cli/main.js';
import './review/registry.js';
process.exitCode = await runCli(process.argv.slice(2), undefined, {
  opsRoot: fileURLToPath(new URL('./', import.meta.url)),
});
