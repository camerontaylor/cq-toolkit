// The one error-to-text coercion shared by every narration line and `failed`
// result: unwrap an unknown throwable to its message.
/** Message of an unknown throwable, for narration lines and failure details. */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
