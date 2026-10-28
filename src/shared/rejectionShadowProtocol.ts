import { z } from 'zod';
import { deepFreeze } from './deepFreeze.js';

// Standalone, opt-in shadow protocol. All receipts are supplied by the engine;
// validating a scripted receipt is not evidence that a driver enforced it.
const Sha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const Text = z.string().min(1);
const Tools = z
  .array(z.enum(['read', 'grep', 'glob']))
  .min(1)
  .refine(
    (tools) => tools.includes('read') && new Set(tools).size === tools.length,
    'tools must include read and contain no duplicates',
  );
const Binding = z.strictObject({ packetId: Text, head: Sha, tree: Sha, tools: Tools });
const Finding = z.strictObject({
  id: Text,
  text: Text,
  file: Text.optional(),
  line: z.number().int().positive().optional(),
});
const Remaining = z.strictObject({
  tokens: z.number().int().nonnegative(),
  steps: z.number().int().nonnegative(),
  wallMs: z.number().int().nonnegative(),
});
const InitialInput = z.strictObject({ binding: Binding, finding: Finding, remaining: Remaining });
const Verdict = z
  .strictObject({
    verdict: z.enum(['real', 'not-real', 'uncertain']),
    reason: Text,
    evidence: z.array(
      z.strictObject({ path: Text, line: z.number().int().positive(), quote: Text }),
    ),
  })
  .refine(
    (value) => value.verdict === 'uncertain' || value.evidence.length > 0,
    'a definite verdict requires cited evidence',
  );
const Receipt = z.strictObject({
  phase: z.enum(['initial', 'reconciliation']),
  binding: Binding,
  sessionId: Text,
  status: z.enum(['complete', 'incomplete', 'budget-exhausted', 'cancelled']),
  used: Remaining.extend({ lookups: z.number().int().nonnegative() }),
});
const Argument = z.strictObject({ text: Text });

type SemanticVerdict = z.infer<typeof Verdict>;
type EngineReceipt = z.infer<typeof Receipt>;
type Caps = z.infer<typeof Remaining>;

export interface RejectionShadowInitial {
  readonly version: 1;
  readonly mode: 'shadow';
  readonly phase: 'initial';
  readonly session: 'fresh';
  readonly binding: z.infer<typeof Binding>;
  readonly finding: z.infer<typeof Finding>;
  readonly remaining: Caps;
  readonly lookupLimit: 4;
}

export interface RejectionShadowInitialRecord {
  readonly packet: RejectionShadowInitial;
  readonly output: SemanticVerdict | null;
  readonly receipt: EngineReceipt;
  readonly remaining: Caps;
}

export interface RejectionShadowReconciliation {
  readonly initial: RejectionShadowInitialRecord;
  readonly packet: {
    readonly version: 1;
    readonly mode: 'shadow';
    readonly phase: 'reconciliation';
    readonly session: 'fresh';
    readonly binding: z.infer<typeof Binding>;
    readonly finding: z.infer<typeof Finding>;
    readonly remaining: Caps;
    readonly lookupLimit: 1;
    readonly initialVerdict: SemanticVerdict;
    readonly argument: { readonly trust: 'untrusted'; readonly text: string };
  };
}

function available(caps: Caps): boolean {
  return caps.tokens > 0 && caps.steps > 0 && caps.wallMs > 0;
}

/** Strict whitelist: caller must supply the original finding, not fixer output/history. */
export function createRejectionShadowInitial(input: unknown): RejectionShadowInitial {
  const parsed = InitialInput.parse(input);
  if (!available(parsed.remaining)) throw new Error('no remaining phase budget');
  return deepFreeze({
    ...parsed,
    version: 1,
    mode: 'shadow',
    phase: 'initial',
    session: 'fresh',
    lookupLimit: 4,
  });
}

function capture(
  packet: RejectionShadowInitial | RejectionShadowReconciliation['packet'],
  output: unknown,
  receiptInput: unknown,
): { output: SemanticVerdict | null; receipt: EngineReceipt; remaining: Caps } {
  const receipt = Receipt.parse(receiptInput);
  const bound = packet.binding;
  if (
    receipt.phase !== packet.phase ||
    receipt.binding.packetId !== bound.packetId ||
    receipt.binding.head !== bound.head ||
    receipt.binding.tree !== bound.tree ||
    receipt.binding.tools.join(',') !== bound.tools.join(',')
  )
    throw new Error('phase receipt binding mismatch');
  const used = receipt.used;
  if (
    used.lookups > packet.lookupLimit ||
    used.tokens > packet.remaining.tokens ||
    used.steps > packet.remaining.steps ||
    used.wallMs > packet.remaining.wallMs
  )
    throw new Error('phase receipt exceeds remaining cap');
  const parsedOutput = output === null ? null : Verdict.parse(output);
  if (receipt.status === 'complete' && parsedOutput === null)
    throw new Error('complete receipt requires semantic output');
  return {
    output: parsedOutput,
    receipt,
    remaining: {
      tokens: packet.remaining.tokens - used.tokens,
      steps: packet.remaining.steps - used.steps,
      wallMs: packet.remaining.wallMs - used.wallMs,
    },
  };
}

/** Separate engine receipt from model-owned semantic output; retain both unchanged. */
export function recordRejectionShadowInitial(
  packet: RejectionShadowInitial,
  output: unknown,
  receipt: unknown,
): RejectionShadowInitialRecord {
  return deepFreeze({ packet, ...capture(packet, output, receipt) });
}

/** Two explicit fresh sessions; no continuation handle/history crosses this boundary. */
export function createRejectionShadowReconciliation(
  initial: RejectionShadowInitialRecord,
  argument: unknown,
): RejectionShadowReconciliation {
  if (initial.receipt.status !== 'complete' || initial.output === null)
    throw new Error('initial phase not complete');
  if (!available(initial.remaining)) throw new Error('no remaining phase budget');
  const parsedArgument = Argument.parse(argument);
  return deepFreeze({
    initial,
    packet: {
      version: 1,
      mode: 'shadow',
      phase: 'reconciliation',
      session: 'fresh',
      binding: initial.packet.binding,
      finding: initial.packet.finding,
      remaining: initial.remaining,
      lookupLimit: 1,
      initialVerdict: initial.output,
      argument: { trust: 'untrusted', text: parsedArgument.text },
    },
  });
}

/** A shadow record has zero authority to resolve/reject/defer a finding. */
export function recordRejectionShadowReconciliation(
  stage: RejectionShadowReconciliation,
  output: unknown,
  receipt: unknown,
) {
  const reconciliation = capture(stage.packet, output, receipt);
  if (reconciliation.receipt.sessionId === stage.initial.receipt.sessionId)
    throw new Error('reconciliation requires a distinct fresh session');
  return deepFreeze({
    mode: 'shadow' as const,
    dispositionAuthority: 'none' as const,
    initial: stage.initial,
    reconciliation: { packet: stage.packet, ...reconciliation },
  });
}
