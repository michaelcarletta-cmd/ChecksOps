/**
 * Temporary staging-only Homeowner ledger-view error diagnostic.
 * Shows HTTP status + allowlisted API error code on the existing generic
 * error screen so iPhone Preview can distinguish 404 vs 503.
 *
 * Never returns token, URL, request body, Authorization, tenant/claim IDs,
 * homeowner information, stack traces, or raw backend details.
 */

export const SAFE_HOMEOWNER_LEDGER_VIEW_CODES = Object.freeze({
  invalid_token: 400,
  not_found: 404,
  revoked: 410,
  expired: 410,
  ledger_view_failed: 503,
} as const);

export type SafeHomeownerLedgerViewCode = keyof typeof SAFE_HOMEOWNER_LEDGER_VIEW_CODES;

export type HomeownerLedgerViewDiagnostic = {
  status: 400 | 404 | 410 | 503;
  code: SafeHomeownerLedgerViewCode;
};

const STATUS_TO_CODE = Object.freeze({
  400: "invalid_token",
  404: "not_found",
  503: "ledger_view_failed",
} as const);

const PRODUCTION_HOSTS = new Set([
  "checksops.com",
  "www.checksops.com",
  "app.checksops.com",
  "checkops.com",
  "www.checkops.com",
  "production.checksops.com",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function safeCode(value: unknown): SafeHomeownerLedgerViewCode | null {
  const code = String(value || "").trim();
  return Object.prototype.hasOwnProperty.call(SAFE_HOMEOWNER_LEDGER_VIEW_CODES, code)
    ? code as SafeHomeownerLedgerViewCode
    : null;
}

function safeStatus(value: unknown): HomeownerLedgerViewDiagnostic["status"] | null {
  const status = Number(value);
  if (status === 400 || status === 404 || status === 410 || status === 503) return status;
  return null;
}

export function isHomeownerLedgerViewDiagnosticEnabled(input: {
  hostname?: string;
} = {}): boolean {
  const hostname = String(input.hostname || "").trim().toLowerCase();
  if (!hostname) return false;
  if (PRODUCTION_HOSTS.has(hostname)) return false;
  if (hostname.endsWith(".prod.checksops.com")) return false;
  if (hostname === "staging.checksops.com") return true;
  return hostname.startsWith("staging.") && hostname.endsWith(".checksops.com");
}

export function extractHomeownerLedgerViewDiagnostic(
  error: unknown,
): HomeownerLedgerViewDiagnostic | null {
  const obj = asRecord(error);
  const context = asRecord(obj?.context);
  const body = asRecord(context?.body);

  const code = safeCode(body?.error)
    || safeCode(obj?.message)
    || safeCode(typeof error === "string" ? error : "");
  let status = safeStatus(context?.status)
    || safeStatus(obj?.status)
    || safeStatus(obj?.statusCode);

  if (code && !status) status = SAFE_HOMEOWNER_LEDGER_VIEW_CODES[code];
  if (status && !code) {
    const inferred = STATUS_TO_CODE[status as 400 | 404 | 503];
    if (!inferred) return null;
    return { status, code: inferred };
  }
  if (!code || !status) return null;
  return { status, code };
}

export function formatHomeownerLedgerViewDiagnostic(
  diagnostic: HomeownerLedgerViewDiagnostic | null,
): string | null {
  if (!diagnostic) return null;
  return `Diagnostic: ${diagnostic.status} — ${diagnostic.code}`;
}

export function homeownerLedgerViewDiagnosticLine(
  error: unknown,
  input: { hostname?: string } = {},
): string | null {
  if (!isHomeownerLedgerViewDiagnosticEnabled(input)) return null;
  return formatHomeownerLedgerViewDiagnostic(extractHomeownerLedgerViewDiagnostic(error));
}
