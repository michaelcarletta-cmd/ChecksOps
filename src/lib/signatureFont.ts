/**
 * Rendered signatures are the one place the app uses a script font instead of
 * Inter. Dancing Script is self-hosted (imported in main.tsx); Brush Script MT
 * is the fallback. Use these everywhere a signature is shown or drawn so they
 * look the same in the UI and in rasterized endorsement images.
 */
export const SIGNATURE_FONT_FAMILY = `"Dancing Script", "Brush Script MT", cursive`;

/**
 * Canvas text does not wait for web fonts. Await this before drawing a typed
 * signature on a canvas so the image is not rasterized with the fallback font.
 * Never throws; resolves after at most `timeoutMs`.
 */
export async function ensureSignatureFontLoaded(
  font = `italic 500 32px "Dancing Script"`,
  timeoutMs = 3000,
): Promise<void> {
  if (typeof document === "undefined" || !document.fonts?.load) return;
  try {
    await Promise.race([
      document.fonts.load(font),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } catch {
    /* fall back to Brush Script MT / cursive */
  }
}
