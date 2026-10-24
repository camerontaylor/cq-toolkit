// Hermetic CLI entry: production dispatch with a scripted-driver ops root.
import { fileURLToPath } from 'node:url';
import { runCli } from '../../../dist/cli/main.js';
// Make the dynamically discovered fixture family visible to static dependency analysis.
import './review/registry.js';
process.exitCode = await runCli(process.argv.slice(2), undefined, {
  opsRoot: fileURLToPath(new URL('./', import.meta.url)),
});
