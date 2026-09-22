/** Path-derived tenant slug for AWS request context. Server membership-checks it. */

const RESERVED_SEGMENTS = new Set([
  "account",
  "admin",
  "api",
  "auth",
  "checks",
  "claims",
  "data",
  "endorse",
  "find-a-pro",
  "forgot-password",
  "h",
  "health",
  "identity",
  "invoice",
  "ledger",
  "login",
  "mortgage-ops",
  "pay-setup",
  "payment-direction",
  "payments",
  "prep",
  "pricing",
  "privacy-notice",
  "pros",
  "reset-password",
  "security",
  "settings",
  "sign",
  "signup",
  "start-claim",
  "terms",
  "terms-of-service",
  "unsubscribe",
  "verify-account",
  "wl",
]);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function activeTenantSlugFromPath(pathname: string): string | null {
  const parts = String(pathname || "").split("/").filter(Boolean);
  while (parts[0] === "prep" || parts[0] === "wl") {
    parts.shift();
  }
  const candidate = String(parts[0] || "").toLowerCase();
  if (!candidate || RESERVED_SEGMENTS.has(candidate)) return null;
  if (UUID_RE.test(candidate)) return null;
  if (!SLUG_RE.test(candidate)) return null;
  return candidate;
}
