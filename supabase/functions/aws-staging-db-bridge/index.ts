/**
 * Temporary ChecksOps AWS database reconciliation bridge (READ ONLY).
 *
 * Purpose: let the AWS-side migration job compare the current live production
 * database against the September 1 full backup already restored in AWS.
 *
 * Hard guarantees:
 *  - No INSERT / UPDATE / DELETE / UPSERT / RPC / arbitrary SQL. Only GET reads.
 *  - No provider or financial actions of any kind.
 *  - Table allowlist is derived from the exposed `public` schema, minus a
 *    denylist of credential/challenge tables.
 *  - Sensitive-looking columns are redacted before leaving the function.
 *  - Auth: x-checksops-migration-token compared to SHA-256 (timing-safe),
 *    reusing AWS_MIGRATION_TOKEN_SHA256. Fail-closed when unset.
 *  - No browser CORS, POST only.
 *
 * Remove this function once AWS database reconciliation is confirmed.
 */

const MAX_PAGE = 500;
const DEFAULT_PAGE = 200;
const JSON_HEADERS = { "Content-Type": "application/json" };

/** Tables never exposed: credentials, auth challenges, PostGIS internals. */
const TABLE_DENYLIST = new Set([
  "spatial_ref_sys",
  "webauthn_challenges",
  "user_passkeys",
  "tenant_openai_credentials",
  "email_unsubscribe_tokens",
  "homeowner_ledger_tokens",
  "homeowner_bank_link_tokens",
  "payment_idempotency_keys",
]);

/** Column values redacted in every row payload. */
const SENSITIVE_COLUMN = /(password|secret|api_key|private_key|credential|access_token|refresh_token|client_secret|token_hash|signing_key|_pem|otp|totp_secret)/i;

/** Columns that are opaque tokens but whose presence matters for reconciliation. */
const TOKEN_COLUMN = /(^|_)token($|_)/i;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

const sha256Hex = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const timingSafeEqualHex = (left: string, right: string) => {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return mismatch === 0;
};

const expectedTokenSha256 = () =>
  String(Deno.env.get("AWS_MIGRATION_TOKEN_SHA256") || "").trim().toLowerCase();

const authorize = async (req: Request): Promise<"ok" | "denied" | "unconfigured"> => {
  const expected = expectedTokenSha256();
  if (!expected) return "unconfigured";
  const token = req.headers.get("x-checksops-migration-token") || "";
  if (!token) return "denied";
  return timingSafeEqualHex(await sha256Hex(token), expected) ? "ok" : "denied";
};

const env = () => {
  const url = String(Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
  const key = String(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "");
  if (!url || !key) throw new Error("platform_credentials_missing");
  return { url, key };
};

const restHeaders = (key: string, extra: Record<string, string> = {}) => ({
  apikey: key,
  Authorization: `Bearer ${key}`,
  Accept: "application/json",
  ...extra,
});

type SpecProperty = { type?: string; format?: string; description?: string };
type Spec = { definitions?: Record<string, { properties?: Record<string, SpecProperty>; required?: string[] }> };

let specCache: Spec | null = null;

/** PostgREST OpenAPI spec: the only introspection source, read-only by nature. */
const loadSpec = async (): Promise<Spec> => {
  if (specCache) return specCache;
  const { url, key } = env();
  const res = await fetch(`${url}/rest/v1/`, { headers: restHeaders(key) });
  if (!res.ok) throw new Error(`spec_fetch_failed_${res.status}`);
  specCache = (await res.json()) as Spec;
  return specCache;
};

const allowedTables = async (): Promise<string[]> => {
  const spec = await loadSpec();
  return Object.keys(spec.definitions || {})
    .filter((name) => !name.includes(".") && !TABLE_DENYLIST.has(name))
    .sort();
};

const assertTable = async (table: string) => {
  const tables = await allowedTables();
  if (!tables.includes(table)) throw new Error("table_not_allowed");
};

const columnsFor = async (table: string) => {
  const spec = await loadSpec();
  const props = spec.definitions?.[table]?.properties || {};
  const required = new Set(spec.definitions?.[table]?.required || []);
  return Object.entries(props).map(([name, meta]) => {
    const description = String(meta.description || "");
    const pk = /<pk\/>/.test(description);
    const fkMatch = description.match(/<fk table='([^']+)' column='([^']+)'\/>/);
    return {
      name,
      type: meta.format || meta.type || null,
      nullable: !required.has(name),
      primaryKey: pk,
      foreignKey: fkMatch ? { table: fkMatch[1], column: fkMatch[2] } : null,
      redacted: SENSITIVE_COLUMN.test(name) || TOKEN_COLUMN.test(name),
    };
  });
};

const cursorColumnFor = async (table: string, requested?: string) => {
  const cols = await columnsFor(table);
  const names = cols.map((c) => c.name);
  if (requested) {
    if (!names.includes(requested)) throw new Error("cursor_column_not_found");
    return requested;
  }
  const pk = cols.find((c) => c.primaryKey);
  if (pk) return pk.name;
  for (const candidate of ["id", "created_at", "updated_at"]) {
    if (names.includes(candidate)) return candidate;
  }
  throw new Error("no_stable_cursor");
};

/** Replace credential-ish values with a stable marker; keep null-ness for diffing. */
const redactRow = (row: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if ((SENSITIVE_COLUMN.test(k) || TOKEN_COLUMN.test(k)) && v !== null && v !== undefined) {
      out[k] = "[redacted]";
    } else {
      out[k] = v;
    }
  }
  return out;
};

