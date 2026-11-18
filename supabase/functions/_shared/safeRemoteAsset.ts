// Server-side fetches of URLs that come out of database rows (legacy image
// paths, saved signature references) must not be able to reach arbitrary
// hosts. Only HTTPS storage hosts are allowed:
//   - the host of this project's SUPABASE_URL,
//   - Supabase storage object URLs on *.supabase.co (legacy projects),
//   - hosts listed in REMOTE_ASSET_ALLOWED_HOSTS (comma separated).
// Redirects are refused so an allowed host cannot bounce the request elsewhere.

export type RemoteAssetPolicy = {
  supabaseUrl?: string | null;
  extraAllowedHosts?: string | null;
};

const STORAGE_OBJECT_PATH = /^\/storage\/v1\/object\//;

function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function parseHostList(value: string | null | undefined): Set<string> {
  return new Set(
    String(value ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Returns the parsed URL when it may be fetched, otherwise null. */
export function allowedRemoteAssetUrl(value: string, policy: RemoteAssetPolicy): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== "443") return null;

  const host = url.hostname.toLowerCase();
  if (host === hostOf(policy.supabaseUrl)) return url;
  if (parseHostList(policy.extraAllowedHosts).has(host)) return url;
  if (host.endsWith(".supabase.co") && STORAGE_OBJECT_PATH.test(url.pathname)) return url;
  return null;
}

/** Fetches an allow-listed remote asset. Throws `remote_asset_host_not_allowed` otherwise. */
export async function fetchAllowedRemoteAsset(
  value: string,
  policy: RemoteAssetPolicy,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const url = allowedRemoteAssetUrl(value, policy);
  if (!url) throw new Error("remote_asset_host_not_allowed");
  return await fetchImpl(url.toString(), { redirect: "error" });
}

export function remoteAssetPolicyFromEnv(env: { get(name: string): string | undefined }): RemoteAssetPolicy {
  return {
    supabaseUrl: env.get("SUPABASE_URL"),
    extraAllowedHosts: env.get("REMOTE_ASSET_ALLOWED_HOSTS"),
  };
}
