import { CODES, fail, ok } from './errors.mjs';

export const FUNCTION_DEF_LOOKUP_SQL = `
SELECT n.nspname AS schema_name,
       p.proname AS function_name,
       pg_get_function_identity_arguments(p.oid) AS identity_args,
       pg_get_functiondef(p.oid) AS def
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = $1
  AND p.proname = $2
  AND regexp_replace(lower(pg_get_function_identity_arguments(p.oid)), '\\s+', '', 'g')
      = regexp_replace(lower($3), '\\s+', '', 'g')
`.trim();

const IDENTITY_RE = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\((.*)\)\s*$/;

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
  const args = rawArgs.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
  if (rawArgs.trim() && rawArgs.split(',').some((part) => !part.trim())) {
    return fail(CODES.UNRELATED_MUTATION, 'function identity has an empty argument token', { identity: text });
  }
  return ok({
    schema,
    name,
    identity_args: args.join(', '),
    args,
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

export async function readFunctionDef(client, identity) {
  const parsed = parseFunctionIdentity(identity);
  if (!parsed.ok) return parsed;
  let result;
  try {
    result = await client.query(FUNCTION_DEF_LOOKUP_SQL, [
      parsed.details.schema,
      parsed.details.name,
      parsed.details.identity_args,
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
