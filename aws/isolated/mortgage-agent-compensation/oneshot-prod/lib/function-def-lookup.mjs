import { CODES, fail, ok } from './errors.mjs';

/**
 * Resolve a function by schema + name + ordered INPUT argument type OIDs.
 *
 * Matching uses pg_proc.proargtypes / pronargs, not
 * pg_get_function_identity_arguments(). Parameter names therefore cannot
 * change the result. OUT/TABLE arguments are not in proargtypes, so they
 * cannot create a false match. Defaults and variadic broadening are not
 * applied: the requested type vector must equal the catalog type vector.
 *
 * $3 is a text[] of type names, each cast with ::regtype so domains and
 * custom types keep their own OIDs unless PostgreSQL says they are the
 * same type.
 *
 * Do not compare p.proargtypes::oid[] directly to ARRAY_AGG(...).
 * oidvector is 0-based, so the cast keeps lower bound 0; ARRAY_AGG is
 * 1-based. PostgreSQL array equality requires matching bounds, so that
 * form returns zero rows for every function that has arguments — the
 * create-then-absent #601 failure. Re-aggregate both sides through
 * unnest ... WITH ORDINALITY so both arrays are 1-based.
 *
 * PostgreSQL cannot CAST(oid[] AS oidvector); that form fails closed as
 * a lookup error and must never be treated as exists:false.
 */
export const FUNCTION_DEF_LOOKUP_SQL = `
SELECT n.nspname AS schema_name,
       p.proname AS function_name,
       pg_get_functiondef(p.oid) AS def
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = $1::text
  AND p.proname = $2::text
  AND p.pronargs = COALESCE(cardinality($3::text[]), 0)
  AND (
    SELECT COALESCE(ARRAY_AGG(proc_t.typ ORDER BY proc_t.ord), ARRAY[]::oid[])
    FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS proc_t(typ, ord)
  ) = (
    SELECT COALESCE(ARRAY_AGG(u.typ::regtype::oid ORDER BY u.ord), ARRAY[]::oid[])
    FROM unnest(COALESCE($3::text[], ARRAY[]::text[])) WITH ORDINALITY AS u(typ, ord)
  )
`.trim();

const DOLLAR_BODY_RE = /\bAS\s+(\$[A-Za-z0-9_]*\$)([\s\S]*?)\1/i;

export function extractDollarQuotedBody(sql) {
  const match = String(sql || '').match(DOLLAR_BODY_RE);
  return match ? match[2].trim() : null;
}

export function functionHeaderFlags(sql) {
  const text = String(sql || '');
  return {
    language: (text.match(/\bLANGUAGE\s+(\w+)/i) || [])[1]?.toLowerCase() || null,
    security_definer: /\bSECURITY\s+DEFINER\b/i.test(text),
    stable: /\bSTABLE\b/i.test(text),
    search_path_public: /SET\s+search_path\s+TO\s+'public'/i.test(text),
  };
}

export function functionDefsMatchExactly(liveDef, sourceSql) {
  const liveBody = extractDollarQuotedBody(liveDef);
  const sourceBody = extractDollarQuotedBody(sourceSql);
  if (!liveBody || !sourceBody || liveBody !== sourceBody) return false;
  const live = functionHeaderFlags(liveDef);
  const source = functionHeaderFlags(sourceSql);
  return live.language === source.language
    && live.security_definer === source.security_definer
    && live.stable === source.stable
    && live.search_path_public === source.search_path_public;
}

const IDENTITY_RE = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\((.*)\)\s*$/;
const SIMPLE_TYPE_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*\.)?[A-Za-z_][A-Za-z0-9_]*(?:\[\])?$/;
const MULTIWORD_TYPES = new Set([
  'double precision',
  'double precision[]',
  'character varying',
  'character varying[]',
  'bit varying',
  'bit varying[]',
  'timestamp with time zone',
  'timestamp with time zone[]',
  'timestamp without time zone',
  'timestamp without time zone[]',
  'time with time zone',
  'time with time zone[]',
  'time without time zone',
  'time without time zone[]',
]);

function isAllowedTypeName(token) {
  const type = String(token || '').trim().toLowerCase().replace(/\s+\[\]$/, '[]');
  if (!type) return false;
  if (MULTIWORD_TYPES.has(type)) return true;
  return SIMPLE_TYPE_RE.test(type);
}

function normalizeTypeName(token) {
  return String(token || '').trim().toLowerCase().replace(/\s+\[\]$/, '[]');
}

