/**
 * Temporary ChecksOps AWS staging Storage COPY bridge.
 *
 * Runs inside Lovable/Supabase Edge runtime so SUPABASE_SERVICE_ROLE_KEY stays
 * on the platform. This function never returns that key, never deletes Storage
 * objects, and never mutates the production database.
 *
 * Auth: x-checksops-migration-token compared to SHA-256 (timing-safe).
 * Browser CORS is intentionally omitted so normal application users cannot call it.
 *
 * Remove this function after the COPY reconciles to 1,334 application objects.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const APP_BUCKETS = new Set([
  "claim-files",
  "claim-files-backup",
  "company-branding",
  "contractor-documents",
  "deposit-attachments",
  "document-templates",
  "email-assets",
  "endorsement-packets",
  "homeowner-uploads",
  "loss-draft-documents",
  "tenant-documents",
  "tenant-logos",
]);

const SKIP_BUCKETS = new Set([
  "ai-knowledge-base",
  "database_export_01_09_26",
  "database-export",
  "database_export",
]);

const MAX_SIGN = 50;
const SIGN_TTL_SECONDS = 300;
const MAX_INVENTORY = 500;
const JSON_HEADERS = { "Content-Type": "application/json" };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

const sha256Hex = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const timingSafeEqualHex = (left: string, right: string) => {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return mismatch === 0;
};

const expectedTokenSha256 = () =>
  String(
    Deno.env.get("AWS_MIGRATION_TOKEN_SHA256") ||
      Deno.env.get("CHECKSOPS_STORAGE_MIGRATION_TOKEN_SHA256") ||
      "",
  ).trim().toLowerCase();

/** Returns "unconfigured" when no token hash secret is present (fail closed). */
const authorize = async (req: Request): Promise<"ok" | "denied" | "unconfigured"> => {
  const expected = expectedTokenSha256();
  if (!expected) return "unconfigured";
  const token =
    req.headers.get("x-checksops-migration-token") ||
    req.headers.get("x-migration-token") ||
    "";
  if (!token) return "denied";
  const digest = await sha256Hex(token);
  return timingSafeEqualHex(digest, expected) ? "ok" : "denied";
};

const allowedBucket = (bucket: string) => APP_BUCKETS.has(bucket) && !SKIP_BUCKETS.has(bucket);

const adminClient = () => {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!url || !key) throw new Error("platform_credentials_missing");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 403 });
  }
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }
  const auth = await authorize(req);
  if (auth === "unconfigured") {
    return json({ error: "bridge_not_configured" }, 503);
  }
  if (auth !== "ok") {
    return json({ error: "unauthorized" }, 401);
  }

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
        mode: "sign_only",
        deletes: false,
        dbWrites: false,
        maxSign: MAX_SIGN,
        signTtlSeconds: SIGN_TTL_SECONDS,
      });
    }

    const admin = adminClient();

    if (action === "inventory") {
      const buckets = (Array.isArray(body.buckets) ? body.buckets : [...APP_BUCKETS])
        .map((item) => String(item))
        .filter(allowedBucket);
      const limit = Math.min(Math.max(Number(body.limit) || 100, 1), MAX_INVENTORY);
      const offset = Math.max(Number(body.offset) || 0, 0);
      const { data, error } = await admin
        .schema("storage")
        .from("objects")
        .select("bucket_id,name,metadata,created_at")
        .in("bucket_id", buckets)
        .order("bucket_id", { ascending: true })
        .order("name", { ascending: true })
        .range(offset, offset + limit - 1);
      if (error) return json({ error: "inventory_failed", message: error.message }, 503);
      const objects = (data || []).filter((row) => allowedBucket(String(row.bucket_id))).map((row) => {
        const metadata = (row.metadata || {}) as Record<string, unknown>;
        return {
          bucket: row.bucket_id,
          name: row.name,
          size: Number(metadata.size || metadata.contentLength || 0) || null,
          mimetype: metadata.mimetype || metadata.contentType || null,
          createdAt: row.created_at || null,
          etag: (metadata.eTag ?? metadata.etag ?? null) as string | null,
          cacheControl: (metadata.cacheControl ?? null) as string | null,
          lastModified: (metadata.lastModified ?? null) as string | null,
        };
      });
      return json({
        ok: true,
        offset,
        limit,
        count: objects.length,
        objects,
      });
    }

    if (action === "sign") {
      const items = Array.isArray(body.items) ? body.items : [];
      if (items.length === 0 || items.length > MAX_SIGN) {
        return json({ error: "invalid_batch", maxSign: MAX_SIGN }, 400);
      }
      const signed = [];
      const failed = [];
      for (const item of items) {
        const bucket = String(item?.bucket || "");
        const name = String(item?.name || "").replace(/^\/+/, "");
        if (!allowedBucket(bucket) || !name || name.includes("..") || name.startsWith("Migration/")) {
          failed.push({ bucket, name, reason: "bucket_or_path_not_allowed" });
          continue;
        }
        const { data, error } = await admin.storage.from(bucket).createSignedUrl(name, SIGN_TTL_SECONDS);
        if (error || !data?.signedUrl) {
          failed.push({ bucket, name, reason: "sign_failed" });
          continue;
        }
        signed.push({
          bucket,
          name,
          signedUrl: data.signedUrl,
          expiresIn: SIGN_TTL_SECONDS,
        });
      }
      return json({ ok: true, signedCount: signed.length, failedCount: failed.length, signed, failed });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "bridge_failed";
    return json({ error: "bridge_failed", message: message.slice(0, 180) }, 503);
  }
});
