/**
 * Forced-command router (`capability_dispatcher.py`).
 *
 * The operator owns identity and policy through the environment; the SSH
 * request text selects only an exact allowlisted capability, never a command
 * or a path. Unlike the per-capability entrypoints, which tolerate an absent
 * `SSH_ORIGINAL_COMMAND` so they can be run by hand, the router refuses it
 * (`dispatch(None, ...)` raises in Python): an interactive login must not
 * reach a capability.
 */

/** The allowlist, in Python's `dispatch` order. */
export const CAPABILITIES = ['author-v1', 'queue-v1', 'review-v1'] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** `capability_dispatcher.main`'s catch-all, whatever escapes a capability. */
export const DISPATCH_REFUSAL = 'queue capability refused; no permission';

export interface CapabilityDispatcherDeps {
  /** Arguments after the command name; `len(sys.argv) != 1` refuses. */
  readonly argv: readonly string[];
  readonly env: (name: string) => string | undefined;
  readonly stderr: (message: string) => void;
  /** Each handler serves its own frame and returns the process exit code. */
  readonly handlers: Readonly<Record<Capability, () => Promise<number>>>;
}

/** Exact-match lookup; anything else (including `undefined`) is not a capability. */
export function selectCapability(command: string | undefined): Capability | undefined {
  return CAPABILITIES.find((capability) => capability === command);
}

/** Serve one forced-command invocation and return the process exit code. */
export async function runCapabilityDispatcher(deps: CapabilityDispatcherDeps): Promise<number> {
  // Python checks `len(sys.argv) != 1` before its try block and returns 2 silently.
  if (deps.argv.length !== 0) return 2;
  try {
    const capability = selectCapability(deps.env('SSH_ORIGINAL_COMMAND'));
    if (capability === undefined) throw new Error('unsupported forced command');
    return await deps.handlers[capability]();
  } catch {
    deps.stderr(DISPATCH_REFUSAL);
    return 2;
  }
}
