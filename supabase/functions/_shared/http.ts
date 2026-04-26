/**
 * Shared HTTP helpers for Supabase Edge Functions.
 *
 * Why this exists:
 * - 124+ functions duplicated CORS headers, OPTIONS handling, JSON wrappers
 *   and "Bearer …" token parsing. One typo in a header (e.g. forgetting
 *   `apikey` in Allow-Headers) silently breaks the front-end.
 * - Centralising the boilerplate means you fix it once for the whole fleet.
 *
 * Conventions:
 * - Always spread `...corsHeaders` into responses.
 * - Always handle `OPTIONS` first via `handleCors(req)`.
 * - Use `jsonResponse` / `errorResponse` instead of constructing `new Response`
 *   manually so headers stay consistent.
 */

/* ---------- CORS ---------- */

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, " +
    "x-supabase-client-platform, x-supabase-client-platform-version, " +
    "x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, PUT, DELETE, PATCH",
};

/** Returns a CORS pre-flight response if `req` is an OPTIONS request, else null. */
export function handleCors(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  return null;
}

/* ---------- JSON responses ---------- */

const JSON_HEADERS = { "Content-Type": "application/json", ...corsHeaders };

export function jsonResponse(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: extraHeaders ? { ...JSON_HEADERS, ...extraHeaders } : JSON_HEADERS,
  });
}

/**
 * Standardised error response. Logs to console for observability and returns
 * `{ error: <message> }` JSON with the given HTTP status.
 */
export function errorResponse(
  message: string,
  status = 500,
  details?: unknown,
): Response {
  if (details !== undefined) {
    console.error(`[edge-error ${status}] ${message}`, details);
  } else if (status >= 500) {
    console.error(`[edge-error ${status}] ${message}`);
  }
  return jsonResponse({ error: message }, status);
}

/* ---------- Auth ---------- */

/** Extracts the raw JWT (without the "Bearer " prefix) or returns null. */
export function getBearerToken(req: Request): string | null {
  const auth = req.headers.get("Authorization") ?? req.headers.get("authorization");
  if (!auth || !auth.toLowerCase().startsWith("bearer ")) return null;
  return auth.slice(7).trim() || null;
}

/** Convenience wrapper that returns a 401 errorResponse when missing. */
export function requireBearerToken(req: Request): { token: string } | { response: Response } {
  const token = getBearerToken(req);
  if (!token) {
    return { response: errorResponse("Unauthorized: missing bearer token", 401) };
  }
  return { token };
}
