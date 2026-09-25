import { describe, expect, test } from 'vitest';
import { classifyThreads } from '../../../src/ops/review/classifyThreads.js';
import { classifyPr } from '../../../src/ops/merge/classifyPrs.js';
import { defaultClassifyConfig } from '../../../src/ops/review/classify.config.js';
import { defaultClassifyPrConfig } from '../../../src/ops/merge/classify.config.js';
import type { FetchedReviewState } from '../../../src/ops/review/fetchReviewState.js';
import type { PrCandidate } from '../../../src/ops/merge/classifyPrs.js';
import {
  registry as mergeRegistry,
  ClassifyPrsInputSchema,
} from '../../../src/ops/merge/registry.js';

const NOW = Date.parse('2026-09-26T00:10:00Z');
const HEAD = 'a'.repeat(40);
const LAST_COMMIT = '2026-09-26T00:00:00Z';

const thread = (path: string | null, body = 'Please fix this') => ({
  id: path ?? 'whole',
  rootDatabaseId: 1,
  path,
  line: 1,
  isResolved: false,
  isOutdated: false,
  authorLogin: 'reviewer',
  createdAt: LAST_COMMIT,
  body,
  replies: [],
});

const state = (
  threads: FetchedReviewState['threads'],
  claimedPaths?: string[],
): FetchedReviewState => ({
  repo: { owner: 'octo', name: 'repo' },
  pr: 1,
  authorLogin: 'author',
  headRefName: 'topic',
  headRefOid: HEAD,
  threads,
  reviews: [],
  restReviewComments: [],
  restIssueComments: [],
  truncated: false,
  truncatedBecause: [],
  ...(claimedPaths === undefined ? {} : { claimedPaths }),
});

const review = (
  authorLogin: string,
  stateName: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED',
  commitOid: string,
) => ({
  id: authorLogin,
  authorLogin,
  state: stateName,
  body: '',
  submittedAt: '2026-09-26T00:05:00Z',
  authorAssociation: 'MEMBER',
  commitOid,
});

const candidate = (reviews: PrCandidate['reviews']): PrCandidate => ({
  pr: 1,
  authorLogin: 'author',
  draft: false,
  mergeState: 'CLEAN',
  truncated: false,
  threads: [],
  reviews,
  issueComments: [],
  lastCommitAt: LAST_COMMIT,
  headRefOid: HEAD,
});

