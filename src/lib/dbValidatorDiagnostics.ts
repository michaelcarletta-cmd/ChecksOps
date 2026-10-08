/**
 * Staging-only, admin-only view of the existing GET /db-readonly-validate route.
 * Read-only: GET with no body, Authorization header only. Only allowlisted,
 * pattern-checked issue fields are surfaced; messages, credentials, hosts and
 * row data from the response are never returned, logged or persisted.
 */

export const DB_VALIDATOR_PATH = "/db-readonly-validate";
export const DB_VALIDATOR_STAGING_HOSTNAME = "staging.checksops.com";

const SEVERITIES = new Set(["error", "warning", "expected", "info"]);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;
const MAX_ISSUES = 100;

export type DbValidatorIssue = {
  kind: string;
  severity: string;
  code: string | null;
  table: string | null;
  probe: string | null;
};

export type DbValidatorSummary = {
  ok: boolean;
  readOnly: boolean | null;
  issues: DbValidatorIssue[];
};

export type DbValidatorOutcome =
  | { status: "success"; summary: DbValidatorSummary }
  | { status: "unauthorized"; message: string }
  | { status: "error"; message: string };

export function isDbValidatorUiEnabled(params: {
  authProvider?: string | null;
  hostname?: string | null;
  isAdmin: boolean;
}): boolean {
  return (
    params.isAdmin === true &&
    String(params.authProvider || "").toLowerCase() === "cognito" &&
    String(params.hostname || "").toLowerCase() === DB_VALIDATOR_STAGING_HOSTNAME
  );
}

const safeIdentifier = (value: unknown): string | null =>
  typeof value === "string" && IDENTIFIER.test(value) ? value : null;

export function sanitizeDbValidatorResult(body: unknown): DbValidatorSummary {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const rawIssues = Array.isArray(record.issues) ? record.issues.slice(0, MAX_ISSUES) : [];
  const issues = rawIssues.map((raw): DbValidatorIssue => {
    const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    return {
      kind: safeIdentifier(item.kind) || "unknown",
      severity: typeof item.severity === "string" && SEVERITIES.has(item.severity) ? item.severity : "unknown",
      code: typeof item.code === "string" && SQLSTATE.test(item.code) ? item.code : null,
      table: safeIdentifier(item.table),
      probe: safeIdentifier(item.probe),
    };
  });
  return {
    ok: record.ok === true,
    readOnly: typeof record.readOnly === "boolean" ? record.readOnly : null,
    issues,
  };
}

export async function fetchDbValidatorDiagnostics(deps: {
  baseUrl: string;
  getToken: () => Promise<string | null | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<DbValidatorOutcome> {
  const doFetch = deps.fetchImpl ?? fetch;
  let token: string | null | undefined;
  try {
    token = await deps.getToken();
  } catch {
    token = null;
  }
  if (!token) return { status: "unauthorized", message: "Sign in as an admin to view validator details." };
  try {
    const response = await doFetch(`${deps.baseUrl}${DB_VALIDATOR_PATH}`, {
      method: "GET",
      headers: { authorization: "Bearer " + token },
    });
    if (response.status === 401 || response.status === 403) {
      return { status: "unauthorized", message: "You are not authorized to view validator details." };
    }
    if (response.status !== 200 && response.status !== 503) {
      return { status: "error", message: `Validator request failed (HTTP ${response.status}).` };
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: "success", summary: sanitizeDbValidatorResult(body) };
  } catch {
    return { status: "error", message: "Validator request could not be completed." };
  }
}
