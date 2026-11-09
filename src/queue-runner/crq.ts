#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { run } from './runner.js';
import { planTick } from './tick.js';

const root = process.cwd();
const result = await run(process.argv.slice(2), {
  shadowRoot: root,
  tick: randomUUID(),
  planner: (command, args) => planTick(root, command, args),
});
process.stdout.write(`${JSON.stringify(result.artifact)}\n`);
process.exitCode = result.exitCode;