describe('W1.1 reviewer trust and SHA binding', () => {
  test('folds latest opinion per actor and excludes author, automation, and stale heads', () => {
    const config = {
      ...defaultClassifyPrConfig,
      trustedBots: ['trusted[bot]'],
      trustedAssociations: ['MEMBER'],
      automationLogin: 'cq-automation[bot]',
    };
    const result = classifyPr(
      candidate([
        review('trusted[bot]', 'APPROVED', HEAD),
        review('author', 'APPROVED', HEAD),
        review('cq-automation[bot]', 'APPROVED', HEAD),
        review('stale', 'APPROVED', 'b'.repeat(40)),
      ]),
      NOW,
      config,
    );
    expect(result.verdict).toBe('eligible');
    expect(result.reason).toBe('settle_window_elapsed');
  });

  test('the shipped merge registry rejects an untrusted bot approval', async () => {
    const input = ClassifyPrsInputSchema.parse({
      candidate: candidate([review('coderabbitai[bot]', 'APPROVED', HEAD)]),
      nowMs: NOW,
      config: { trustedAssociations: [], automationLogin: 'cq-automation[bot]' },
    });
    const entry = mergeRegistry.find((item) => item.name === 'merge.classifyPrs');
    if (entry?.importer === undefined) throw new Error('merge.classifyPrs registry entry missing');
    const operation = await entry.importer();
    const result = await operation(input);
    expect(result).toMatchObject({ status: 'ok', value: { reason: 'no_acceptable_review' } });
  });

  test('a stale approval cannot grant acceptance', () => {
    const result = classifyPr(candidate([review('member', 'APPROVED', 'b'.repeat(40))]), NOW, {
      ...defaultClassifyPrConfig,
      trustedAssociations: ['MEMBER'],
    });
    expect(result.reason).toBe('no_acceptable_review');
  });

  test('a later COMMENTED review does not mask a standing objection', () => {
    const result = classifyPr(
      candidate([
        { ...review('member', 'CHANGES_REQUESTED', HEAD), submittedAt: '2026-09-26T00:01:00Z' },
        { ...review('member', 'COMMENTED', HEAD), submittedAt: '2026-09-26T00:09:00Z' },
      ]),
      NOW,
      { ...defaultClassifyPrConfig, trustedAssociations: ['MEMBER'] },
    );
    expect(result.reason).toBe('merge_objection_outstanding');
  });

  test('a trusted human objection is not suppressed by a bot-shaped skip body', () => {
    const result = classifyPr(
      candidate([
        {
          ...review('member', 'CHANGES_REQUESTED', HEAD),
          body: 'CodeRabbit skipped this run',
          authorAssociation: 'MEMBER',
        },
      ]),
      NOW,
      {
        ...defaultClassifyPrConfig,
        trustedAssociations: ['MEMBER'],
        automationLogin: 'cq-automation[bot]',
      },
    );
    expect(result.reason).toBe('merge_objection_outstanding');
  });

  test('a later approval from the same actor withdraws the objection', () => {
    const result = classifyPr(
      candidate([
        { ...review('member', 'CHANGES_REQUESTED', HEAD), submittedAt: '2026-09-26T00:01:00Z' },
        { ...review('member', 'APPROVED', HEAD), submittedAt: '2026-09-26T00:09:00Z' },
      ]),
      NOW,
      { ...defaultClassifyPrConfig, trustedAssociations: ['MEMBER'] },
    );
    expect(result.reason).toBe('settle_window_elapsed');
  });

  test('an excluded login is rejected even without a trust allowlist', () => {
    const result = classifyPr(candidate([review('outsider', 'APPROVED', HEAD)]), NOW, {
      ...defaultClassifyPrConfig,
      excludedLogins: ['outsider'],
    });
    expect(result.reason).toBe('no_acceptable_review');
  });

  test('a null head SHA fails closed when SHA evidence is explicitly present', () => {
    const result = classifyPr(
      { ...candidate([review('member', 'APPROVED', HEAD)]), headRefOid: null },
      NOW,
      { ...defaultClassifyPrConfig, trustedAssociations: ['MEMBER'] },
    );
    expect(result.reason).toBe('no_acceptable_review');
  });

  describe.each([
    { context: 'default', config: defaultClassifyPrConfig },
    {
      context: 'trusted policy',
      config: { ...defaultClassifyPrConfig, trustedAssociations: ['MEMBER'] },
    },
  ])('$context head-SHA acceptance', ({ config }) => {
    test('null head and null review commit cannot supply acceptance', () => {
      const result = classifyPr(
        {
          ...candidate([{ ...review('member', 'APPROVED', HEAD), commitOid: null }]),
          headRefOid: null,
        },
        NOW,
        config,
      );
      expect(result).toMatchObject({ verdict: 'awaiting', reason: 'no_acceptable_review' });
    });

    test('an omitted head preserves legacy acceptance without a review commit', () => {
      const legacy = candidate([{ ...review('member', 'APPROVED', HEAD), commitOid: null }]);
      delete legacy.headRefOid;
      const result = classifyPr(legacy, NOW, config);
      expect(result).toMatchObject({ verdict: 'eligible', reason: 'settle_window_elapsed' });
    });

    test('a known matching head still supplies acceptance', () => {
      const result = classifyPr(candidate([review('member', 'APPROVED', HEAD)]), NOW, config);
      expect(result).toMatchObject({ verdict: 'eligible', reason: 'settle_window_elapsed' });
    });
  });
});

describe('W1.3 path anchoring and untrusted input', () => {
  test('path-anchored thread outside claimed commits is blocked', () => {
    const result = classifyThreads(state([thread('src/other.ts')], ['src/touched.ts']), NOW, {
      ...defaultClassifyConfig,
      trustedAuthors: ['reviewer'],
      automationLogin: 'cq-automation[bot]',
    });
    expect(result.items[0]).toMatchObject({ verdict: 'blocked', reason: 'path_anchor_mismatch' });
  });

  test('untrusted review is never actionable', () => {
    const untrusted = state([]);
    untrusted.reviews = [{ ...review('outsider', 'CHANGES_REQUESTED', HEAD), authorType: 'User' }];
    const result = classifyThreads(untrusted, NOW, {
      ...defaultClassifyConfig,
      trustedAuthors: ['member'],
      automationLogin: 'cq-automation[bot]',
    });
    expect(result.items[0]).toMatchObject({ verdict: 'blocked', reason: 'untrusted_reviewer' });
  });
});
