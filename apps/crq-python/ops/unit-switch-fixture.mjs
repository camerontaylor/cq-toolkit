#!/usr/bin/env node
// Harmless Node fixture for the isolated unit-switch proof vehicle.
//
// Invoked by a systemd oneshot unit installed under crq-tick.service in a
// disposable guest. It performs no CRQ work: it appends one runtime-bound
// completion record and exits. The controller's proof adapter consumes those
// records as fake (fixture-only) completion evidence. systemd serializes runs
// of this oneshot unit, so no cross-process lock is required.

import fs from "node:fs";
import path from "node:path";

const RUNTIME = /^node:[0-9a-f]{40}$/;

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--")) {
      throw new Error(`unexpected argument: ${name}`);
    }
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`missing value for ${name}`);
    }
    values[name.slice(2)] = value;
    index += 1;
  }
  return values;
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function readSequence(completions) {
  if (!fs.existsSync(completions)) {
    return 0;
  }
  let sequence = 0;
  for (const line of fs.readFileSync(completions, "utf8").split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const record = JSON.parse(line);
    if (!Number.isInteger(record.sequence) || record.sequence < 1) {
      throw new Error("existing completion record has an invalid sequence");
    }
    sequence = Math.max(sequence, record.sequence);
  }
  return sequence;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const required of ["unit", "runtime", "completions"]) {
    if (!args[required]) {
      throw new Error(`missing --${required}`);
    }
  }
  if (!RUNTIME.test(args.runtime)) {
    throw new Error("node fixture requires a node:<sha> runtime marker");
  }
  const invocation = process.env.INVOCATION_ID || "";
  if (!/^[0-9a-f]{32}$/.test(invocation)) {
    throw new Error("systemd did not provide an invocation id");
  }
  const completions = path.resolve(args.completions);
  fs.mkdirSync(path.dirname(completions), { recursive: true });
  const sequence = readSequence(completions) + 1;
  const record = {
    unit: args.unit,
    runtime: args.runtime,
    success: true,
    sequence,
    invocation,
    at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    boot_id: fs
      .readFileSync("/proc/sys/kernel/random/boot_id", "utf8")
      .trim(),
  };
  // writeSync may perform a partial write, so loop until every byte of the
  // encoded record lands; if the write cannot finish, restore the original
  // file length so no partial JSON line is left for the next run to parse.
  const payload = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  const descriptor = fs.openSync(completions, "a");
  const originalLength = fs.fstatSync(descriptor).size;
  let written = 0;
  try {
    while (written < payload.length) {
      const count = fs.writeSync(
        descriptor,
        payload,
        written,
        payload.length - written,
      );
      if (!Number.isInteger(count) || count <= 0) {
        throw new Error("completion record write made no progress");
      }
      written += count;
    }
    fs.fsyncSync(descriptor);
  } catch (error) {
    fs.ftruncateSync(descriptor, originalLength);
    throw error;
  } finally {
    fs.closeSync(descriptor);
  }
  sleep(200);
}

main();
