// bin shim — dist/cli.js. Keep it dumb: all behavior lives in src/cli/.
import { runCli } from './cli/main.js';
import { processIo } from './cli/output.js';

process.exitCode = await runCli(process.argv.slice(2), processIo);
