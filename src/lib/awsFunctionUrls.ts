/**
 * Same-origin /prep Class A function URLs for the Cognito SPA.
 * Do not concatenate VITE_SUPABASE_URL — production-aws blanks that env
 * and the request would hit the frontend origin instead of Lambda.
 */

export function resolveAwsFunctionUrl(
  apiBaseUrl: string,
  name: string,
  query?: Record<string, string | undefined | null>,
): string {
  const base = String(apiBaseUrl || "").replace(/\/$/, "");
  const path = `${base}/functions/v1/${encodeURIComponent(name)}`;
  if (!query) return path;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === "") continue;
    qs.set(key, String(value));
  }
  const encoded = qs.toString();
  return encoded ? `${path}?${encoded}` : path;
}

export function emailUnsubscribeUrl(apiBaseUrl: string, token: string): string {
  return resolveAwsFunctionUrl(apiBaseUrl, "handle-email-unsubscribe", { token });
}

export function moovAccountFileUploadUrl(apiBaseUrl: string): string {
  return resolveAwsFunctionUrl(apiBaseUrl, "moov-account-file-upload");
}

export type UnsubscribeView =
  | { kind: "valid"; email: string }
  | { kind: "already" }
  | { kind: "invalid"; message: string }
  | { kind: "done"; email: string }
  | { kind: "error"; message: string };

const already = (json: Record<string, unknown> | null) =>
  Boolean(
    json?.alreadyUnsubscribed
      || json?.reason === "already_unsubscribed"
      || (json?.success === false && json?.reason === "already_unsubscribed"),
  );

export function interpretUnsubscribeGet(
  status: number,
  json: Record<string, unknown> | null,
): UnsubscribeView {
  if (status >= 200 && status < 300) {
    if (already(json)) return { kind: "already" };
    if (json?.valid === false) {
      return { kind: "invalid", message: String(json?.error || json?.message || "Invalid or expired link.") };
    }
    return { kind: "valid", email: String(json?.email || "") };
  }
  return { kind: "invalid", message: String(json?.error || json?.message || "Invalid or expired link.") };
}

export function interpretUnsubscribeConfirm(
  status: number,
  json: Record<string, unknown> | null,
  email = "",
): UnsubscribeView {
  if (status >= 200 && status < 300) {
    if (already(json)) return { kind: "already" };
    if (json?.success === false && json?.error) {
      return { kind: "error", message: String(json.error) };
    }
    return { kind: "done", email: String(json?.email || email) };
  }
  return { kind: "error", message: String(json?.error || json?.message || "Unsubscribe failed.") };
}
