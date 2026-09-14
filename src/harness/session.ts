// JSONL session records — T1.4 slice 1 (OUR vocabulary, I6 semantics).
//
// Session state is PLAIN DATA in OUR OWN shapes — SessionRecord/
// SessionMessage below, never vendor message vocabulary — persisted as one
// JSONL file per session under the store directory, mirroring the kernel
// journal's crash-tolerance rules (schema-validated lines appended through a
// serialized write chain; torn-tail tolerated; a corrupt MIDDLE line throws,
// because a hole in the middle of the evidence is corruption, not a torn
// write).
//
// I6 CONTRACT this store enables (context never leaks between workers):
//   - A FRESH invocation (no OpInvocation.sessionRef) shares NOTHING with a
//     previous one: the caller creates a fresh scratch directory
//     (`tempWorkspace`) and a fresh record in it (`SessionStore.create`) —
//     zero messages, a workspace no prior invocation ever touched. Isolation
//     is structural: a fresh record starts empty, and a workspace fresh from
//     mkdtemp collides with nothing.
//   - `sessionRef` is a sessionId previously handed out by `create` (and
//     surfaced to callers as WorkerResult.sessionId): the caller `load`s the
//     record and re-uses BOTH its messages AND its workspace. Resumption is
//     explicit and record-mediated — a session that was never created cannot
//     be loaded (`load` yields undefined), so nothing resumes by accident.
//
// FILE FORMAT (`<sessionsDir>/<sessionId>.jsonl`, one validated JSON object
// per line, discriminated on `type`):
//   line 1:   { type: 'session', sessionId, createdAt, workspace }  (header)
//   lines 2+: { type: 'message', message: SessionMessage }
// Every line is validated against its schema BEFORE it hits disk (an invalid
// record is a loud error, not silent evidence rot). `load` folds the lines
// into a SessionRecord: the header line supplies identity facts, message
// lines append in order — the file is the source of truth, the record is the
// fold (same posture as the kernel journal).
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shapes — plain data, our vocabulary
// ---------------------------------------------------------------------------

/**
 * One conversation turn, in OUR vocabulary: who spoke (`role`), the text
 * (`content`), the tool that produced it when role is 'tool' (`toolName`),
 * and an ISO-8601 timestamp (`at`).
 */
export const SessionMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.string(),
  toolName: z.string().optional(),
  at: z.string(),
}).strict();

/**
 * One recorded session: identity (`sessionId`), creation time
 * (`createdAt`, ISO-8601), the workspace directory its tool calls ran in
 * (`workspace`, absolute), and the message history in order. Everything a
 * resumed invocation re-uses — and everything a fresh invocation starts
 * without (I6).
 */
export const SessionRecordSchema = z.object({
  sessionId: z.string(),
  createdAt: z.string(),
  workspace: z.string(),
  messages: z.array(SessionMessageSchema),
}).strict();

export type SessionMessage = z.infer<typeof SessionMessageSchema>;
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

// JSONL line shapes (the persisted source of truth; the record above is the
// read-time fold, like the kernel journal's derived status).

export const SessionHeaderLineSchema = z.object({
  type: z.literal('session'),
  sessionId: z.string(),
  createdAt: z.string(),
  workspace: z.string(),
}).strict();

export const SessionMessageLineSchema = z.object({
  type: z.literal('message'),
  message: SessionMessageSchema,
}).strict();

export const SessionLineSchema = z.discriminatedUnion('type', [
  SessionHeaderLineSchema,
  SessionMessageLineSchema,
]);

export type SessionHeaderLine = z.infer<typeof SessionHeaderLineSchema>;
export type SessionMessageLine = z.infer<typeof SessionMessageLineSchema>;
export type SessionLine = z.infer<typeof SessionLineSchema>;

/**
 * Filesystem-safe sessionId: 1+ chars of [A-Za-z0-9._-], starting
 * alphanumeric — same rules as the journal's runId, because a sessionId is
 * used verbatim as `<sessionId>.jsonl` with no escaping.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Throws unless `sessionId` is filesystem-safe (see SESSION_ID_PATTERN). */
export function assertSafeSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(
      `session: sessionId must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (no slashes, not empty): '${sessionId}'`,
    );
  }
}

// ---------------------------------------------------------------------------
// SessionStore — dir-backed, crash-tolerant appends
// ---------------------------------------------------------------------------

/**
 * Directory-backed session store: one `<sessionId>.jsonl` per session under
 * `sessionsDir` (absolute recommended). Appends are serialized through an
 * internal write chain (lines never interleave, land in append-call order;
 * a failed write does not poison the chain) — the same discipline as the
 * kernel journal. All async, all plain data in and out.
 */
export class SessionStore {
  /** Write chain: each append waits for the previous one. */
  private tail: Promise<void> = Promise.resolve();

  constructor(readonly sessionsDir: string) {}

