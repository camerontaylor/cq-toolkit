import { managedTerminal } from '../dev/reviewTestKit.js';
import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import { repoEffects, makeTestRepo } from '../dev/repo.js';
import { configureAgentRepo, scriptedDrivers } from './run.helpers.js';

describe('review.run', () => {
  it('retains CodeRabbit lines and ID fallback without a vendor rule', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const identity = { file: 'src/a.ts', line: 1, rule: 'shared-rule' };
      const effects = repoEffects(repo, (command) =>
        command === 'coderabbit'
          ? {
              exitCode: 0,
              stdout: [
                JSON.stringify({
                  type: 'finding',
                  fileName: identity.file,
                  startLine: identity.line,
                  endLine: identity.line,
                  title: 'Fixture issue',
                  codegenInstructions: 'Inspect the fixture',
                  suggestions: [],
                  severity: 'major',
                  comment: 'vendor wording',
                }),
                JSON.stringify({ type: 'complete', status: 'review_completed' }),
              ].join('\n'),
              stderr: '',
              timedOut: false,
            }
          : undefined,
      );
      const result = await makeReviewRun({
        managedSubmit: managedTerminal([
          { severity: 'major', fileName: 'src/a.ts', line: 1, excerpt: 'vendor wording' },
        ]),
        drivers: scriptedDrivers(undefined, 0, () => [
          { ...identity, severity: 'high', text: 'agent wording' },
        ]),
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map(({ component }) => ({ component, hits: [] })),
      })({ repoRoot: repo.root, reviewers: ['coderabbit', 'agent'] });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw new Error(result.status);
      expect(result.value.findings).toHaveLength(2);
      const vendor = result.value.findings.find((finding) => finding.source === 'coderabbit');
      const agent = result.value.findings.find((finding) => finding.source === 'agent');
      expect(vendor).toMatchObject({ file: identity.file, line: identity.line });
      expect(vendor).not.toHaveProperty('rule');
      expect(agent).toMatchObject(identity);
      expect(vendor?.id).not.toBe(agent?.id);
      const folder = join(repo.root, '.cq', 'review', 'feature%2Fx');
      const [recordFile] = await readdir(folder);
      const persisted = JSON.parse(await readFile(join(folder, recordFile ?? ''), 'utf8')) as {
        findings: unknown[];
      };
      expect(persisted.findings).toEqual(result.value.findings);
    } finally {
      await repo.cleanup();
    }
  });

  it('forwards opt-in area execution through the public op', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      await repo.write('a/api.ts', 'export const a = 1;');
      await repo.write('b/client.ts', 'export const b = 2;');
      repo.commitAll('two areas');
      const prompts: string[] = [];
      const result = await makeReviewRun({
        drivers: scriptedDrivers((input) => prompts.push(input.prompt)),
        effectsFactory: () => repoEffects(repo),
        scannerFactory: () => (components) =>
          components.map(({ component }) => ({ component, hits: [] })),
      })({ repoRoot: repo.root, areas: true });
      expect(result.status).toBe('ok');
      expect(prompts.some((prompt) => prompt.includes('Review cross-area contracts'))).toBe(true);
      const record = result.status === 'ok' ? result.value : result.report;
      const coverage = record?.sources.find((source) => source.kind === 'agent')?.coverage;
      expect(coverage && 'version' in coverage).toBe(true);
      if (coverage && 'version' in coverage && coverage.version === 2) {
        expect(coverage.modeReason).toContain('area review:');
        expect(coverage.sessions.find((session) => session.id === 'cross-area')).toMatchObject({
          id: 'cross-area',
          status: 'complete',
          deliveries: [],
        });
      }
    } finally {
      await repo.cleanup();
    }
  });

  it.each([
    'valid',
    'repaired',
    'invalid',
    'dirty',
    'untracked',
    'supporting',
    'historical-invalid',
  ] as const)('prepares %s anchored evidence through review.run', async (mode) => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      await repo.write('src/dependency.ts', 'export const dependency = 1;\n');
      repo.commitAll('dependency baseline');
      const base = repo.git('rev-parse', 'HEAD').trim();
      if (mode === 'dirty') {
        await repo.write('src/evidence.ts', 'export const value = 0;\n');
        repo.commitAll('old evidence value');
      }
      await repo.write('src/evidence.ts', 'export const value = 1;\n');
      if (mode !== 'untracked' && mode !== 'dirty') repo.commitAll('evidence fixture');
      let requests = 0;
      const result = await makeReviewRun({
        drivers: scriptedDrivers(
          () => {
            requests++;
          },
          0,
          () => [
            {
              file: 'src/evidence.ts',
              line: 1,
              severity: 'high',
              text: 'seeded',
              evidenceV1: {
                version: 1,
                ...(mode === 'historical-invalid'
                  ? { validation: { status: 'invalid', reasons: ['quote-mismatch'] } }
                  : {}),
                failureScenario: 'seeded scenario',
                primary: {
                  file: 'src/evidence.ts',
                  side: 'head',
                  start: 1,
                  end: 1,
                  quote:
                    !['repaired', 'invalid'].includes(mode) || (mode === 'repaired' && requests > 1)
                      ? 'export const value = 1;'
                      : 'wrong quote',
                },
                supporting:
                  mode === 'supporting'
                    ? [
                        {
                          file: 'src/dependency.ts',
                          side: 'head',
                          start: 1,
                          end: 1,
                          quote: 'export const dependency = 1;',
                          relevance: 'caller dependency',
                        },
                      ]
                    : [],
              },
            },
          ],
        ),
        effectsFactory: () => repoEffects(repo),
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root, base, prepareEvidence: true, maxTokens: 5000 });
      expect(requests).toBe(mode === 'invalid' ? 3 : mode === 'repaired' ? 2 : 1);
      expect(result.status).toBe(mode === 'invalid' ? 'needs-human' : 'ok');
      const report = result.status === 'ok' ? result.value : result.report;
      expect(report?.findings[0]?.evidenceV1?.primary.quote).toBe(
        mode === 'invalid' ? 'wrong quote' : 'export const value = 1;',
      );
      expect(report?.findings[0]?.evidenceV1?.validation?.status).toBe(
        mode === 'invalid' ? 'invalid' : undefined,
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('opt-in evidence preparation invokes repair on the operation path and blocks missing evidence', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      await repo.write('src/evidence.ts', 'export const value = 1;\n');
      repo.commitAll('evidence fixture');
      const prompts: string[] = [];
      const result = await makeReviewRun({
        drivers: scriptedDrivers((input) => prompts.push(input.prompt)),
        effectsFactory: () => repoEffects(repo),
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root, prepareEvidence: true, maxTokens: 5000 });
      expect(result.status).toBe('needs-human');
      expect(prompts).toHaveLength(3);
      expect(prompts[0]).toContain('emit evidenceV1');
      expect(prompts[1]).toContain('Repair only the evidence');
      const report = result.status === 'ok' ? result.value : result.report;
      expect(report?.findings[0]?.text).toBe('seeded');
      expect(report?.sources.some((source) => source.status === 'blocked')).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('retains completed findings when an evidence repair throws', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      await repo.write('src/evidence.ts', 'export const value = 1;\n');
      repo.commitAll('evidence fixture');
      const prompts: string[] = [];
      const result = await makeReviewRun({
        drivers: scriptedDrivers((input) => {
          prompts.push(input.prompt);
          if (prompts.length === 2) throw new Error('repair transport failed');
        }),
        effectsFactory: () => repoEffects(repo),
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root, prepareEvidence: true, maxTokens: 5000 });
      expect(result.status).toBe('needs-human');
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toContain('emit evidenceV1');
      expect(prompts[1]).toContain('Repair only the evidence');
      const report = result.status === 'ok' ? result.value : result.report;
      expect(report?.findings[0]?.text).toBe('seeded');
      expect(report?.sources.some((source) => source.status === 'blocked')).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('maps a thrown evidence blob read to a failed result', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      await repo.write('src/evidence.ts', 'export const value = 1;\n');
      repo.commitAll('evidence fixture');
      const effects = repoEffects(repo, (command, args) => {
        // A spawn fault or an oversized blob rejects instead of exiting non-zero.
        if (command === 'git' && args[0] === 'show') throw new Error('git show buffer exceeded');
        return undefined;
      });
      const requested: string[] = [];
      const result = await makeReviewRun({
        drivers: scriptedDrivers((input) => requested.push(input.prompt)),
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root, prepareEvidence: true, maxTokens: 5000 });
      expect(result.status).toBe('failed');
      if (result.status === 'failed')
        expect(result.error).toContain('could not read evidence background');
      expect(requested).toHaveLength(0);
    } finally {
      await repo.cleanup();
    }
  });

  it('maps a supporting-evidence load fault to needs-human instead of rejecting', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      await repo.write('src/dependency.ts', 'export const dependency = 1;\n');
      repo.commitAll('dependency baseline');
      const base = repo.git('rev-parse', 'HEAD').trim();
      await repo.write('src/evidence.ts', 'export const value = 1;\n');
      repo.commitAll('evidence fixture');
      const effects = repoEffects(repo, (command, args) => {
        if (command === 'git' && args[0] === 'show' && args[1] === `${base}:src/dependency.ts`)
          throw new Error('git show buffer exceeded');
        return undefined;
      });
      const result = await makeReviewRun({
        drivers: scriptedDrivers(undefined, 0, () => [
          {
            file: 'src/evidence.ts',
            line: 1,
            severity: 'high',
            text: 'seeded',
            evidenceV1: {
              version: 1,
              failureScenario: 'seeded scenario',
              primary: {
                file: 'src/evidence.ts',
                side: 'head',
                start: 1,
                end: 1,
                quote: 'export const value = 1;',
              },
              supporting: [
                {
                  file: 'src/dependency.ts',
                  side: 'head',
                  start: 1,
                  end: 1,
                  quote: 'export const dependency = 1;',
                  relevance: 'caller dependency',
                },
              ],
            },
          },
        ]),
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root, base, prepareEvidence: true, maxTokens: 5000 });
      expect(result.status).toBe('needs-human');
      const report = result.status === 'ok' ? result.value : result.report;
      expect(report?.sources.find((source) => source.kind === 'agent')?.reason).toContain(
        'git show buffer exceeded',
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('stops all repair dispatch after a provider refusal and retains both findings', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      await repo.write('src/evidence.ts', 'export const value = 1;\n');
      repo.commitAll('evidence fixture');
      const prompts: string[] = [];
      const result = await makeReviewRun({
        drivers: scriptedDrivers(
          () => {
            prompts.push('request');
          },
          0,
          () => [
            { severity: 'high', text: 'first' },
            { severity: 'medium', text: 'second' },
          ],
          () => (prompts.length === 1 ? 'complete' : 'error'),
        ),
        effectsFactory: () => repoEffects(repo),
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root, prepareEvidence: true, maxTokens: 5000 });
      expect(result.status).toBe('needs-human');
      expect(prompts).toHaveLength(2);
      const report = result.status === 'ok' ? result.value : result.report;
      expect(report?.findings.map((finding) => finding.text)).toEqual(['first', 'second']);
      expect(report?.sources[0]?.reason).toContain('provider quota refused');
      expect(report?.sources.some((source) => source.status === 'blocked')).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });
});
