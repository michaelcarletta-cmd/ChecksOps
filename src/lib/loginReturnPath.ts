/**
 * Keeps the page a signed-out (or session-expired) user was on, so signing in
 * again returns them there instead of always to the Check Command Center.
 *
 * Pure module (no "@/" imports) so aws/tests can import it directly.
 */
export const LOGIN_NEXT_PARAM = "next";

function normalizeBase(basePath: string): string {
  const base = String(basePath || "").trim();
  if (!base || base === "/") return "";
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

/**
 * Returns `next` only when it is a same-origin path inside this tenant's
 * routes (`{basePath}/...`) and is not the login page itself. Anything else
 * (absolute URLs, protocol-relative `//host`, backslashes, other tenants,
 * the login route) returns null so the caller uses its default.
 */
export function safeLoginReturnPath(
  next: string | null | undefined,
  basePath: string,
): string | null {
  if (typeof next !== "string" || !next) return null;
  let value = next.trim();
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (value.includes("\\") || /[\u0000-\u001f]/.test(value)) return null;
  if (/^\/[^/?#]*:/.test(value)) return null;
  const base = normalizeBase(basePath);
  const pathOnly = value.split(/[?#]/, 1)[0];
  if (base && pathOnly !== base && !pathOnly.startsWith(`${base}/`)) return null;
  const rest = base ? pathOnly.slice(base.length) : pathOnly;
  if (rest === "" || rest === "/" || rest === "/login" || rest.startsWith("/login/")) return null;
  // Collapse dot segments so "/acme/../other/checks" cannot leave the tenant.
  if (pathOnly.split("/").some((seg) => seg === ".." || seg === ".")) return null;
  value = value.replace(/#.*$/, "");
  return value;
}

/** `{basePath}/login?next=<current path + search>` for a redirect to sign-in. */
export function loginPathWithNext(
  basePath: string,
  current: { pathname: string; search?: string },
): string {
  const base = normalizeBase(basePath);
  const loginPath = `${base}/login`;
  const next = safeLoginReturnPath(`${current.pathname}${current.search ?? ""}`, base);
  if (!next) return loginPath;
  return `${loginPath}?${LOGIN_NEXT_PARAM}=${encodeURIComponent(next)}`;
}

/** Where to go after a successful sign-in: the saved page, or `{basePath}/checks`. */
export function postLoginPath(basePath: string, search: string | null | undefined): string {
  const base = normalizeBase(basePath);
  let next: string | null = null;
  try {
    next = new URLSearchParams(search ?? "").get(LOGIN_NEXT_PARAM);
  } catch {
    next = null;
  }
  return safeLoginReturnPath(next, base) ?? `${base}/checks`;
}
