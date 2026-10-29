// Claim portal signing (SQL 127): the portal keeps its claim link token for this browser
// tab only, and /sign?portal_signer=<signer id> sends both to the API, which resolves the
// signer server-side. The token never goes into the /sign URL.
const PORTAL_LEDGER_TOKEN_KEY = "checksops.portalLedgerToken";

export function rememberPortalLedgerToken(token: string): void {
  try {
    window.sessionStorage.setItem(PORTAL_LEDGER_TOKEN_KEY, token);
  } catch {
    /* storage unavailable: /sign will ask the homeowner to reopen from the claim page */
  }
}

export function readPortalLedgerToken(): string | null {
  try {
    return window.sessionStorage.getItem(PORTAL_LEDGER_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function portalSignPath(signerId: string): string {
  return `/sign?portal_signer=${encodeURIComponent(signerId)}`;
}
