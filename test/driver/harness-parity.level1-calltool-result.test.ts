// Split provenance: test/driver/harness-parity.test.ts was split by subject; this
// file holds the LEVEL 1 CallToolResult parity tests (stdio ≡ claude-agent
// handler ≡ core). The shared config, fixtures and the three paths' drivers
// live in harness-parity.helpers.ts.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createHarnessSurface } from '../../src/harness/surface.js';
import {
  A_BODY,
  NOTE_BODY,
  PHASES,
  claudeAgentPhase,
  corePhase,
  manifestFor,
  renderRead,
  scratch,
  stdioPhase,
} from './harness-parity.helpers.js';

// ---------------------------------------------------------------------------
// LEVEL 1 — CallToolResult parity
// ---------------------------------------------------------------------------

describe('harness parity — Level 1: CallToolResult (stdio ≡ claude-agent handler ≡ core)', () => {
  for (const phase of PHASES) {
    test(`byte-identical results across the three paths — sandbox ${phase.sandbox}`, async () => {
      const core = await corePhase(phase.sandbox, phase.steps);
      const stdio = await stdioPhase(phase.sandbox, phase.steps);
      const agent = await claudeAgentPhase(phase.sandbox, phase.steps);

      // The claude-agent run itself was a clean, verified run.
      expect(agent.verdict.stopReason).toBe('complete');
      expect(agent.verdict.error).toBeUndefined();
      // The registered surface IS the core surface: only canonical names,
      // unchanged descriptions, and strict canonical schemas. Legacy `run`
      // reaches the raw tools/call adapter without being advertised.
      const coreSurface = createHarnessSurface(await manifestFor(core.workspace, phase.sandbox));
      const expectedNames = coreSurface.tools.map((tool) => tool.name);
      expect(agent.tools.map((t) => t.name)).toEqual(expectedNames);
      for (const tool of agent.tools) {
        const coreTool = coreSurface.tools.find((candidate) => candidate.name === tool.name);
        if (coreTool === undefined) throw new Error(`no core tool for '${tool.name}'`);
        expect(tool.description, tool.name).toBe(coreTool.description);
        expect(Object.keys(tool.shape as object), tool.name).toEqual(
          Object.keys(coreTool.inputSchema.shape),
        );
        expect(tool.inputSchema).toBe(coreTool.inputSchema);
      }

      expect(core.results).toHaveLength(phase.steps.length);
      expect(stdio.results).toHaveLength(phase.steps.length);
      expect(agent.results).toHaveLength(phase.steps.length);
      phase.steps.forEach((step, i) => {
        const reference = JSON.stringify(core.results[i]);
        expect(JSON.stringify(stdio.results[i]), `stdio: ${step.label}`).toBe(reference);
        expect(JSON.stringify(agent.results[i]), `claude-agent: ${step.label}`).toBe(reference);
      });

      // The sequence exercised what it claims (not a vacuous all-ok parity).
      const texts = core.results.map((r) => r.content.map((b) => b.text).join(''));
      if (phase.sandbox === 'workspace-write') {
        expect(core.results.map((r) => r.isError === true)).toEqual([
          false,
          false,
          false,
          false,
          true,
          true,
          true,
          true,
          false,
          true,
          true,
        ]);
        expect(texts[0]).toBe(renderRead('note.txt', NOTE_BODY));
        expect(texts[1]).toBe(renderRead('src/a.txt', A_BODY));
        expect(texts[2]).toBe("edited 'src/a.txt': replaced 1 occurrence");
        expect(texts[3]).toBe(renderRead('src/a.txt', 'beta\n'));
        expect(texts[4]).toBe(
          "PATH_DENIED: path not allowed by harness config allowlist: 'secret.txt'",
        );
        expect(texts[5]).toBe("PATH_ESCAPE: path escape: '../x' resolves outside the workspace");
        expect(texts[6]).toBe("PATH_ESCAPE: path escape: '../x' resolves outside the workspace");
        expect(texts[7]).toBe("FS_NOT_FOUND: file not found: 'src/missing.txt'");
        expect(texts[8]).toBe('exit 0\n--- stdout ---\nhi\n');
        expect(texts[9]).toBe(
          "CMD_DENIED: command not allowed by harness config allowlist: 'whoami'",
        );
        expect(texts[10]?.startsWith('CMD_DENIED: command allowlist: shell metacharacters')).toBe(
          true,
        );
        // Post-state parity: every path's edit landed identically.
        for (const ws of [core.workspace, stdio.workspace, agent.workspace]) {
          await expect(readFile(join(ws, 'src', 'a.txt'), 'utf8')).resolves.toBe('beta\n');
        }
      } else {
        expect(texts).toEqual([
          renderRead('note.txt', NOTE_BODY),
          'PATH_DENIED: sandbox: read-only',
          'PATH_DENIED: sandbox: read-only',
        ]);
        expect(core.results.map((r) => r.isError === true)).toEqual([false, true, true]);
        for (const ws of [core.workspace, stdio.workspace, agent.workspace]) {
          await expect(readFile(join(ws, 'note.txt'), 'utf8')).resolves.toBe(NOTE_BODY);
        }
      }

      // Workspace-RELATIVE text is what makes the three different workspace
      // dirs comparable: no result embeds any workspace path (nor the
      // scratch root that contains them all).
      const all = JSON.stringify([core.results, stdio.results, agent.results]);
      for (const ws of [core.workspace, stdio.workspace, agent.workspace, scratch]) {
        expect(all.includes(ws)).toBe(false);
      }
      // The three paths really used three distinct workspaces.
      expect(new Set([core.workspace, stdio.workspace, agent.workspace]).size).toBe(3);
    }, 60_000);
  }
});
