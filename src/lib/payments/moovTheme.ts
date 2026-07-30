/**
 * Moov Drops theming.
 *
 * Moov's hosted components (bank account, payment methods, onboarding) read a
 * fixed set of `--moov-*` CSS variables. Their defaults are injected into
 * <head>, so overrides must live in the <body> (or with greater specificity)
 * to win. We inject a <style> tag into the body at runtime.
 *
 * Docs: https://docs.moov.io/moovjs/drops/theming/
 */

export interface MoovThemeInput {
  /** Brand accent, hex. Falls back to the ChecksOps olive. */
  primary?: string | null;
  /** Optional secondary/brand-dark hex. */
  secondary?: string | null;
}

const CHECKSOPS_PRIMARY = "#596032";

const STYLE_ID = "moov-drops-theme";

/** Lighten/darken a hex color by a percentage (-100..100). */
function shade(hex: string, percent: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return hex;
  const adjust = (v: number) => {
    const next = percent < 0 ? v * (1 + percent / 100) : v + (255 - v) * (percent / 100);
    return Math.max(0, Math.min(255, Math.round(next)));
  };
  const [r, g, b] = [1, 2, 3].map((i) => adjust(parseInt(m[i], 16)));
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Build the dark ChecksOps palette for Moov Drops. */
export function buildMoovThemeCss(input: MoovThemeInput = {}): string {
  const primary = input.primary || CHECKSOPS_PRIMARY;
  const secondary = input.secondary || shade(primary, 18);

  return `:root {
  --moov-color-background: #14151b;
  --moov-color-background-secondary: #1c1e26;
  --moov-color-background-tertiary: #2a2d38;
  --moov-color-primary: ${primary};
  --moov-color-secondary: ${secondary};
  --moov-color-tertiary: #494a57;
  --moov-color-info: #94cbff;
  --moov-color-warn: #eea05a;
  --moov-color-danger: #ed655c;
  --moov-color-success: #62e599;
  --moov-color-low-contrast: #9294a0;
  --moov-color-medium-contrast: #ebebef;
  --moov-color-high-contrast: #ffffff;
  --moov-color-graphic-1: ${primary};
  --moov-color-graphic-2: ${secondary};
  --moov-color-graphic-3: ${shade(primary, 40)};
  --moov-radius-small: 0.375rem;
  --moov-radius-large: 0.75rem;
}`;
}

/**
 * Injects (or updates) the Moov theme style tag in <body>.
 * Returns a cleanup function that removes it.
 */
export function applyMoovTheme(input: MoovThemeInput = {}): () => void {
  if (typeof document === "undefined") return () => {};

  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    // Must be in the body to override Moov's <head> defaults.
    document.body.appendChild(style);
  }
  style.textContent = buildMoovThemeCss(input);

  return () => {
    document.getElementById(STYLE_ID)?.remove();
  };
}
