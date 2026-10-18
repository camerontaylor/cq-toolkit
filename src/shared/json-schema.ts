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
// reference keyword pointing at it — must be gone before the schema leaves
// this process.
//
// SCHEMA-POSITION AWARENESS: `$schema` and the reference keywords are not
// data. A blind deep walk would also strip them out of JSON VALUES that
// merely LOOK like schemas (a `const`/`default`/`enum`/`examples`/
// `dependentRequired` payload, or a property literally NAMED `$schema`). The
// walk therefore knows the schema grammar: value-bearing keywords are copied
// verbatim, name→schema maps keep their keys verbatim, and only genuine
// subschema positions are recursed. Output objects are null-prototype so an
// own `__proto__` key parsed from JSON survives as a property instead of
// mutating the prototype.

/**
 * An absolute JSON-Schema host reference. The breadth is INTENTIONAL: the CLI
 * resolves no external references at all, so ANY absolute
 * `http(s)://json-schema.org/...` reference is dropped, not just the
 * draft-2020-12 meta path.
 */
const META_SCHEMA_URI = /^https?:\/\/json-schema\.org\//;

/** Reference keywords the CLI cannot resolve when they point at the meta URI. */
const REF_KEYWORDS = new Set(['$ref', '$dynamicRef', '$recursiveRef']);

/** Keywords whose content is arbitrary DATA, never a subschema — copied verbatim. */
const VALUE_KEYWORDS = new Set(['const', 'default', 'examples', 'enum', 'dependentRequired']);

/** Keywords whose value is a name→schema map — keys kept verbatim, values walked. */
const SCHEMA_MAP_KEYWORDS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);

/** Deep clone of arbitrary DATA (never the input object) — strips nothing. */
function cloneData(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneData(entry));
  }
  if (value !== null && typeof value === 'object') {
    const out = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = cloneData(entry);
    }
    return out;
  }
  return value;
}

/** A name→schema map: KEYS verbatim (a key named `$schema` survives), VALUES walked. */
function cloneSchemaMap(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return cloneData(value); // malformed map — clone it verbatim
  }
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = cloneSchema(entry);
  }
  return out;
}

/** A SCHEMA position: `$schema` / meta-URI reference dropping deep clone (never the input). */
function cloneSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneSchema(entry));
  }
  if (value !== null && typeof value === 'object') {
    const out = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === '$schema') continue;
      if (REF_KEYWORDS.has(key) && typeof entry === 'string' && META_SCHEMA_URI.test(entry)) {
        continue;
      }
      if (VALUE_KEYWORDS.has(key)) {
        out[key] = cloneData(entry);
      } else if (SCHEMA_MAP_KEYWORDS.has(key)) {
        out[key] = cloneSchemaMap(entry);
      } else {
        out[key] = cloneSchema(entry);
      }
    }
    return out;
  }
  return value;
}

/**
 * Return a DEEP CLONE of `schema` with every `$schema` property and every
 * absolute JSON-Schema meta reference (`$ref`, `$dynamicRef`, `$recursiveRef`)
 * removed from genuine SCHEMA positions — top level and nested, in objects or
 * arrays. `$defs`, `properties`, `required`, `additionalProperties` and
 * internal `#/...` refs are left untouched — those ARE resolvable by the CLI.
 *
 * The walk is schema-position aware: `const`/`default`/`examples`/`enum`/
 * `dependentRequired` values and the KEYS of `properties`/`patternProperties`/
 * `$defs`/`definitions`/`dependentSchemas` are copied verbatim, so data that
 * merely looks like a schema — or a property literally named `$schema` —
 * survives. Output objects are null-prototype, so an own `__proto__` key is
 * preserved as a property rather than reaching the prototype setter.
 *
 * The ORIGINAL zod schema remains the post-settle validator: a payload that
 * fails its `safeParse` is dropped to narration, never trusted and never
 * fabricated. This function only shapes the schema the CLI sees.
 */
export function stripMetaSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return cloneSchema(schema) as Record<string, unknown>;
}