  private pathFor(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.jsonl`);
  }

  /**
   * Create a fresh session record in `workspace` (absolute recommended) and
   * persist its header line. The FRESH-INVOCATION path (I6): empty messages,
   * a workspace the caller obtained from `tempWorkspace` — nothing is shared
   * with any prior session. Returns the record (its `sessionId` is the
   * OpInvocation.sessionRef / WorkerResult.sessionId handle for later
   * resumption).
   */
  async create(workspace: string): Promise<SessionRecord> {
    const sessionId = `ses-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
    assertSafeSessionId(sessionId);
    const createdAt = new Date().toISOString();
    // Validate BEFORE writing: the file only ever contains lines that parse.
    const line: SessionHeaderLine = SessionHeaderLineSchema.parse({
      type: 'session',
      sessionId,
      createdAt,
      workspace,
    });
    await mkdir(this.sessionsDir, { recursive: true });
    await appendFile(this.pathFor(sessionId), `${JSON.stringify(line)}\n`, 'utf8');
    return { sessionId, createdAt, workspace, messages: [] };
  }

  /**
   * Append one message to `<sessionId>.jsonl`. Validates the message against
   * SessionMessageSchema BEFORE disk (invalid messages are loud errors) and
   * refuses unknown sessions — appending never fabricates a session. Single-
   * writer discipline applies (same as the journal): one writer per store.
   */
  async appendMessage(sessionId: string, message: SessionMessage): Promise<void> {
    assertSafeSessionId(sessionId);
    const parsed: SessionMessage = SessionMessageSchema.parse(message);
    try {
      await stat(this.pathFor(sessionId));
    } catch {
      throw new Error(
        `session: unknown sessionId '${sessionId}' — create() the session before appending`,
      );
    }
    const line: SessionMessageLine = { type: 'message', message: parsed };
    const write = async (): Promise<void> => {
      await mkdir(this.sessionsDir, { recursive: true });
      await appendFile(this.pathFor(sessionId), `${JSON.stringify(line)}\n`, 'utf8');
    };
    const next = this.tail.then(write, write);
    this.tail = next.catch(() => undefined);
    await next;
  }

  /**
   * Load a session by id: `undefined` when no record exists (unknown
   * sessionRef — a fresh invocation must be started instead of a fake
   * resume). A torn LAST line is ignored (crash mid-append); an unparsable
   * MIDDLE line throws (evidence corruption); a header whose sessionId
   * disagrees with the file it sits in throws (the journal's
   * identity-match rule). Only a torn HEADER (create() crashed before the
   * first byte) yields `undefined` — that session never existed.
   */
  async load(sessionId: string): Promise<SessionRecord | undefined> {
    assertSafeSessionId(sessionId);
    let raw: string;
    try {
      raw = await readFile(this.pathFor(sessionId), 'utf8');
    } catch (err) {
      if (isEnoent(err)) return undefined; // no record for this sessionId
      throw err;
    }
    if (raw === '') return undefined; // create() crashed before the header landed
    const lines = raw.split('\n');
    if (lines[lines.length - 1] === '') {
      lines.pop(); // file ended with a complete newline; the '' split artifact is not a line
    }
    let header: SessionHeaderLine | undefined;
    const messages: SessionMessage[] = [];
    for (let i = 0; i < lines.length; i++) {
      const parsed = parseLine(lines[i]);
      if (parsed === null) {
        if (i === lines.length - 1) {
          break; // torn tail: crash mid-append, only the LAST line may be lost
        }
        throw new Error(
          `session: corrupt line ${i + 1} of ${this.pathFor(sessionId)} — middle lines must be ` +
            'valid session lines (only a trailing torn line is tolerated)',
        );
      }
      if (parsed.type === 'session') {
        if (header !== undefined) {
          throw new Error(`session: duplicate header at line ${i + 1} of ${this.pathFor(sessionId)}`);
        }
        if (parsed.sessionId !== sessionId) {
          throw new Error(
            `session: header sessionId '${parsed.sessionId}' does not match requested session '${sessionId}'`,
          );
        }
        header = parsed;
      } else {
        if (header === undefined) {
          throw new Error(
            `session: message before header at line ${i + 1} of ${this.pathFor(sessionId)}`,
          );
        }
        messages.push(parsed.message);
      }
    }
    if (header === undefined) return undefined; // only a torn header — never a real session
    return { sessionId: header.sessionId, createdAt: header.createdAt, workspace: header.workspace, messages };
  }
}

// ---------------------------------------------------------------------------
// Fresh workspaces — the other half of the I6 fresh-invocation path
// ---------------------------------------------------------------------------

/**
 * Create a FRESH scratch workspace: `mkdtemp` under `root` (the harness
 * config's `workspaceRoot`; omitted → the harness default
 * `os.tmpdir()/cq-harness`). Returns the absolute directory. Paired with
 * `SessionStore.create` for fresh invocations (I6): a directory fresh from
 * mkdtemp is structurally shared with nothing.
 */
export async function tempWorkspace(root?: string): Promise<string> {
  const base = root ?? join(tmpdir(), 'cq-harness');
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, 'ws-'));
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

/** Parse one session line: JSON.parse then SessionLineSchema; null when either fails. */
function parseLine(line: string): SessionLine | null {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return null;
  }
  const result = SessionLineSchema.safeParse(data);
  return result.success ? result.data : null;
}
