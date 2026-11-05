/**
 * True when the SPA runs inside the ChecksOps iOS or Android app (mobile/, Capacitor).
 * The native shell injects window.Capacitor; in a browser it is absent, so the website is unchanged.
 */
export function isNativeApp(win: unknown = typeof window === "undefined" ? undefined : window): boolean {
  const cap = (win as { Capacitor?: { isNativePlatform?: () => boolean } } | undefined)?.Capacitor;
  try {
    return typeof cap?.isNativePlatform === "function" && cap.isNativePlatform() === true;
  } catch {
    return false;
  }
}
