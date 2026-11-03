// Split provenance: test/harness/search-tools.test.ts was split into the
// search-tools.*.test.ts subject files; this module holds their shared
// workspace, tool-lookup and candidate-retention fixtures (no tests).
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import type { HarnessConfig } from '../../src/harness/config.js';
import type { ToolkitTool } from '../../src/harness/tools.js';

export async function withWorkspace(body: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'cq-search-tools-'));
  try {
    await body(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export function tool(tools: ToolkitTool[], name: string): ToolkitTool {
  const found = tools.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`missing ${name} tool`);
  return found;
}

export function configWithReadPaths(
  pathPatterns: string[],
  maxOutputChars?: number,
): HarnessConfig {
  return {
    ...defaultHarnessConfig,
    tools: {
      ...defaultHarnessConfig.tools,
      read: {
        ...defaultHarnessConfig.tools.read,
        pathPatterns,
        ...(maxOutputChars === undefined ? {} : { maxOutputChars }),
      },
    },
  };
}

/** The streaming buffer's capacity: SEARCH_CANDIDATE_LIMIT + 1 truncation slot. */
export const CANDIDATE_CAP = 1_001;

/**
 * The pre-heap retention policy, verbatim, as an independent oracle: push each
 * emission, then drop the FIRST maximum (`>`-only scan, so among equal names
 * the earliest insertion goes). Duplicates are separate slots and may consume
 * capacity on their own.
 */
export function legacyRetained(emissions: readonly string[]): {
  rels: string[];
  truncated: boolean;
} {
  const slots: { rel: string; seq: number }[] = [];
  emissions.forEach((rel, seq) => {
    slots.push({ rel, seq });
    if (slots.length <= CANDIDATE_CAP) return;
    let largest = 0;
    for (let index = 1; index < slots.length; index += 1) {
      if (slots[index]!.rel > slots[largest]!.rel) largest = index;
    }
    slots.splice(largest, 1);
  });
  slots.sort((left, right) =>
    left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : left.seq - right.seq,
  );
  return { rels: slots.map((slot) => slot.rel), truncated: slots.length > CANDIDATE_CAP - 1 };
}

/** One matching file per distinct name, written in bounded batches of 64. */
export async function writeCandidateFiles(
  workspace: string,
  rels: readonly string[],
): Promise<void> {
  const names = [...new Set(rels)];
  for (let start = 0; start < names.length; start += 64) {
    await Promise.all(
      names
        .slice(start, start + 64)
        .map((rel) => writeFile(join(workspace, rel), 'retained-needle\n', 'utf8')),
    );
  }
}

/** The emissions as one chunked, NUL-terminated fake `rg --files` stream. */
export function fakeEnumeration(rels: readonly string[]): Buffer[] {
  const chunks: Buffer[] = [];
  for (let start = 0; start < rels.length; start += 128) {
    chunks.push(
      Buffer.from(
        rels
          .slice(start, start + 128)
          .map((rel) => `${rel}\0`)
          .join(''),
        'utf8',
      ),
    );
  }
  return chunks;
}

/** The rendered `--- <path> ---` group headers, in output order. */
export function renderedPaths(output: string): string[] {
  return [...output.matchAll(/^--- (.+) ---$/gm)].map((match) => match[1]!);
}
