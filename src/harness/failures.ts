import { z } from 'zod';
import { messageOf } from '../shared/messageOf.js';

/** Shared model-visible error codes and new session failure kinds. */
export const TOOL_FAILURE_KINDS = [
  'FS_NOT_FOUND',
  'FS_NOT_READ',
  'FS_STALE',
  'FS_UNSUPPORTED',
  'EDIT_NO_MATCH',
  'EDIT_AMBIGUOUS',
  'PATH_ESCAPE',
  'PATH_DENIED',
  'INPUT_INVALID',
  'SEARCH_INVALID_PATTERN',
  'SEARCH_LIMIT',
  'CMD_DENIED',
  'TIMEOUT',
  'CANCELLED',
  'UNSUPPORTED',
  'UNKNOWN_TOOL',
  'EXECUTION_ERROR',
  'FINAL_STEP',
  'REPAIR_STEP',
] as const;

export type ToolFailureKind = (typeof TOOL_FAILURE_KINDS)[number];

/** SDK errors can wrap our error text; recover the stable code inside it. */
export function toolFailureKind(text: string, fallback: ToolFailureKind): ToolFailureKind {
  const prefix = TOOL_FAILURE_KINDS.find((kind) => text.startsWith(`${kind}: `));
  if (prefix !== undefined) return prefix;
  const wrapped = text.match(new RegExp(`\\b(${TOOL_FAILURE_KINDS.join('|')}): `));
  return wrapped === null ? fallback : (wrapped[1] as ToolFailureKind);
}

export function invalidToolInput(error: unknown): string {
  if (!(error instanceof z.ZodError)) return `INPUT_INVALID: ${messageOf(error)}`;
  const unsupported = error.issues.find((issue) => issue.message.startsWith('UNSUPPORTED: '));
  if (unsupported !== undefined) return unsupported.message;
  return `INPUT_INVALID: invalid input: ${error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ')}`;
}
