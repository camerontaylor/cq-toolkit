import { writeFile } from 'node:fs/promises';
import {
  CAPABILITY_SCHEMA_VERSION,
  LIVE_UNIT_COMMANDS,
} from '../dist/queue-runner/capabilities.js';

const commands = [...LIVE_UNIT_COMMANDS];
if (new Set(commands).size !== commands.length) {
  throw new Error('LIVE_UNIT_COMMANDS contains duplicates');
}
const document = {
  schema_version: CAPABILITY_SCHEMA_VERSION,
  commands: commands.sort(),
};
await writeFile(
  new URL('../dist/queue-runner/capabilities.json', import.meta.url),
  `${JSON.stringify(document, null, 2)}\n`,
);
