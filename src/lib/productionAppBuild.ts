const PRODUCTION_HOSTNAMES = new Set(["checksops.com", "www.checksops.com"]);

/** The hostname of an app URL, lower-cased; "" when it is not a URL. */
export function appUrlHostname(appUrl: unknown): string {
  try {
    return new URL(String(appUrl || "").trim()).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * True when this bundle was built for production (VITE_APP_URL is checksops.com). The iOS and
 * Android app always runs on localhost, so the page hostname cannot tell a production app build
 * from a staging one; the build's own app URL can.
 */
export function isProductionAppBuild(appUrl: unknown = import.meta.env?.VITE_APP_URL): boolean {
  return PRODUCTION_HOSTNAMES.has(appUrlHostname(appUrl));
}
