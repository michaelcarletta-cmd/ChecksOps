/**
 * Tenant membership for check-movement UI.
 * Uses authenticated GET /identity/me and fails closed.
 */

const AWS_SESSION_KEY = "checksops.aws.staging.auth";
const LEGACY_BACKEND = /supabase\.co|lovable|nbcqwpysqgyxrrbgtmkw/i;

export type TenantCheckIdentity = {
  roles: string[];
  isTenantMember: boolean;
  tenantRole: string | null;
};

const EMPTY_IDENTITY: TenantCheckIdentity = {
  roles: [],
  isTenantMember: false,
  tenantRole: null,
};

const readIdToken = (sessionKey = AWS_SESSION_KEY): string | null => {
  try {
    const raw = localStorage.getItem(sessionKey);
    if (!raw) return null;
    const idToken = JSON.parse(raw)?.tokens?.idToken;
    return typeof idToken === "string" && idToken ? idToken : null;
  } catch {
    return null;
  }
};

const identityMeRequestUrl = (apiBaseUrl: string): string | null => {
  const base = String(apiBaseUrl || "").trim().replace(/\/$/, "");
  if (!base || LEGACY_BACKEND.test(base)) return null;
  return `${base}/identity/me`;
};

const asRoleList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((role): role is string => typeof role === "string" && Boolean(role.trim()))
    .map((role) => role.trim());
};

/** Trusted membership from AWS GET /identity/me. Empty on any untrusted payload. */
export function parseIdentityTenantAccess(
  identity: unknown,
  tenantId?: string | null,
): TenantCheckIdentity {
  if (!identity || typeof identity !== "object") return { ...EMPTY_IDENTITY };
  const record = identity as Record<string, unknown>;
  if (record.ok === false || !record.applicationUserId) return { ...EMPTY_IDENTITY };

  const roles = asRoleList(record.roles);
  const tenants = Array.isArray(record.tenants) ? record.tenants : [];
  const wanted = tenantId == null ? "" : String(tenantId);
  const match = wanted
    ? tenants.find((row) => {
        if (!row || typeof row !== "object") return false;
        return String((row as { tenant_id?: unknown }).tenant_id || "") === wanted;
      })
    : null;
  const tenantRole =
    match && typeof (match as { role?: unknown }).role === "string"
      ? String((match as { role: string }).role)
      : null;

  return {
    roles,
    isTenantMember: Boolean(match),
    tenantRole,
  };
}

export async function loadTenantCheckIdentity(input: {
  tenantId?: string | null;
  apiBaseUrl?: string;
  idToken?: string | null;
  fetchImpl?: typeof fetch;
} = {}): Promise<TenantCheckIdentity> {
  const url = identityMeRequestUrl(input.apiBaseUrl ?? "");
  const idToken = input.idToken !== undefined ? input.idToken : readIdToken();
  if (!url || !idToken) return { ...EMPTY_IDENTITY };

  try {
    const response = await (input.fetchImpl || fetch)(url, {
      method: "GET",
      headers: { authorization: `Bearer ${idToken}` },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false || !body?.applicationUserId) {
      return { ...EMPTY_IDENTITY };
    }
    return parseIdentityTenantAccess(body, input.tenantId);
  } catch {
    return { ...EMPTY_IDENTITY };
  }
}
