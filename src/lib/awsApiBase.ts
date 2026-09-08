/**
 * Resolve the AWS HTTP API base used by the Cognito SPA.
 * Production Step 2 uses same-origin `/prep` so apex and www stay same-origin.
 * Staging keeps an absolute execute-api URL.
 */
export function resolveAwsApiBaseUrl(configured: string, windowOrigin?: string): string {
  const value = String(configured || "").trim().replace(/\/$/, "");
  const token = value.toLowerCase();
  if (token === "/prep" || token === "same-origin" || token === "same-origin:/prep") {
    if (windowOrigin) {
      return new URL("/prep", windowOrigin).toString().replace(/\/$/, "");
    }
    return "/prep";
  }
  return value;
}