const exactCount = async (table: string) => {
  const { url, key } = env();
  const res = await fetch(`${url}/rest/v1/${encodeURIComponent(table)}?select=*&limit=1`, {
    headers: restHeaders(key, { Prefer: "count=exact", Range: "0-0" }),
  });
  if (!res.ok) throw new Error(`count_failed_${res.status}`);
  const range = res.headers.get("content-range") || "";
  const total = Number(range.split("/")[1]);
  return Number.isFinite(total) ? total : null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 403 });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const auth = await authorize(req);
  if (auth === "unconfigured") return json({ error: "bridge_not_configured" }, 503);
  if (auth !== "ok") return json({ error: "unauthorized" }, 401);

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const action = String(body.action || "health");

  try {
    if (action === "health") {
      return json({
        ok: true,
        mode: "read_only",
        writes: false,
        deletes: false,
        rpc: false,
        rawSql: false,
        actions: ["health", "tables", "schema", "counts", "rows", "identity_map", "recipient_session_resolve"],
        maxPageSize: MAX_PAGE,
        defaultPageSize: DEFAULT_PAGE,
        schemas: ["public"],
        redaction: "credential/token-like columns replaced with \"[redacted]\"",
      });
    }

    if (action === "tables") {
      const tables = await allowedTables();
      return json({ ok: true, count: tables.length, tables, excluded: [...TABLE_DENYLIST].sort() });
    }

    if (action === "schema") {
      const requested = Array.isArray(body.tables) && body.tables.length
        ? body.tables.map(String)
        : await allowedTables();
      const out: Record<string, unknown> = {};
      for (const table of requested) {
        await assertTable(table);
        out[table] = { columns: await columnsFor(table) };
      }
      return json({ ok: true, tableCount: Object.keys(out).length, schema: out });
    }

    if (action === "counts") {
      const requested = Array.isArray(body.tables) && body.tables.length
        ? body.tables.map(String)
        : await allowedTables();
      const counts: Record<string, number | null> = {};
      const failed: Record<string, string> = {};
      for (const table of requested) {
        try {
          await assertTable(table);
          counts[table] = await exactCount(table);
        } catch (e) {
          failed[table] = e instanceof Error ? e.message.slice(0, 80) : "count_failed";
        }
      }
      return json({ ok: true, counts, failed });
    }

    if (action === "rows") {
      const table = String(body.table || "");
      await assertTable(table);
      const limit = Math.min(Math.max(Number(body.limit) || DEFAULT_PAGE, 1), MAX_PAGE);
      const cursorColumn = await cursorColumnFor(table, body.cursorColumn ? String(body.cursorColumn) : undefined);
      const after = body.after === undefined || body.after === null ? null : String(body.after);
      const keysOnly = body.keysOnly === true;

      const cols = await columnsFor(table);
      const select = keysOnly
        ? [...new Set([cursorColumn, ...cols.filter((c) => c.primaryKey).map((c) => c.name), ...cols.filter((c) => c.name === "updated_at" || c.name === "created_at").map((c) => c.name)])].join(",")
        : "*";

      const { url, key } = env();
      const params = new URLSearchParams();
      params.set("select", select);
      params.set("order", `${cursorColumn}.asc`);
      params.set("limit", String(limit));
      if (after !== null) params.append(cursorColumn, `gt.${after}`);

      const res = await fetch(`${url}/rest/v1/${encodeURIComponent(table)}?${params.toString()}`, {
        headers: restHeaders(key),
      });
      if (!res.ok) {
        return json({ error: "rows_failed", status: res.status, table }, 503);
      }
      const rows = (await res.json()) as Record<string, unknown>[];
      const sanitized = rows.map(redactRow);
      const last = rows.length ? rows[rows.length - 1][cursorColumn] : null;
      return json({
        ok: true,
        table,
        cursorColumn,
        limit,
        count: sanitized.length,
        hasMore: sanitized.length === limit,
        nextAfter: last === undefined ? null : last,
        rows: sanitized,
      });
    }

    if (action === "identity_map") {
      const limit = Math.min(Math.max(Number(body.limit) || DEFAULT_PAGE, 1), MAX_PAGE);
      const after = body.after ? String(body.after) : null;
      const { url, key } = env();

      const params = new URLSearchParams();
      params.set("select", "id,email,full_name,approval_status,created_at,updated_at");
      params.set("order", "id.asc");
      params.set("limit", String(limit));
      if (after) params.append("id", `gt.${after}`);
      const profilesRes = await fetch(`${url}/rest/v1/profiles?${params.toString()}`, { headers: restHeaders(key) });
      if (!profilesRes.ok) return json({ error: "identity_failed", status: profilesRes.status }, 503);
      const profiles = (await profilesRes.json()) as Record<string, unknown>[];
      const ids = profiles.map((p) => String(p.id));

      const inList = `(${ids.map((id) => `"${id}"`).join(",")})`;
      const [tenantRes, roleRes] = ids.length
        ? await Promise.all([
          fetch(`${url}/rest/v1/tenant_users?select=user_id,tenant_id,role,created_at&user_id=in.${inList}`, { headers: restHeaders(key) }),
          fetch(`${url}/rest/v1/user_roles?select=user_id,role&user_id=in.${inList}`, { headers: restHeaders(key) }),
        ])
        : [null, null];

      const tenantRows = tenantRes && tenantRes.ok ? await tenantRes.json() : [];
      const roleRows = roleRes && roleRes.ok ? await roleRes.json() : [];

      return json({
        ok: true,
        limit,
        count: profiles.length,
        hasMore: profiles.length === limit,
        nextAfter: ids.length ? ids[ids.length - 1] : null,
        profiles,
        tenantMemberships: tenantRows,
        applicationRoles: roleRows,
        note: "auth schema is not exposed; application identity keys are profiles.id (UUID)",
      });
    }

    if (action === "recipient_session_resolve") {
      // Strictly read-only: exact secure_token match, single row, no enumeration,
      // no writes, no token rotation/consumption. secure_token is never returned.
      const secureToken = typeof body.secure_token === "string" && body.secure_token
        ? body.secure_token
        : (typeof body.token === "string" ? body.token : "");
      if (!secureToken || secureToken.length < 16) {
        return json({ ok: false, resolved: false, reason: "invalid_token" }, 404);
      }

      const { url, key } = env();
      const params = new URLSearchParams();
      params.set(
        "select",
        [
          "id",
          "tenant_id",
          "display_name",
          "recipient_type",
          "provider",
          "provider_account_id",
          "environment",
          "onboarding_status",
          "bank_linked_at",
          "provider_bank_name",
          "provider_last_four",
          "token_expires_at",
          "token_used_at",
          "created_at",
          "updated_at",
        ].join(","),
      );
      params.set("secure_token", `eq.${secureToken}`);
      params.set("limit", "1");

      const res = await fetch(`${url}/rest/v1/external_payment_recipients?${params.toString()}`, {
        headers: restHeaders(key),
      });
      if (!res.ok) return json({ error: "recipient_resolve_failed", status: res.status }, 503);
      const rows = (await res.json()) as Record<string, unknown>[];
      const recipient = rows[0];
      if (!recipient) return json({ ok: false, resolved: false, reason: "invalid_token" }, 404);

      const expiresAt = recipient.token_expires_at ? new Date(String(recipient.token_expires_at)) : null;
      if (expiresAt && expiresAt.getTime() < Date.now()) {
        return json({ ok: false, resolved: false, reason: "token_expired" }, 410);
      }
      if (recipient.token_used_at) {
        return json({ ok: false, resolved: false, reason: "token_used" }, 410);
      }

      delete (recipient as Record<string, unknown>).secure_token;
      return json({
        ok: true,
        resolved: true,
        mode: "read_only",
        recipient,
      });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "bridge_failed";
    const status = /not_allowed|not_found|no_stable_cursor/.test(message) ? 400 : 503;
    return json({ error: "bridge_failed", message: message.slice(0, 180) }, status);
  }
});
