const LOCALHOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);
const CHECKOPS_HOSTS = new Set([
  "checkops.com",
  "www.checkops.com",
  "checksops.com",
  "www.checksops.com",
  "checkops.app",
  "www.checkops.app",
  "checksops.app",
  "www.checksops.app",
  "checkops.lovable.app",
  "checksops.lovable.app",
]);

export function isChecksOpsPlatformHostname(hostname: string): boolean {
  const host = String(hostname || "").trim().toLowerCase();
  if (!host) return false;
  if (CHECKOPS_HOSTS.has(host)) return true;
  if (host.endsWith(".checkops.com")) return true;
  if (host.endsWith(".checksops.com")) return true;
  if (host.endsWith(".checkops.app")) return true;
  if (host.endsWith(".checksops.app")) return true;
  return false;
}

export type BackendModeInput = {
  /** `window.location.hostname` (no port). */
  hostname: string;
  /** `import.meta.env.VITE_AUTH_PROVIDER` (e.g. "cognito") */
  authProvider: string;
};

/**
 * ChecksOps' AWS/Cognito adapter is ONLY valid on ChecksOps platform hosts
 * (and localhost for dev). Freedom Claims must never depend on ChecksOps AWS
 * routing (`/prep`) for tenant branding assets like logos.
 */
export function shouldUseAwsChecksOpsBackendFor(input: BackendModeInput): boolean {
  const hostname = String(input.hostname || "").trim().toLowerCase();
  if (!hostname) return false;
  const isLocalhost = LOCALHOSTS.has(hostname);
  const isChecksOpsHost = isChecksOpsPlatformHostname(hostname);
  if (!isLocalhost && !isChecksOpsHost) return false;

  // AWS build mode must never fall back to real Supabase.
  if (import.meta.env?.MODE === "aws") return true;

  const authProvider = String(input.authProvider || "").trim().toLowerCase();
  return authProvider === "cognito";
}

export function runtimeHostname(): string {
  if (typeof window === "undefined") return "";
  return String(window.location?.hostname || "");
}

