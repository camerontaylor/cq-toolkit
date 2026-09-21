// The draft-2020-12 meta-schema stripper — shared by the two drivers that
// hand a zod-derived JSON Schema to the `claude` CLI (issue #209).
//
// WHY THIS EXISTS: `z.toJSONSchema()` (zod v4) emits a top-level
// `"$schema": "https://json-schema.org/draft/2020-12/schema"`. Both the
// claude-agent SDK lane and the subprocess lane forward that document to the
// Claude Code CLI (`Options.outputFormat.schema` / `--json-schema`), and the
// CLI rejects it BEFORE the model runs:
//
//   Error: --json-schema is not a valid JSON Schema: no schema with key or
//   ref "https://json-schema.org/draft/2020-12/schema"
//
// The CLI resolves internal `#/...` references (zod's `#/$defs/...`) but has
// no network/registry lookup for the external meta URI, so the URI — and any
// `$ref` pointing at it — must be gone before the schema leaves this process.

/** An absolute JSON-Schema meta URI (`http(s)://json-schema.org/...`). */
const META_SCHEMA_URI = /^https?:\/\/json-schema\.org\//;

/** `$schema` / meta-URI `$ref` blind deep clone (never the input object). */
function cloneWithoutMetaSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneWithoutMetaSchema(entry));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === '$schema') continue;
      if (key === '$ref' && typeof entry === 'string' && META_SCHEMA_URI.test(entry)) continue;
      out[key] = cloneWithoutMetaSchema(entry);
    }
    return out;
  }
  return value;
}

/**
 * Return a DEEP CLONE of `schema` with every `$schema` property (top level
 * and nested, in objects or arrays) and every absolute JSON-Schema meta
 * `$ref` removed. `$defs`, `properties`, `required`,
 * `additionalProperties` and internal `#/...` refs are left untouched —
 * those ARE resolvable by the CLI.
 *
 * The ORIGINAL zod schema remains the post-settle validator: a payload that
 * fails its `safeParse` is dropped to narration, never trusted and never
 * fabricated. This function only shapes the schema the CLI sees.
 */
export function stripMetaSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return cloneWithoutMetaSchema(schema) as Record<string, unknown>;
}
