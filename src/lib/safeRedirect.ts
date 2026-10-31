/**
 * Post-auth redirect targets taken from the URL (`?next=`) must stay on this
 * origin. A value that could send the browser to another site (absolute URLs
 * on another origin, protocol-relative `//host`, `/\host`, `javascript:` and
 * other schemes, backslashes, control characters) is rejected so the caller
 * falls back to its default.
 *
 * Pure module (no "@/" imports) so aws/tests can import it directly.
 */

// C0 controls, DEL and C1 controls. Browsers strip tab/CR/LF out of URLs, so
// "/\t/evil.example" would otherwise become "//evil.example".
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Returns `value` only when it is a same-origin relative path: it starts with
 * exactly one "/", is not "//..." or "/\...", has no backslashes, no control
 * characters and no scheme. Anything else returns null.
 */
export function safeRelativePath(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !value) return null;
  if (hasControlChars(value)) return null;
  if (value.includes("\\")) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  // A scheme-looking first segment ("/javascript:..." is a path, but keep the
  // rule simple and strict: no ":" before the first "/", "?" or "#").
  if (/^\/[^/?#]*:/.test(value)) return null;
  return value;
}

/**
 * Where to send the browser after an auth step, given an untrusted `next`.
 *
 * - A same-origin relative path is returned as is.
 * - An absolute http(s) URL on exactly `origin` (the current page's origin) is
 *   reduced to its path, query and hash, then checked as a relative path. The
 *   existing reset-link producers send `https://checksops.com/<slug>/login`.
 * - Everything else (other origins, other schemes, malformed values) returns
 *   `fallback`.
 */
export function safeRedirectPath(
  next: string | null | undefined,
  origin: string,
  fallback = "/login",
): string {
  if (typeof next !== "string" || !next) return fallback;
  const relative = safeRelativePath(next);
  if (relative) return relative;
  if (hasControlChars(next) || next.includes("\\")) return fallback;
  if (!/^https?:\/\//i.test(next)) return fallback;
  let parsed: URL;
  let current: URL;
  try {
    parsed = new URL(next);
    current = new URL(origin);
  } catch {
    return fallback;
  }
  if (parsed.username || parsed.password) return fallback;
  if (parsed.origin !== current.origin) return fallback;
  return safeRelativePath(`${parsed.pathname}${parsed.search}${parsed.hash}`) ?? fallback;
}
