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

/**
 * In the app only: mark <html> with `native-app` (the app-only styles in index.css key off it) and
 * let the page run under the status bar (`viewport-fit=cover`), so env(safe-area-inset-*) reports
 * the real insets and the app shell pads for them. Returns whether it applied.
 */
export function applyNativeAppShell(
  doc: Document | undefined = typeof document === "undefined" ? undefined : document,
  win: unknown = typeof window === "undefined" ? undefined : window,
): boolean {
  if (!doc || !isNativeApp(win)) return false;
  doc.documentElement.classList.add("native-app");
  const viewport = doc.querySelector('meta[name="viewport"]');
  const content = viewport?.getAttribute("content") ?? "";
  if (viewport && !/viewport-fit\s*=/.test(content)) {
    viewport.setAttribute("content", content ? `${content}, viewport-fit=cover` : "viewport-fit=cover");
  }
  return true;
}
