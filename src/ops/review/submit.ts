import { SubmitInputSchema } from './internal/reviewOperation.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { git, headMessage, reviewOp, evidenceRoot } from './internal/localReview.js';
import { WireSchema, SnapshotSchema } from './internal/reviewOperation.js';
import { captureSnapshot, SnapshotConfigError } from '../dev/internal/snapshot.js';
import { observeReview } from './wait.js';
import { QueueUnsupported, ReviewInputError } from './internal/queueClient.js';
import type { QueueTransport } from './internal/queueProtocol.js';

export const makeSubmit = (transport?: QueueTransport) =>
  reviewOp(
    SubmitInputSchema,
    async (i, getClient) => {
      const requestId = i.requestId ?? randomUUID();
      const root = await evidenceRoot(i.cwd);
      const dir = join(root, '.cq/queue-evidence/requests');
      const path = join(dir, requestId + '.json');
      await mkdir(dir, { recursive: true });
      let saved:
        | {
            key: string;
            inputs: unknown;
            submitted_at: string;
            wire: unknown;
            snapshotPolicy?: string;
          }
        | undefined;
      try {
        saved = JSON.parse(await readFile(path, 'utf8')) as typeof saved;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const exclusions = {
        staged: await git(i.cwd, 'diff', '--cached', '--name-only'),
        unstaged: await git(i.cwd, 'diff', '--name-only'),
        untracked: await git(i.cwd, 'ls-files', '--others', '--exclude-standard'),
      };
      let wire;
      let snapshotPolicy = i.reachable ? 'reachable' : 'snapshot';
      if (saved) {
        wire = WireSchema.parse(saved.wire);
        snapshotPolicy =
          saved.snapshotPolicy ?? ('snapshot' in wire && wire.snapshot ? 'snapshot' : 'reachable');
        // Required selectors must still match. Omitted optional admission fields
        // reuse the saved wire; an explicit repeat=false equals its wire default.
        if (
          wire.op !== 'submit' ||
          wire.request_id !== requestId ||
          wire.inputs.repo !== i.repo ||
          wire.inputs.target !== i.target ||
          (i.repeat !== undefined && (wire.repeat ?? false) !== i.repeat) ||
          (i.supersedes !== undefined && wire.supersedes !== i.supersedes)
        )
          throw new Error('requestId is already bound to different inputs');
      } else {
        const head = await git(i.cwd, 'rev-parse', '--verify', 'HEAD^{commit}');
        const target = await git(
          i.cwd,
          'rev-parse',
          '--verify',
          '--end-of-options',
          i.target + '^{commit}',
        );
        const base = await git(i.cwd, 'merge-base', target, head);
        const inputs = {
          repo: i.repo,
          target: i.target,
          base_commit: base,
          head_commit: head,
          base_tree: await git(i.cwd, 'rev-parse', base + '^{tree}'),
          head_tree: await git(i.cwd, 'rev-parse', head + '^{tree}'),
          projection: 'full-diff',
        };
        if (inputs.base_tree === inputs.head_tree)
          return { v: 1, action: 'no-changes', state: 'completed', exclusions, reviewedHead: head };
        wire = WireSchema.parse({
          v: 1,
          op: 'submit',
          request_id: requestId,
          inputs,
          ...(i.repeat === undefined ? {} : { repeat: i.repeat }),
          ...(i.supersedes === undefined ? {} : { supersedes: i.supersedes }),
        });
        const record = {
          key: requestId,
          inputs,
          submitted_at: new Date().toISOString(),
          wire,
          snapshotPolicy,
        };
        try {
          await writeFile(path, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const concurrent = JSON.parse(await readFile(path, 'utf8')) as { wire: unknown };
          if (!isDeepStrictEqual(concurrent.wire, wire))
            throw new Error('requestId is already bound to different inputs');
        }
      }
      if (wire.op !== 'submit') throw new Error('invalid saved submit');
      let mutationSent = false;
      try {
        const client = getClient();
        const capabilities = await client.capabilities();
        if (snapshotPolicy === 'snapshot' && !wire.snapshot) {
          if (!capabilities.features.includes('original-commit-snapshot-v1'))
            throw new QueueUnsupported('original-commit snapshot capability unavailable');
          const { snapshot } = await captureSnapshot(
            root,
            wire.inputs.base_commit,
            wire.inputs.head_tree,
            i.scanner,
            30000,
            wire.inputs.head_commit,
          ).catch((error: unknown) => {
            if (error instanceof SnapshotConfigError) throw error;
            throw new ReviewInputError(error instanceof Error ? error.message : String(error));
          });
          wire = { ...wire, snapshot: SnapshotSchema.parse(snapshot) };
          const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
          const prepared = join(dir, requestId + '.' + randomUUID() + '.tmp');
          await writeFile(prepared, JSON.stringify({ ...record, wire }), { mode: 0o600 });
          await rename(prepared, path);
        }
        mutationSent = true;
        const response = await client.request(wire);
        if (!('state' in response)) throw new Error('expected admission response');
        // The immutable request remains the recovery authority even if this cache update fails.
        const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
        const updated = join(dir, requestId + '.' + randomUUID() + '.tmp');
        await writeFile(
          updated,
          JSON.stringify({
            ...record,
            response,
            ...('identity' in response ? { identity: response.identity } : {}),
          }),
          { mode: 0o600 },
        );
        await rename(updated, path);
        const result =
          i.waitMs === undefined || !['queued', 'running'].includes(response.state)
            ? response
            : await observeReview(client, requestId, i.waitMs, undefined, response);
        return {
          ...response,
          ...result,
          action: response.action,
          request_id: requestId,
          exclusions,
          reviewedHead: wire.inputs.head_commit,
          message: await headMessage(i.cwd, wire.inputs.head_commit),
        };
      } catch (error) {
        if (mutationSent && error instanceof Error && !(error instanceof ReviewInputError))
          error.message += `; persisted requestId=${requestId}; retry review.submit with this requestId to reconcile`;
        throw error;
      }
    },
    transport,
  );
