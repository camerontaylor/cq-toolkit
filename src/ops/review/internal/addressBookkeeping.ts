import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { z } from 'zod';
import { devLedgerPath, parseDevLedger } from '../../dev/record.js';
import { FindingsRecordSchema } from '../findings.js';
import { parseQueueReceipt } from './queueEvidence.js';

const sha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const receiptSchema = z
  .object({
    version: z.literal(1),
    identity: z.string(),
    root: z.string(),
    branch: z.string(),
    head: sha,
    files: z
      .array(z.object({ path: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict())
      .min(1),
  })
  .strict();
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** Private author-tier ownership receipt, never current review/clean proof.
 * Called only under the composition's bookkeeping FIFO, itself inside checkout
 * ownership. No callback acquires a mutation/checkout lock or reenters that FIFO.
 */
export function makeAddressBookkeepingReceipt(deps: {
  path: string;
  identity: string;
  fingerprints: Map<string, string>;
  git(root: string, args: string[]): Promise<string>;
}) {
  let preparedRoot: string | undefined;
  let receiptHash: string | undefined;
  const ordinaryBytes = async (path: string) => {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.nlink !== 1 || (await realpath(path)) !== path)
      throw new Error('bookkeeping receipt requires an ordinary exact path');
    return readFile(path);
  };
  const assertUnchanged = async () => {
    if (!preparedRoot) return;
    let prior: Buffer | undefined;
    try {
      prior = await ordinaryBytes(deps.path);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if ((prior ? digest(prior) : undefined) !== receiptHash)
      throw new Error('bookkeeping receipt changed outside engine');
  };
  const allowed = (root: string, branch: string, path: string) => {
    if (path === devLedgerPath(root, branch)) return true;
    if (
      dirname(path) === resolve(root, '.cq/queue-evidence') &&
      /^[0-9a-f]{64}\.json$/.test(relative(resolve(root, '.cq/queue-evidence'), path))
    )
      return true;
    const folder = resolve(root, '.cq/review', encodeURIComponent(branch));
    return dirname(path) === folder && /^\d+\.json$/.test(relative(folder, path));
  };
  const validateQueueEvidence = (root: string, path: string, bytes: Buffer) => {
    if (dirname(path) !== resolve(root, '.cq/queue-evidence')) return false;
    if (relative(resolve(root, '.cq/queue-evidence'), path) !== digest(bytes) + '.json')
      throw new Error('bookkeeping queue evidence digest mismatch');
    parseQueueReceipt(JSON.parse(bytes.toString('utf8')));
    return true;
  };
  const state = async (root: string) => {
    const ref = await deps.git(root, ['symbolic-ref', '--quiet', 'HEAD']);
    if (!ref.startsWith('refs/heads/')) throw new Error('bookkeeping branch unavailable');
    return {
      branch: ref.slice('refs/heads/'.length),
      head: await deps.git(root, ['rev-parse', 'HEAD']),
    };
  };
  return {
    assertUnchanged,
    /**
     * Strictly validate an existing receipt against the checkout it
     * describes (identity/root/branch/head, path allowlist, exact bytes) and
     * return the absolute paths it owns — the engine-owned file set a caller
     * may retire when this engine itself refreshes the checkout. Throws on
     * any mismatch; a missing receipt yields an empty list.
     */
    async ownedFiles(): Promise<string[]> {
      let bytes: Buffer;
      try {
        bytes = await ordinaryBytes(deps.path);
      } catch (error) {
        if (missing(error)) return [];
        throw error;
      }
      const receipt = receiptSchema.parse(JSON.parse(bytes.toString('utf8')));
      const canonical = await realpath(receipt.root);
      const current = await state(canonical);
      if (
        receipt.identity !== deps.identity ||
        receipt.root !== canonical ||
        receipt.branch !== current.branch ||
        receipt.head !== current.head
      )
        throw new Error('bookkeeping receipt identity/head mismatch');
      const paths: string[] = [];
      for (const row of receipt.files) {
        const path = resolve(canonical, row.path);
        if (relative(canonical, path) !== row.path || !allowed(canonical, current.branch, path))
          throw new Error('bookkeeping receipt path mismatch');
        const content = await ordinaryBytes(path);
        if (digest(content) !== row.sha256) throw new Error('bookkeeping receipt bytes changed');
        validateQueueEvidence(canonical, path, content);
        paths.push(path);
      }
      return paths;
    },
    async prepare(root: string) {
      const canonical = await realpath(root);
      if (preparedRoot) {
        if (canonical !== preparedRoot) throw new Error('bookkeeping checkout changed');
        await assertUnchanged();
        return;
      }
      let bytes: Buffer;
      try {
        bytes = await ordinaryBytes(deps.path);
      } catch (error) {
        if (!missing(error)) throw error;
        // A new run can produce a receipt, but existing unregistered files stay unknown.
        preparedRoot = canonical;
        return;
      }
      const receipt = receiptSchema.parse(JSON.parse(bytes.toString('utf8')));
      const current = await state(canonical);
      if (
        receipt.identity !== deps.identity ||
        receipt.root !== canonical ||
        receipt.branch !== current.branch ||
        receipt.head !== current.head
      )
        throw new Error('bookkeeping receipt identity/head mismatch');
      const restored = new Map<string, string>();
      for (const row of receipt.files) {
        const path = resolve(canonical, row.path);
        if (
          relative(canonical, path) !== row.path ||
          !allowed(canonical, current.branch, path) ||
          restored.has(path)
        )
          throw new Error('bookkeeping receipt path mismatch');
        const content = await ordinaryBytes(path);
        if (digest(content) !== row.sha256) throw new Error('bookkeeping receipt bytes changed');
        const heads: string[] = [];
        if (validateQueueEvidence(canonical, path, content)) {
          // Receipt ownership conveys no author-head ancestry or review credit.
        } else if (path === devLedgerPath(canonical, current.branch)) {
          const ledger = parseDevLedger(content.toString('utf8'));
          if (ledger.branch !== current.branch)
            throw new Error('bookkeeping ledger branch mismatch');
          for (const record of ledger.records) {
            if (record.kind === 'vendor-debt') {
              if (record.debt.reference.binding.kind !== 'deferred-author')
                throw new Error('bookkeeping debt requires a deferred author binding');
              heads.push(record.debt.reference.binding.head, record.debt.deferral.base);
              continue;
            }
            heads.push(record.head);
            if (record.kind !== 'disposition') heads.push(record.base);
          }
        } else {
          const record = FindingsRecordSchema.parse(JSON.parse(content.toString('utf8')));
          if (record.branch !== current.branch)
            throw new Error('bookkeeping findings branch mismatch');
          heads.push(record.head);
          if (record.reviewed) heads.push(record.reviewed.base);
        }
        for (const head of new Set(heads)) {
          sha.parse(head);
          await deps.git(canonical, ['merge-base', '--is-ancestor', head, current.head]);
        }
        restored.set(path, row.sha256);
      }
      // Validate the entire receipt before admitting any entry; never rewrite caller bytes.
      for (const [path, hash] of restored) deps.fingerprints.set(path, hash);
      preparedRoot = canonical;
      receiptHash = digest(bytes);
    },
    async persist() {
      if (!preparedRoot) throw new Error('bookkeeping receipt was not prepared');
      await assertUnchanged();
      const current = await state(preparedRoot);
      const files = [];
      for (const [path, hash] of deps.fingerprints) {
        if (
          !allowed(preparedRoot, current.branch, path) ||
          digest(await ordinaryBytes(path)) !== hash
        )
          throw new Error('bookkeeping receipt cannot bless changed/unowned bytes');
        validateQueueEvidence(preparedRoot, path, await ordinaryBytes(path));
        files.push({ path: relative(preparedRoot, path), sha256: hash });
      }
      const receipt = receiptSchema.parse({
        version: 1,
        identity: deps.identity,
        root: preparedRoot,
        ...current,
        files,
      });
      const temp = resolve(dirname(deps.path), `.bookkeeping.${randomUUID()}.tmp`);
      const bytes = `${JSON.stringify(receipt)}\n`;
      // Acquire create-only ownership before cleanup; a collision is never deleted.
      const handle = await open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.close();
        await assertUnchanged();
        await rename(temp, deps.path);
        receiptHash = digest(Buffer.from(bytes));
      } finally {
        // Cancellation never interrupts receipt settlement or owned-temp cleanup.
        await handle.close();
        await unlink(temp).catch((error) => {
          if (!missing(error)) throw error;
        });
      }
    },
  };
}
