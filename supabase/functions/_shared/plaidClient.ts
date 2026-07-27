// Shared Plaid REST client for edge functions.
//
// Plaid is being introduced alongside Actum/Authentecheck, not in place of it.
// Nothing here touches the Actum code paths — accounts already verified through
// Authentecheck keep their `verification_source = 'authentecheck'` and continue
// to disburse via the Actum consumer token.

const PLAID_HOSTS: Record<string, string> = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

export function plaidEnv(): string {
  const env = (Deno.env.get("PLAID_ENV") ?? "sandbox").toLowerCase();
  if (!PLAID_HOSTS[env]) {
    throw new Error(`PLAID_ENV must be "sandbox" or "production", got "${env}"`);
  }
  return env;
}

export function plaidHost(): string {
  return PLAID_HOSTS[plaidEnv()];
}

function plaidCredentials(): { client_id: string; secret: string } {
  const client_id = Deno.env.get("PLAID_CLIENT_ID");
  const secret = Deno.env.get("PLAID_SECRET");
  if (!client_id || !secret) {
    throw new Error(
      "Plaid is not configured. PLAID_CLIENT_ID and PLAID_SECRET must be set.",
    );
  }
  return { client_id, secret };
}

export class PlaidError extends Error {
  constructor(
    message: string,
    public readonly errorCode: string | null,
    public readonly errorType: string | null,
    public readonly status: number,
  ) {
    super(message);
    this.name = "PlaidError";
  }
}

/**
 * POST to a Plaid endpoint with credentials injected.
 * Throws PlaidError on any non-2xx so callers never mistake a failure for success.
 */
export async function callPlaid<T = any>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${plaidHost()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...plaidCredentials(), ...body }),
  });

  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // fall through — non-JSON body is handled below
  }

  if (!res.ok) {
    const code = json?.error_code ?? null;
    const msg = json?.error_message ?? json?.display_message ?? text ??
      `Plaid request to ${path} failed`;
    console.error("[plaid] error", path, res.status, code, msg);
    throw new PlaidError(msg, code, json?.error_type ?? null, res.status);
  }

  return json as T;
}

/** Maps a Plaid account subtype to the single-letter type the existing schema uses. */
export function acctTypeFromPlaid(subtype: string | null | undefined): "C" | "S" {
  return subtype === "savings" ? "S" : "C";
}
