/**
 * Public homeowner/token links must not be treated as /:slug tenant routes.
 * AWS Homeowner Ops emails /h/ledger/:token; the SPA also accepts /ledger/:token.
 */
export function isPublicTokenRoute(pathname: string): boolean {
  const path = String(pathname || "");
  return (
    path === "/sign" ||
    path === "/endorse" ||
    path === "/unsubscribe" ||
    path.startsWith("/ledger/") ||
    path.startsWith("/h/ledger/") ||
    path.startsWith("/start-claim/") ||
    path.startsWith("/payment-direction/") ||
    path.startsWith("/verify-account/") ||
    path.startsWith("/h/upload") ||
    path.startsWith("/h/claim/") ||
    path.startsWith("/invoice/")
  );
}

export function isHomeownerLedgerPath(pathname: string): boolean {
  const path = String(pathname || "");
  return path.startsWith("/ledger/") || path.startsWith("/h/ledger/");
}
