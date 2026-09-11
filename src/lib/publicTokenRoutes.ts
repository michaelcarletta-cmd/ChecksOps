/**
 * Public token URLs must never fall through to tenant white-label routes
 * (those redirect anonymous visitors to login).
 */
export function isPublicTokenRoute(pathname: string): boolean {
  return (
    pathname === "/sign" ||
    pathname === "/endorse" ||
    pathname === "/unsubscribe" ||
    pathname.startsWith("/ledger/") ||
    pathname.startsWith("/h/ledger/") ||
    pathname.startsWith("/start-claim/") ||
    pathname.startsWith("/payment-direction/") ||
    pathname.startsWith("/verify-account/") ||
    pathname.startsWith("/h/upload") ||
    pathname.startsWith("/h/claim/") ||
    pathname.startsWith("/invoice/")
  );
}