export function parseFunctionIdentity(identity) {
  if (typeof identity !== 'string' || !identity.trim()) {
    return fail(CODES.INVALID_MANIFEST, 'function identity is required');
  }
  const text = identity.trim();
  if (text.includes('\0') || text.includes(';') || text.includes('--')) {
    return fail(CODES.UNRELATED_MUTATION, 'function identity is malformed', { identity: text });
  }
  const match = text.match(IDENTITY_RE);
  if (!match) {
    return fail(CODES.UNRELATED_MUTATION, 'unexpected function identity shape', { identity: text });
  }
  const schema = match[1];
  const name = match[2];
  const rawArgs = match[3];
  if (rawArgs.includes('(') || rawArgs.includes(')')) {
    return fail(CODES.UNRELATED_MUTATION, 'unexpected nested function identity', { identity: text });
  }
  if (rawArgs.trim() && rawArgs.split(',').some((part) => !part.trim())) {
    return fail(CODES.UNRELATED_MUTATION, 'function identity has an empty argument token', { identity: text });
  }
  const tokens = rawArgs.trim()
    ? rawArgs.split(',').map((part) => part.trim()).filter((part) => part.length > 0)
    : [];
  const arg_types = [];
  for (const token of tokens) {
    if (!isAllowedTypeName(token)) {
      return fail(
        CODES.UNRELATED_MUTATION,
        'function identity argument must be a type name, not a named parameter',
        { identity: text, token },
      );
    }
    arg_types.push(normalizeTypeName(token));
  }
  return ok({
    schema,
    name,
    arg_types,
    identity_args: arg_types.join(', '),
    args: arg_types,
  });
}

export function classifyFunctionDefRows(rows, identity) {
  if (!Array.isArray(rows)) {
    return fail(CODES.UNRELATED_MUTATION, 'function definition lookup returned an unexpected result set', {
      identity,
    });
  }
  if (rows.length === 0) {
    return ok({ exists: false });
  }
  if (rows.length > 1) {
    return fail(CODES.SQL_COLLISION, 'function identity is ambiguous; duplicate catalog rows', {
      identity,
      matches: rows.length,
    });
  }
  const def = rows[0]?.def;
  if (typeof def !== 'string' || !def) {
    return fail(CODES.SQL_COLLISION, 'existing function returned an unexpected empty definition', {
      identity,
    });
  }
  return ok({ exists: true, definition: def });
}

export function catalogInputTypesMatch(requestedTypes, catalogTypes) {
  if (!Array.isArray(requestedTypes) || !Array.isArray(catalogTypes)) return false;
  if (requestedTypes.length !== catalogTypes.length) return false;
  return requestedTypes.every((type, index) => (
    normalizeTypeName(type) === normalizeTypeName(catalogTypes[index])
  ));
}

export function matchFunctionCatalog(catalog, identity) {
  const parsed = parseFunctionIdentity(identity);
  if (!parsed.ok) return parsed;
  if (!Array.isArray(catalog)) {
    return fail(CODES.UNRELATED_MUTATION, 'function definition lookup returned an unexpected result set', {
      identity,
    });
  }
  const matches = catalog.filter((row) => (
    row
    && row.schema === parsed.details.schema
    && row.name === parsed.details.name
    && catalogInputTypesMatch(parsed.details.arg_types, row.input_types)
  ));
  return classifyFunctionDefRows(matches.map((row) => ({ def: row.def })), identity);
}

export function functionDefLookupParams(identity) {
  const parsed = parseFunctionIdentity(identity);
  if (!parsed.ok) return parsed;
  return ok({
    schema: parsed.details.schema,
    name: parsed.details.name,
    arg_types: parsed.details.arg_types,
    query_params: [parsed.details.schema, parsed.details.name, parsed.details.arg_types],
  });
}

export async function readFunctionDef(client, identity) {
  const parsed = parseFunctionIdentity(identity);
  if (!parsed.ok) return parsed;
  let result;
  try {
    result = await client.query(FUNCTION_DEF_LOOKUP_SQL, [
      parsed.details.schema,
      parsed.details.name,
      parsed.details.arg_types,
    ]);
  } catch (error) {
    return fail(CODES.UNRELATED_MUTATION, 'function definition lookup failed', {
      identity,
      error: String(error?.message || error).slice(0, 400),
    });
  }
  return classifyFunctionDefRows(result?.rows, identity);
}

export function definitionFromLookup(lookup) {
  if (!lookup?.ok) return lookup;
  return ok({
    exists: lookup.details.exists === true,
    definition: lookup.details.exists ? lookup.details.definition : null,
  });
}
