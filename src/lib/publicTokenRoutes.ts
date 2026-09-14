/**
 * Public token links must be recognized before `/:slug/*` tenant resolution.
 * Homeowner emails use `/h/ledger/:token`; the unprefixed `/ledger/:token`
 * route remains for bookmarks and in-app copy links.
 */
export const PUBLIC_TOKEN_EXACT_PATHS = [
  "/sign",
  "/endorse",
  "/unsubscribe",
] as const;

export const PUBLIC_TOKEN_PATH_PREFIXES = [
  "/ledger/",
  "/h/ledger/",
  "/start-claim/",
  "/payment-direction/",
  "/verify-account/",
  "/pay-setup/",
  "/h/upload",
  "/h/claim/",
  "/invoice/",
] as const;

export function isPublicTokenRoute(pathname: string): boolean {
  const path = String(pathname || "");
  if ((PUBLIC_TOKEN_EXACT_PATHS as readonly string[]).includes(path)) return true;
  return PUBLIC_TOKEN_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}
