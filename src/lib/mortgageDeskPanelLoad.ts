/**
 * Mortgage Desk request panel: when a load may replace the panel with its spinner.
 *
 * The panel reloads on a timer (every 12 s on AWS), on new messages and after every action. Only the first load of a
 * request shows the spinner; a refresh of the request already on screen keeps the content, so the agent's scroll
 * position and anything being typed survive it.
 *
 * No "@/" imports: aws/tests load this file with --experimental-strip-types.
 */

/** True when the panel does not yet show this request (nothing loaded, or another request is on screen). */
export const isFirstPanelLoad = (shownRequestId: string | null, requestId: string | null) =>
  !!requestId && shownRequestId !== requestId;

/**
 * Whether the panel shows its spinner instead of the request. A closing panel (requestId null) keeps the request it
 * shows until it is gone; a panel switched to another request never shows the previous one's data.
 */
/** A signed URL without its query string: the object it points at. Two signatures of one image compare equal. */
const signedUrlTarget = (url: string | undefined) => (url ? url.split("?")[0].split("#")[0] : "");

export interface PanelCheckImages { front?: string; back?: string }

/**
 * The check image URLs to show after a refresh. The server signs a fresh 60-second URL on every read, and the Desk draws
 * each image into a canvas once (VoidStampedCheckImage), so a new signature for the image already drawn must not replace
 * the one on screen: that redraws it through "Loading…" every refresh. A side keeps its URL while it points at the same
 * image and has not failed to load; a different image, a first image, or a side that failed takes the fresh URL. A side
 * the server no longer returns is dropped.
 */
export function stablePanelImages(
  shown: PanelCheckImages,
  fresh: PanelCheckImages,
  failed: { front?: boolean; back?: boolean } = {},
): PanelCheckImages {
  const side = (key: "front" | "back") => {
    const next = fresh[key];
    if (!next) return undefined;
    const current = shown[key];
    if (current && !failed[key] && signedUrlTarget(current) === signedUrlTarget(next)) return current;
    return next;
  };
  const front = side("front");
  const back = side("back");
  // The same object when nothing changes, so React keeps the rendered images as they are.
  if (front === shown.front && back === shown.back) return shown;
  return { ...(front ? { front } : {}), ...(back ? { back } : {}) };
}

export const showPanelSpinner = (state: { loading: boolean; loadedRequestId: string | null; requestId: string | null }) =>
  state.loading || !state.loadedRequestId || (state.requestId !== null && state.loadedRequestId !== state.requestId);
