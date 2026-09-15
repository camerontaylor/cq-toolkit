// Pure-op fixture: echo — the ONE fixture op that validates its input
// (parse then echo); returns a frozen-taxonomy ok result.
import { z } from 'zod';

const InputSchema = z.object({ msg: z.string() }).strict();

export default async function echo(input) {
  const parsed = InputSchema.parse(input);
  return { status: 'ok', value: { echo: parsed.msg } };
}
