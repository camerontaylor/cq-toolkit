import type { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SnapshotConfigError } from '../../dev/internal/snapshot.js';
import type { Op } from '../../../kernel/types.js';
import { messageOf } from '../../../shared/messageOf.js';
import {
  makeReviewClient,
  QueueUnsupported,
  QueueConfigurationError,
  ReviewRemoteError,
  ReviewInputError,
  makeConfiguredReviewClient,
} from './queueClient.js';
import type { QueueTransport } from './queueProtocol.js';

export type ReviewClient = ReturnType<typeof makeReviewClient>;
export const git = async (cwd: string, ...args: string[]) =>
  (
    await promisify(execFile)('git', ['--no-replace-objects', ...args], {
      cwd,
      timeout: 30000,
      maxBuffer: 6 * 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? '',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    })
  ).stdout.trim();
export function reviewOp<S extends z.ZodType, O>(
  schema: S,
  fn: (input: z.output<S>, client: () => ReviewClient) => Promise<O>,
  transport?: QueueTransport,
): Op<z.input<S>, O | { state: 'unsupported'; reason: string }> {
  return async (raw) => {
    let input: z.output<S>;
    try {
      input = schema.parse(raw);
    } catch (error) {
      return { status: 'failed', error: messageOf(error) };
    }
    let client: ReviewClient | undefined;
    const getClient = () => {
      return (client ??= transport ? makeReviewClient(transport) : makeConfiguredReviewClient());
    };
    try {
      return { status: 'ok', value: await fn(input, getClient) };
    } catch (error) {
      if (error instanceof QueueUnsupported)
        return { status: 'ok', value: { state: 'unsupported', reason: error.message } };
      if (error instanceof QueueConfigurationError || error instanceof SnapshotConfigError)
        return { status: 'needs-human', reason: error.message };
      if (
        error instanceof ReviewInputError ||
        !client ||
        (error instanceof ReviewRemoteError &&
          (!error.remote.retryable || error.remote.code === 'busy'))
      )
        return { status: 'failed', error: messageOf(error) };
      return { status: 'indeterminate', detail: messageOf(error) };
    }
  };
}
export async function headMessage(cwd: string, reviewed: string) {
  let current: string;
  try {
    current = await git(cwd, 'rev-parse', 'HEAD');
  } catch {
    return `Reviewed head ${reviewed}; current HEAD is unavailable.`;
  }
  return current === reviewed
    ? undefined
    : `Reviewed head ${reviewed}; current HEAD is ${current}.`;
}

export const evidenceRoot = async (cwd: string) => git(cwd, 'rev-parse', '--show-toplevel');
