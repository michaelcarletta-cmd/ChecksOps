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

/** The check panel slides in from the right and settles, like a pushed screen. */
export const NATIVE_PANEL_ENTER: Keyframe[] = [
  { opacity: 0, translate: "24px 0", scale: "0.99" },
  { opacity: 1, translate: "0 0", scale: "1" },
];
export const NATIVE_PANEL_TIMING: KeyframeAnimationOptions = { duration: 260, easing: "cubic-bezier(0.22, 1, 0.36, 1)" };

/** On the website the panel moves less and faster: desktop users notice slow motion more. */
export const WEB_PANEL_ENTER: Keyframe[] = [
  { opacity: 0, transform: "translateX(20px)" },
  { opacity: 1, transform: "translateX(0)" },
];
export const WEB_PANEL_TIMING: KeyframeAnimationOptions = { duration: 240, easing: "cubic-bezier(0.22, 1, 0.36, 1)" };
/**
 * Opening the panel on the website: the columns take their widths at once and the panel slides in
 * from the right edge and fades in. Only transform and opacity move, which the browser animates on
 * its compositor, so the slide stays smooth while the page is busy building the check (a width
 * animation runs on the page's own thread and stuttered there on slower machines: owner 2026-11-18,
 * "it still not a smooth animation"). The panel column has no transform of its own to override.
 */
export const WEB_PANEL_OPEN_ENTER: Keyframe[] = [
  { opacity: 0, transform: "translateX(28%)" },
  { opacity: 1, transform: "translateX(0)" },
];
export const WEB_PANEL_OPEN_TIMING: KeyframeAnimationOptions = {
  duration: 340, easing: "cubic-bezier(0.22, 1, 0.36, 1)",
};

function prefersReducedMotion(win: unknown): boolean {
  const media = (win as { matchMedia?: (q: string) => { matches: boolean } } | undefined)?.matchMedia;
  return typeof media === "function" && media.call(win, "(prefers-reduced-motion: reduce)").matches;
}

function playEntrance(selector: string, keyframes: Keyframe[], timing: KeyframeAnimationOptions, doc: Document): number {
  let count = 0;
  doc.querySelectorAll(selector).forEach((el) => {
    if (typeof (el as Element & { animate?: unknown }).animate !== "function") return;
    el.animate(keyframes, timing);
    count += 1;
  });
  return count;
}

/**
 * In the app only: play an entrance on each element matching `selector`. Uses the individual
 * translate/scale properties, so an element's own transform is untouched. Skipped on the website
 * and when the user asked for reduced motion. Returns how many elements it animated.
 */
export function playNativeAppEntrance(
  selector: string,
  keyframes: Keyframe[] = NATIVE_PANEL_ENTER,
  timing: KeyframeAnimationOptions = NATIVE_PANEL_TIMING,
  doc: Document | undefined = typeof document === "undefined" ? undefined : document,
  win: unknown = typeof window === "undefined" ? undefined : window,
): number {
  if (!doc || !isNativeApp(win) || prefersReducedMotion(win)) return 0;
  return playEntrance(selector, keyframes, timing, doc);
}

/**
 * The check panel's entrance, each time a check is opened or switched: the app's push-style slide
 * in the iOS/Android app, a shorter and smaller one on the website. Reduced motion stops it in the app
 * only: the website always animates (owner 2026-11-18).
 */
export function playPanelEntrance(
  selector: string,
  doc: Document | undefined = typeof document === "undefined" ? undefined : document,
  win: unknown = typeof window === "undefined" ? undefined : window,
  /** True when the panel was closed before (it opens, rather than switching to another check). */
  opening = false,
): number {
  if (!doc) return 0;
  // Reduced motion is respected in the app only; the website always animates (owner 2026-11-18).
  if (isNativeApp(win)) {
    return prefersReducedMotion(win) ? 0 : playEntrance(selector, NATIVE_PANEL_ENTER, NATIVE_PANEL_TIMING, doc);
  }
  return opening
    ? playEntrance(selector, WEB_PANEL_OPEN_ENTER, WEB_PANEL_OPEN_TIMING, doc)
    : playEntrance(selector, WEB_PANEL_ENTER, WEB_PANEL_TIMING, doc);
}

/** A status tab's section (Review, Endorsing, Ready for Deposit, ...) settles in when the tab is picked. */
export const WEB_SECTION_ENTER: Keyframe[] = [
  { opacity: 0, transform: "translateY(8px)" },
  { opacity: 1, transform: "translateY(0)" },
];
export const WEB_SECTION_TIMING: KeyframeAnimationOptions = { duration: 220, easing: "cubic-bezier(0.22, 1, 0.36, 1)" };
export const NATIVE_SECTION_ENTER: Keyframe[] = [
  { opacity: 0, translate: "0 10px" },
  { opacity: 1, translate: "0 0" },
];
export const NATIVE_SECTION_TIMING: KeyframeAnimationOptions = { duration: 240, easing: "cubic-bezier(0.22, 1, 0.36, 1)" };

/**
 * The entrance of a status tab's section, each time a tab is picked. Played on the section that
 * stays mounted (Endorsing, Ready for Deposit and Deposited share one list), so nothing remounts.
 * Reduced motion stops it in the app only (the website always animates). Returns how many elements it animated.
 */
export function playSectionEntrance(
  selector: string,
  doc: Document | undefined = typeof document === "undefined" ? undefined : document,
  win: unknown = typeof window === "undefined" ? undefined : window,
): number {
  if (!doc) return 0;
  // Reduced motion is respected in the app only; the website always animates (owner 2026-11-18).
  if (isNativeApp(win)) {
    return prefersReducedMotion(win) ? 0 : playEntrance(selector, NATIVE_SECTION_ENTER, NATIVE_SECTION_TIMING, doc);
  }
  return playEntrance(selector, WEB_SECTION_ENTER, WEB_SECTION_TIMING, doc);
}
