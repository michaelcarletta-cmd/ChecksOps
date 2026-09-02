// Temporary migration-only bridge: read-only Storage inventory + short-lived signed URLs
// for the AWS staging copy. No deletes, no production DB writes, no browser CORS.
// Token-gated with a SHA-256 hash of a migration token held outside this codebase.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// SHA-256 (hex, lowercase) of the migration token. Configure in Project Settings -> Secrets.
const TOKEN_SHA256 = (Deno.env.get("AWS_MIGRATION_TOKEN_SHA256") ?? "").trim().toLowerCase();

const MAX_SIGN_OBJECTS = 20;
const SIGNED_URL_TTL_SECONDS = 120;

// Buckets that must never be exposed through this bridge.
const EXCLUDED_BUCKETS = new Set([
  "ai-knowledge-base",
  "db-exports",
  "database-exports",
  "database-export",
  "db-export",
  "backups",
]);

const JSON_HEADERS = { "Content-Type": "application/json" };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

async function sha256Hex(input: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function approvedBuckets(): Promise<string[]> {
  const { data, error } = await admin.storage.listBuckets();
  if (error) throw new Error(`bucket_list_failed: ${error.message}`);
  return (data ?? []).map((b) => b.name).filter((name) => !EXCLUDED_BUCKETS.has(name));
}

async function listObjects(bucket: string, prefix: string, limit: number, offset: number) {
  const { data, error } = await admin.storage.from(bucket).list(prefix, {
    limit,
    offset,
    sortBy: { column: "name", order: "asc" },
  });
  if (error) throw new Error(`list_failed: ${error.message}`);
  return data ?? [];
}

Deno.serve(async (req) => {
  // Server-to-server only: no CORS preflight support by design.
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  if (!TOKEN_SHA256) {
    return json(
      { error: "bridge_not_configured", detail: "AWS_MIGRATION_TOKEN_SHA256 secret is not set" },
      503,
    );
  }

  const presented = req.headers.get("x-checksops-migration-token") ?? "";
  if (!presented) return json({ error: "unauthorized" }, 401);
  const presentedHash = await sha256Hex(presented);
  if (!timingSafeEqual(presentedHash, TOKEN_SHA256)) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: Record<string, unknown> = {};
  try {
    const raw = await req.text();
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const action = typeof body.action === "string" ? body.action : "health";

  try {
    if (action === "health") {
      return json({
        status: "ok",
        mode: "migration-bridge",
        actions: ["health", "inventory", "sign"],
        max_sign_objects: MAX_SIGN_OBJECTS,
        signed_url_ttl_seconds: SIGNED_URL_TTL_SECONDS,
        approved_buckets: await approvedBuckets(),
      });
    }

    if (action === "inventory") {
      const requested = typeof body.bucket === "string" ? body.bucket : null;
      const prefix = typeof body.prefix === "string" ? body.prefix : "";
      const limit = Math.min(Number(body.limit ?? 100) || 100, 1000);
      const offset = Math.max(Number(body.offset ?? 0) || 0, 0);

      const allowed = await approvedBuckets();
      const buckets = requested ? [requested] : allowed;
      if (requested && !allowed.includes(requested)) {
        return json({ error: "bucket_not_approved" }, 403);
      }

      const results: Record<string, unknown>[] = [];
      for (const bucket of buckets) {
        const items = await listObjects(bucket, prefix, limit, offset);
        results.push({
          bucket,
          prefix,
          count: items.length,
          objects: items.map((o) => ({
            name: o.name,
            id: o.id,
            updated_at: o.updated_at,
            created_at: o.created_at,
            size: (o.metadata as { size?: number } | null)?.size ?? null,
            mimetype: (o.metadata as { mimetype?: string } | null)?.mimetype ?? null,
          })),
        });
      }
      return json({ status: "ok", limit, offset, buckets: results });
    }

    if (action === "sign") {
      const bucket = typeof body.bucket === "string" ? body.bucket : "";
      const paths = Array.isArray(body.paths) ? body.paths.filter((p) => typeof p === "string") : [];
      if (!bucket) return json({ error: "bucket_required" }, 400);
      if (paths.length === 0) return json({ error: "paths_required" }, 400);
      if (paths.length > MAX_SIGN_OBJECTS) {
        return json({ error: "too_many_paths", max: MAX_SIGN_OBJECTS }, 400);
      }
      const allowed = await approvedBuckets();
      if (!allowed.includes(bucket)) return json({ error: "bucket_not_approved" }, 403);

      const { data, error } = await admin.storage
        .from(bucket)
        .createSignedUrls(paths as string[], SIGNED_URL_TTL_SECONDS);
      if (error) return json({ error: "sign_failed", detail: error.message }, 502);

      return json({
        status: "ok",
        bucket,
        expires_in: SIGNED_URL_TTL_SECONDS,
        urls: (data ?? []).map((d) => ({
          path: d.path,
          signed_url: d.signedUrl,
          error: d.error ?? null,
        })),
      });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    return json({ error: "bridge_error", detail: e instanceof Error ? e.message : "unknown" }, 500);
  }
});
