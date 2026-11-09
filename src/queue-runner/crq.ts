#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { run } from './runner.js';

const result = await run(process.argv.slice(2), { shadowRoot: process.cwd(), tick: randomUUID() });
process.stdout.write(`${JSON.stringify(result.artifact)}\n`);
process.exitCode = result.exitCode;
