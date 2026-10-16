/**
 * Public /sign document preview sizing (Cursor 4b5a82185). Narrow viewports size
 * the review iframe from container width with a derived height, instead of the
 * desktop 70vh / 400px floor that stretched the page on phones.
 */
export const SIGN_PREVIEW_NARROW_MQ = "(max-width: 767px)";

export type SignPreviewFrameStyle = {
  height: string;
  minHeight: string | number;
  width?: string;
  maxWidth?: string;
  display?: string;
  border?: number;
};

export function signPreviewFrameStyle(narrow: boolean): SignPreviewFrameStyle {
  if (!narrow) {
    return { height: "70vh", minHeight: "400px" };
  }
  return {
    width: "100%",
    maxWidth: "100%",
    height: "max(90dvh, 160vw)",
    minHeight: 0,
    display: "block",
    border: 0,
  };
}

/** The pixel height the style resolves to, for tests (desktop: max(70vh, 400px)). */
export function resolveSignPreviewHeightPx(narrow: boolean, viewportWidth: number, viewportHeight: number): number {
  if (!narrow) return Math.max(viewportHeight * 0.7, 400);
  return Math.max(viewportHeight * 0.9, viewportWidth * 1.6);
}
