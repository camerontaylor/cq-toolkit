// Versioned, procedural delivery around the existing promotion gate. No gate
// judgment is implemented here. Run only from an owner-qualified trust artifact.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ghJson, makeGhRunner } from '../adapters/forge-github/gh.js';
import { gitLsRemoteRef } from '../adapters/git/ratchetGit.js';
import { resolveProtectedPathsConfig } from '../ops/gates/policyConfig.js';
import { createPolicyDiff } from '../ops/gates/policyDiff.js';
import { judgeAcceptance, resolveAcceptanceTrust, type AcceptanceResult } from './acceptance.js';
import type { TrustPolicy } from './merge-recheck.js';
import { SETTLE_STATE_PATH } from './config.js';
import {
  MAIN_BRANCH,
  PROMOTED_REF,
  PROMOTE_TOKEN_ENV,
  parseGateArgs,
  realGateGit,
  remoteUrlFor,
  runGate,
  type GateConfig,
  type GateDeps,
  type VerifiedRunEvidence,
} from './promote-gate.js';

type Source = { commit: string; tree: string; artifactSha256: string };
type State =
  | 'PREPARED'
  | 'PUSH_CONFIRMED'
  | 'AWAITING_AUDIT'
  | 'ACK_CONFIRMED'
  | 'AUDIT_VERIFIED'
  | 'UNKNOWN';
type Operation = {
  id: string;
  repositoryId: number;
  from: string;
  to: string;
  after: string;
  source: Source;
  state: State;
  reason: string;
  auditAt: string | null;
  ci: VerifiedRunEvidence[];
  acceptance: AcceptanceResult[];
  digest: string;
};
type Journal = { schema: 1; repositoryId: number; operations: Operation[] };
export interface ControllerStore {
  /** Exclusive lease; a crashed owner leaves a lock for bounded manual reconciliation. */
  acquire(): () => void;
  read(): unknown;
  write(journal: unknown): void;
}
export interface ControllerDeps {
  gate: GateDeps;
  store: ControllerStore;
  /** Fresh refs from the same remote the gate pushes to. */
  refs(): Promise<{ main: string; promoted: string }>;
  /** Checked command transport only, not an acceptance or promotion authority. */
  crq(args: readonly string[]): Promise<{ code: number; stdout: string }>;
  nowMs(): number;
  id(): string;
}
export type ControllerResult = {
  state: 'idle' | 'pending' | 'held' | 'complete';
  operation?: string;
};
/** Narrow only: retain the existing strict marker opt-in and all actor exclusions. */
export function controllerAcceptancePolicy(env: NodeJS.ProcessEnv): TrustPolicy {
  const { policy } = resolveAcceptanceTrust(env);
  return {
    ...policy,
    trustedBots: new Set<string>(),
    acceptStates: new Set<'APPROVED'>(['APPROVED']),
  };
}
const sha = /^[0-9a-f]{40}$/;
const digest = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const copy = <T>(v: T): T => structuredClone(v);
const terminal = (s: State): boolean => s === 'ACK_CONFIRMED' || s === 'AUDIT_VERIFIED';
const obj = (v: unknown): Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('invalid object');
  return v as Record<string, unknown>;
};
const utc = (v: unknown): number => {
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(v))
    throw new Error('invalid UTC seconds');
  const ms = Date.parse(v);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().replace('.000Z', 'Z') !== v)
    throw new Error('invalid date');
  return ms;
};
const sealed = (operation: Omit<Operation, 'digest'> | Operation): Operation => {
  const { digest: _old, ...body } = operation as Operation;
  return { ...body, digest: digest(body) };
};

