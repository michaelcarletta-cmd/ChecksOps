import {
  AWS_STAGING_AUTH_SESSION_KEY,
  AWS_STAGING_MORTGAGE_AUTH_SESSION_KEY,
  awsApiBaseUrl,
} from "@/lib/awsStaging";
import { toStorageObjectPath } from "@/lib/storagePath";

const storageError = (message: string, statusCode = 403) => ({
  message,
  name: "StorageApiError",
  statusCode,
});

type TokenGetter = () => Promise<string | null>;

/** Prefer CheckOps session; fall back to Mortgage Desk if only that portal is signed in. */
const readIdToken = (): string | null => {
  for (const key of [AWS_STAGING_AUTH_SESSION_KEY, AWS_STAGING_MORTGAGE_AUTH_SESSION_KEY]) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const token = parsed?.tokens?.idToken;
      if (typeof token === "string" && token) return token;
    } catch {
      /* try next portal key */
    }
  }
  return null;
};

async function apiFetch(path: string, init: RequestInit, token?: string | null) {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${awsApiBaseUrl()}${path}`, { ...init, headers });
  let body: Record<string, unknown> = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return { response, body };
}

export function rewriteSupabaseStorageUrl(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const match = value.match(
    /^https?:\/\/[^/]*supabase\.co\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/([^?]+)/i,
  );
  if (!match) return value;
  const bucket = match[1];
  const path = decodeURIComponent(match[2]);
  if (bucket === "tenant-logos" || bucket === "email-assets" || bucket === "company-branding") {
    return `${awsApiBaseUrl()}/storage/public?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(path)}`;
  }
  return value;
}

export function rewriteStorageFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteStorageFields);
  if (!value || typeof value !== "object") return rewriteSupabaseStorageUrl(value);
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (typeof nested === "string" && /(_url|logoUrl)$/i.test(key)) {
      out[key] = rewriteSupabaseStorageUrl(nested);
    } else if (nested && typeof nested === "object") {
      out[key] = rewriteStorageFields(nested);
    } else {
      out[key] = nested;
    }
  }
  return out;
}

export function createAwsStorageAdapter(opts: { getToken?: TokenGetter } = {}) {
  const getToken = opts.getToken || (async () => readIdToken());

  const from = (bucket: string) => {
    const signOne = async (rawPath: string, expiresIn = 300, download?: string | boolean) => {
      const path = toStorageObjectPath(rawPath, bucket) || rawPath;
      if (!path || !String(path).trim() || /pending_front/i.test(String(path))) {
        return { data: null, error: storageError("object_not_in_s3", 404) };
      }
      const token = await getToken();
      if (!token) {
        return { data: null, error: storageError("JWT expired", 401) };
      }
      const { response, body } = await apiFetch("/storage/sign", {
        method: "POST",
        body: JSON.stringify({ bucket, path, expiresIn, download: download || undefined }),
      }, token);
      if (!response.ok || !body.signedUrl) {
        return {
          data: null,
          error: storageError(String(body.message || body.error || "storage_forbidden"), Number(body.statusCode || response.status)),
        };
      }
      return {
        data: {
          signedUrl: String(body.signedUrl),
          path: String(body.path || path),
          signedUrlExpiresAt: body.signedUrlExpiresAt || null,
        },
        error: null,
      };
    };

    return {
      bucket,
      upload: async (rawPath: string, file: Blob, options?: { contentType?: string; upsert?: boolean }) => {
        const path = toStorageObjectPath(rawPath, bucket) || rawPath;
        const token = await getToken();
        if (!token) {
          return { data: null, error: storageError("JWT expired", 401) };
        }
        const contentType = options?.contentType || (file as File).type || "application/octet-stream";
        const upsert = options?.upsert === true;
        const { response, body } = await apiFetch("/storage/upload-url", {
          method: "POST",
          body: JSON.stringify({
            bucket,
            path,
            contentType,
            upsert,
            contentLength: typeof file.size === "number" ? file.size : undefined,
          }),
        }, token);
        if (!response.ok || !body.uploadUrl) {
          return {
            data: null,
            error: storageError(String(body.message || body.error || "uploads_disabled"), Number(body.statusCode || response.status)),
          };
        }
        const headers: Record<string, string> = { "content-type": contentType };
        const put = await fetch(String(body.uploadUrl), { method: "PUT", headers, body: file });
        if (!put.ok) {
          return { data: null, error: storageError("upload_failed", put.status) };
        }
        const storedPath = String(body.path || path);
        return {
          data: { path: storedPath, id: storedPath, fullPath: `${bucket}/${storedPath}` },
          error: null,
        };
      },
      update: async (rawPath: string, file: Blob, options?: { contentType?: string }) =>
        from(bucket).upload(rawPath, file, { ...options, upsert: true }),
      remove: async (paths: string[]) => {
        const token = await getToken();
        if (!token) return { data: null, error: storageError("JWT expired", 401) };
        const normalized = (paths || []).map((p) => toStorageObjectPath(p, bucket) || p);
        const { response, body } = await apiFetch("/storage/delete", {
          method: "POST",
          body: JSON.stringify({ bucket, paths: normalized }),
        }, token);
        if (!response.ok) {
          return { data: null, error: storageError(String(body.message || body.error || "uploads_disabled"), Number(body.statusCode || response.status)) };
        }
        return { data: (body.deleted as unknown[]) || normalized, error: null };
      },
      move: async (fromPath: string, toPath: string) => {
        const token = await getToken();
        if (!token) return { data: null, error: storageError("JWT expired", 401) };
        const { response, body } = await apiFetch("/storage/move", {
          method: "POST",
          body: JSON.stringify({
            bucket,
            from: toStorageObjectPath(fromPath, bucket) || fromPath,
            to: toStorageObjectPath(toPath, bucket) || toPath,
          }),
        }, token);
        if (!response.ok) {
          return { data: null, error: storageError(String(body.message || body.error || "uploads_disabled"), Number(body.statusCode || response.status)) };
        }
        return { data: { path: String(body.to || toPath) }, error: null };
      },
      download: async (rawPath: string) => {
        const signed = await signOne(rawPath, 300);
        if (signed.error || !signed.data?.signedUrl) {
          return { data: null, error: signed.error };
        }
        const file = await fetch(signed.data.signedUrl);
        if (!file.ok) {
          return { data: null, error: storageError("download_failed", file.status) };
        }
        const blob = await file.blob();
        return { data: blob, error: null };
      },
      list: async (prefix = "", options?: { limit?: number; offset?: number }) => {
        const token = await getToken();
        if (!token) return { data: [], error: storageError("JWT expired", 401) };
        const { response, body } = await apiFetch("/storage/list", {
          method: "POST",
          body: JSON.stringify({
            bucket,
            prefix,
            path: prefix,
            limit: options?.limit,
            offset: options?.offset,
          }),
        }, token);
        if (!response.ok) {
          return { data: [], error: storageError(String(body.message || body.error || "storage_forbidden"), response.status) };
        }
        return { data: (body.data as unknown[]) || [], error: null };
      },
      createSignedUrl: async (rawPath: string, expiresIn = 300, options?: { download?: string | boolean }) =>
        signOne(rawPath, expiresIn, options?.download),
      createSignedUrls: async (paths: string[], expiresIn = 300) => {
        const token = await getToken();
        if (!token) return { data: [], error: storageError("JWT expired", 401) };
        const normalized = paths.map((p) => toStorageObjectPath(p, bucket) || p);
        const { response, body } = await apiFetch("/storage/sign-many", {
          method: "POST",
          body: JSON.stringify({ bucket, paths: normalized, expiresIn }),
        }, token);
        if (!response.ok) {
          return { data: [], error: storageError(String(body.message || body.error || "storage_forbidden"), response.status) };
        }
        return { data: (body.data as unknown[]) || [], error: null };
      },
      getPublicUrl: (rawPath: string) => {
        const path = toStorageObjectPath(rawPath, bucket) || rawPath;
        const publicUrl = `${awsApiBaseUrl()}/storage/public?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(path)}`;
        return { data: { publicUrl } };
      },
    };
  };

  return { from };
}

export const STAGING_STORAGE_BUCKETS = [
  "claim-files",
  "deposit-attachments",
  "loss-draft-documents",
  "company-branding",
  "tenant-logos",
  "tenant-documents",
  "endorsement-packets",
  "homeowner-uploads",
] as const;
