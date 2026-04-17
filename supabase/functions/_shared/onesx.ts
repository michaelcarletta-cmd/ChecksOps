// Shared 1ESX helpers: token caching + authenticated fetch.
// Used by onesx-create-order, onesx-order-status, onesx-products, onesx-webhook.

const TOKEN_TTL_BUFFER_SECONDS = 60; // refresh 60s before expiry

type CachedToken = { token: string; expiresAt: number };
let cached: CachedToken | null = null;

export function onesxBaseUrl(): string {
  const url = Deno.env.get("ONESX_BASE_URL");
  if (!url) throw new Error("ONESX_BASE_URL is not configured");
  return url.replace(/\/+$/, "");
}

export function vendorKey(): string {
  const v = Deno.env.get("ONESX_VENDOR_KEY");
  if (!v) throw new Error("ONESX_VENDOR_KEY is not configured");
  return v;
}

export async function getOnesxToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAt - TOKEN_TTL_BUFFER_SECONDS > now) {
    return cached.token;
  }

  const clientId = Deno.env.get("ONESX_CLIENT_ID");
  const clientSecret = Deno.env.get("ONESX_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error("ONESX_CLIENT_ID / ONESX_CLIENT_SECRET not configured");
  }

  const res = await fetch(`${onesxBaseUrl()}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
  });

  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) {
    throw new Error(
      `1ESX auth failed [${res.status}]: ${body?.message ?? "unknown error"}`
    );
  }

  const accessToken: string = body.data?.access_token;
  const expiresIn: number = body.data?.expires_in ?? 3600;
  if (!accessToken) throw new Error("1ESX auth: missing access_token in response");

  cached = { token: accessToken, expiresAt: now + expiresIn };
  return accessToken;
}

export async function onesxFetch(
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: any }> {
  const token = await getOnesxToken();
  const url = `${onesxBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;

  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("X-Vendor-Key", vendorKey());
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(url, { ...init, headers });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}