/** Atomic replacement and file+directory fsync before returning success. */
export function journalStore(directory: string): ControllerStore {
  const dir = resolve(directory);
  const syncDir = (): void => {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  return {
    acquire: () => {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = resolve(dir, 'controller.lock');
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(fd, 'exclusive promotion controller\n');
        fsyncSync(fd);
        syncDir();
      } catch (error) {
        closeSync(fd);
        throw error;
      }
      return () => {
        closeSync(fd);
        unlinkSync(path);
        syncDir();
      };
    },
    read: () => {
      try {
        return JSON.parse(readFileSync(resolve(dir, 'journal.json'), 'utf8')) as unknown;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    write: (journal) => {
      const temp = resolve(dir, `journal-${randomUUID()}.tmp`);
      const fd = openSync(temp, 'wx', 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(journal)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, resolve(dir, 'journal.json'));
      syncDir();
    },
  };
}

function readJournal(raw: unknown, repositoryId: number): Journal {
  if (raw === null) return { schema: 1, repositoryId, operations: [] };
  const j = obj(raw);
  if (j['schema'] !== 1 || j['repositoryId'] !== repositoryId || !Array.isArray(j['operations']))
    throw new Error('foreign journal');
  const journal = copy(j) as unknown as Journal;
  for (const op of journal.operations) {
    if (
      op.repositoryId !== repositoryId ||
      op.digest !== sealed(op).digest ||
      !sha.test(op.from) ||
      !sha.test(op.to) ||
      ![
        'PREPARED',
        'PUSH_CONFIRMED',
        'AWAITING_AUDIT',
        'ACK_CONFIRMED',
        'AUDIT_VERIFIED',
        'UNKNOWN',
      ].includes(op.state) ||
      !/^[0-9a-f-]{36}$/.test(op.id) ||
      op.reason !== `controller-${op.id}-source-${op.source.commit}`
    )
      throw new Error('invalid operation');
    utc(op.after);
  }
  if (journal.operations.some((op, n) => n < journal.operations.length - 1 && !terminal(op.state)))
    throw new Error('multiple outstanding operations');
  return journal;
}

function observation(
  raw: unknown,
  op: Operation,
  now: number,
): { status: string; at: string | null; ack: unknown; acked: unknown } {
  const r = obj(raw);
  if (r['schema'] !== 1 || r['from'] !== op.from || r['to'] !== op.to || r['after'] !== op.after)
    throw new Error('foreign observation');
  if (['absent', 'ambiguous', 'unknown'].includes(String(r['status'])))
    return { status: String(r['status']), at: null, ack: null, acked: null };
  const record = obj(r['record']);
  if (
    record['from'] !== op.from ||
    record['to'] !== op.to ||
    utc(record['at']) < utc(op.after) ||
    utc(record['at']) > now
  )
    throw new Error('stale observation');
  const at = String(record['at']);
  if (op.auditAt !== null && op.auditAt !== at) throw new Error('audit identity changed');
  if (
    r['status'] === 'verified' &&
    record['verdict'] === 'verified' &&
    !Object.hasOwn(r, 'alert') &&
    !record['acknowledgement']
  ) {
    return { status: 'verified', at, ack: null, acked: null };
  }
  const alert = obj(r['alert']);
  if (
    r['status'] !== 'unverified' ||
    record['verdict'] !== 'UNVERIFIED' ||
    alert['from'] !== op.from ||
    alert['to'] !== op.to ||
    alert['at'] !== at ||
    JSON.stringify(record['acknowledgement'] ?? null) !==
      JSON.stringify(alert['acknowledgement'] ?? null)
  )
    throw new Error('inconsistent observation');
  return {
    status: 'unverified',
    at,
    ack: record['acknowledgement'] ?? null,
    acked: alert['acked'] ?? null,
  };
}

function ackMatches(value: ReturnType<typeof observation>, op: Operation, now: number): boolean {
  const receipt = obj(value.ack);
  return (
    value.status === 'unverified' &&
    Object.keys(receipt).sort().join(',') === 'acknowledged_at,audit_at,from,reason,to' &&
    receipt['from'] === op.from &&
    receipt['to'] === op.to &&
    receipt['audit_at'] === op.auditAt &&
    receipt['reason'] === op.reason &&
    utc(receipt['acknowledged_at']) >= utc(op.auditAt) &&
    utc(receipt['acknowledged_at']) <= now &&
    value.acked === `${String(receipt['acknowledged_at'])} ${op.reason}`
  );
}

/** One bounded invocation. No timers, retries of pushes, historical migration or ack authority. */
export async function runController(
  deps: ControllerDeps,
  cfg: GateConfig,
  source: Source,
): Promise<ControllerResult> {
  let release: (() => void) | undefined;
  try {
    release = deps.store.acquire();
    if (
      !sha.test(source.commit) ||
      !sha.test(source.tree) ||
      !/^[0-9a-f]{64}$/.test(source.artifactSha256) ||
      source.commit !== cfg.trustRef
    )
      throw new Error('unqualified source');
    const journal = readJournal(deps.store.read(), cfg.repositoryId);
    let op = journal.operations.at(-1);
    if (!cfg.push && op !== undefined && !terminal(op.state))
      return { state: 'held', operation: op.id };
    const persist = (next: Operation): void => {
      const value = sealed(next);
      const index = journal.operations.findIndex((item) => item.id === value.id);
      if (index < 0) journal.operations.push(value);
      else journal.operations[index] = value;
      deps.store.write(copy(journal));
      op = value;
    };
    if (op !== undefined && !terminal(op.state)) {
      if (digest(op.source) !== digest(source))
        throw new Error('outstanding operation belongs to another artifact');
      if (op.state === 'UNKNOWN') return { state: 'held', operation: op.id };
      if (op.state === 'PREPARED') {
        persist({ ...op, state: 'UNKNOWN' });
        return { state: 'held', operation: op.id };
      }
    } else {
      op = undefined;
      const ci: VerifiedRunEvidence[] = [];
      const acceptance = new Map<number, AcceptanceResult>();
      const original = deps.gate;
      const result = await runGate(
        {
          ...original,
          acceptance: async (input) => {
            const judged = await original.acceptance(input);
            if (
              judged.verdict === 'pass' &&
              judged.pr === input.pr &&
              judged.subject === input.subject &&
              judged.acceptedBy.length > 0
            )
              acceptance.set(input.pr, copy(judged));
            else acceptance.delete(input.pr);
            return judged;
          },
          onVerifiedRun: async (item) => {
            await original.onVerifiedRun?.(item);
            ci.push(copy(item));
          },
          git: {
            ...original.git,
            pushAtomic: async (repo, url, updates, token) => {
              if (
                op !== undefined ||
                ci.length !== cfg.verifiedWorkflows.length ||
                acceptance.size === 0
              )
                throw new Error('missing final evidence');
              const main = updates.find((u) => u.refspec.endsWith(`:refs/heads/${MAIN_BRANCH}`));
              const to = main?.refspec.split(':')[0] ?? '';
              const from = main?.expected ?? '';
              if (
                !sha.test(from) ||
                !sha.test(to) ||
                ci.some(
                  (e) =>
                    e.from !== from ||
                    e.subject !== to ||
                    e.repositoryId !== cfg.repositoryId ||
                    e.phase !== 'final-recheck' ||
                    !cfg.verifiedWorkflows.includes(e.workflow),
                ) ||
                new Set(ci.map((e) => e.workflow)).size !== cfg.verifiedWorkflows.length
              )
                throw new Error('unbound final evidence');
              const id = deps.id();
              if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('invalid operation ID');
              const after = new Date(Math.ceil(deps.nowMs() / 1000) * 1000)
                .toISOString()
                .replace('.000Z', 'Z');
              persist(
                sealed({
                  id,
                  repositoryId: cfg.repositoryId,
                  from,
                  to,
                  after,
                  source: copy(source),
                  state: 'PREPARED',
                  reason: `controller-${id}-source-${source.commit}`,
                  auditAt: null,
                  ci: copy(ci),
                  acceptance: [...acceptance.values()].map(copy),
                }),
              );
              let pushed;
              try {
                pushed = await original.git.pushAtomic(repo, url, updates, token);
              } catch {
                persist({ ...op!, state: 'UNKNOWN' });
                throw new Error('unknown push result');
              }
              if (!pushed.ok) {
                persist({ ...op!, state: 'UNKNOWN' });
                return pushed;
              }
              const refs = await deps.refs();
              if (refs.main !== to || refs.promoted !== to) {
                persist({ ...op!, state: 'UNKNOWN' });
                throw new Error('push refs unconfirmed');
              }
              persist({ ...op!, state: 'PUSH_CONFIRMED' });
              return pushed;
            },
          },
        },
        cfg,
      );
      if (op === undefined)
        return {
          state: result.verdict === 'noop' || result.verdict === 'would-promote' ? 'idle' : 'held',
        };
      const prepared = op as Operation;
      if (
        result.verdict !== 'promoted' ||
        prepared.state !== 'PUSH_CONFIRMED' ||
        result.main !== prepared.from ||
        result.subject !== prepared.to
      )
        return { state: 'held', operation: prepared.id };
    }
    // Only the durable same-operation push confirmation authorizes observation.
    const current = op as Operation;
    const refs = await deps.refs();
    if (refs.main !== current.to || refs.promoted !== current.to)
      return { state: 'held', operation: current.id };
    persist({ ...current, state: 'AWAITING_AUDIT' });
    if (utc(current.after) > deps.nowMs()) return { state: 'pending', operation: current.id };
    const args = [
      'promotion-audit-observe',
      '--audit-from',
      current.from,
      '--to',
      current.to,
      '--after',
      current.after,
    ];
    const read = async () => {
      const response = await deps.crq(args);
      if (response.code !== 0) throw new Error('observation refused');
      return observation(JSON.parse(response.stdout), op!, deps.nowMs());
    };
    const observed = await read();
    if (observed.status === 'verified') {
      const fresh = await deps.refs();
      if (fresh.main !== current.to || fresh.promoted !== current.to)
        return { state: 'held', operation: current.id };
      persist({ ...op!, state: 'AUDIT_VERIFIED', auditAt: observed.at });
      return { state: 'complete', operation: current.id };
    }
    if (observed.status !== 'unverified')
      return { state: observed.status === 'absent' ? 'pending' : 'held', operation: current.id };
    persist({ ...op!, auditAt: observed.at });
    if (
      (observed.ack !== null || observed.acked !== null) &&
      !ackMatches(observed, op!, deps.nowMs())
    )
      return { state: 'held', operation: current.id };
    const beforeAck = await deps.refs();
    if (beforeAck.main !== current.to || beforeAck.promoted !== current.to)
      return { state: 'held', operation: current.id };
    const ack = await deps.crq([
      'promotion-ack',
      current.to,
      current.reason,
      '--audit-from',
      current.from,
      '--audit-at',
      observed.at!,
    ]);
    if (ack.code !== 0) return { state: 'pending', operation: current.id };
    const after = await read();
    if (!ackMatches(after, op!, deps.nowMs())) throw new Error('ack not durably confirmed');
    const fresh = await deps.refs();
    if (fresh.main !== current.to || fresh.promoted !== current.to)
      return { state: 'held', operation: current.id };
    persist({ ...op!, state: 'ACK_CONFIRMED' });
    return { state: 'complete', operation: current.id };
  } catch {
    // Do not expose command output, credentials, arbitrary audit text or a false success.
    return { state: 'held' };
  } finally {
    release?.();
  }
}

/** Thin entrypoint composition; argv transport is operator-owned, never PR data. */
export async function controllerMain(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const token = env[PROMOTE_TOKEN_ENV];
  delete env[PROMOTE_TOKEN_ENV];
  try {
    const values = new Map<string, string>();
    const gateArgs = argv.filter((arg) => {
      const m = /^--(journal|crqCommand|artifactSha256)=(.+)$/.exec(arg);
      if (m === null) return true;
      if (values.has(m[1]!)) throw new Error('duplicate controller flag');
      values.set(m[1]!, m[2]!);
      return false;
    });
    const args = parseGateArgs(gateArgs);
    const directory = values.get('journal');
    const command = JSON.parse(values.get('crqCommand') ?? 'null') as unknown;
    if (
      !directory ||
      !Array.isArray(command) ||
      !command.length ||
      !command.every((s) => typeof s === 'string' && s.length > 0 && !s.includes('\0'))
    )
      throw new Error('controller argv missing');
    const artifactSha256 = createHash('sha256')
      .update(readFileSync(fileURLToPath(import.meta.url)))
      .digest('hex');
    if (artifactSha256 !== values.get('artifactSha256')) throw new Error('artifact mismatch');
    if (
      realpathSync(args.repo) !==
      realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../..'))
    )
      throw new Error('controller is outside the trust checkout');
    if (args.push && !token) throw new Error('push credential missing');
    const gh = makeGhRunner();
    const remoteUrl = remoteUrlFor(
      env['GITHUB_SERVER_URL'] ?? 'https://github.com',
      args.owner,
      args.name,
    );
    const policy = controllerAcceptancePolicy(env);
    const cfg: GateConfig = { ...args, pushToken: token || null, remoteUrl };
    const source: Source = {
      commit: await realGateGit.revParse(args.repo, 'HEAD'),
      tree: await realGateGit.treeOf(args.repo, 'HEAD'),
      artifactSha256,
    };
    const repository = obj(await ghJson<unknown>(gh, ['api', `repos/${args.owner}/${args.name}`]));
    if (repository['id'] !== args.repositoryId) throw new Error('repository identity mismatch');
    const result = await runController(
      {
        gate: {
          gh,
          git: realGateGit,
          acceptance: (input) =>
            judgeAcceptance({ gh, owner: args.owner, repo: args.name, policy }, input),
          policyDiff: createPolicyDiff(resolveProtectedPathsConfig({ env }), {
            settleStatePath: SETTLE_STATE_PATH,
          }),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          nowMs: Date.now,
        },
        store: journalStore(directory),
        refs: async () => ({
          main: (await gitLsRemoteRef(args.repo, remoteUrl, MAIN_BRANCH, token ?? '')) ?? '',
          promoted: (await gitLsRemoteRef(args.repo, remoteUrl, PROMOTED_REF, token ?? '')) ?? '',
        }),
        crq: (tail) =>
          new Promise((done) => {
            execFile(
              String(command[0]),
              [...(command.slice(1) as string[]), ...tail],
              { timeout: 60_000, maxBuffer: 256 * 1024 },
              (error, stdout) => done({ code: error ? 1 : 0, stdout }),
            );
          }),
        nowMs: Date.now,
        id: randomUUID,
      },
      cfg,
      source,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.state === 'held' ? 1 : 0;
  } catch {
    process.stdout.write('{"state":"held"}\n');
    return 1;
  }
}
