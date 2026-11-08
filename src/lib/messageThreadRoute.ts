/** The URL search param that holds the open message conversation (a check id). */
export const MESSAGE_THREAD_PARAM = "thread";

/** The search params with a conversation open; every other param (tab, filters) is kept. */
export function openThreadParams(prev: URLSearchParams, checkId: string): URLSearchParams {
  const next = new URLSearchParams(prev);
  next.set(MESSAGE_THREAD_PARAM, checkId);
  return next;
}

/** The search params back on the list of all messages; every other param is kept. */
export function closeThreadParams(prev: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(prev);
  next.delete(MESSAGE_THREAD_PARAM);
  return next;
}
