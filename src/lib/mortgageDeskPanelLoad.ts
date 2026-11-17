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
export const showPanelSpinner = (state: { loading: boolean; loadedRequestId: string | null; requestId: string | null }) =>
  state.loading || !state.loadedRequestId || (state.requestId !== null && state.loadedRequestId !== state.requestId);
