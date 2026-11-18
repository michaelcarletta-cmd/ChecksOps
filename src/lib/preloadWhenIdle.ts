/**
 * Background code loading: lazy sections fetched while the browser has nothing else to do.
 */

/**
 * Fetch every section's code when the browser is idle (or after 1.5s where requestIdleCallback is
 * missing), one after another so it never competes with the page's own requests. A failed fetch is
 * ignored: the section loads on click as before. Returns a cleanup that stops the queue.
 */
export function preloadWhenIdle(
  loaders: Array<() => Promise<unknown>>,
  win: (Window & typeof globalThis) | undefined = typeof window === "undefined" ? undefined : window,
): () => void {
  if (!win) return () => {};
  let stopped = false;
  let handle: number | undefined;
  const idle = (fn: () => void) =>
    typeof win.requestIdleCallback === "function"
      ? win.requestIdleCallback(fn, { timeout: 4000 })
      : win.setTimeout(fn, 1500);
  const cancel = (id: number) =>
    typeof win.cancelIdleCallback === "function" ? win.cancelIdleCallback(id) : win.clearTimeout(id);
  const next = (i: number) => {
    if (stopped || i >= loaders.length) return;
    handle = idle(() => {
      if (stopped) return;
      loaders[i]().catch(() => undefined).finally(() => next(i + 1));
    });
  };
  next(0);
  return () => {
    stopped = true;
    if (handle !== undefined) cancel(handle);
  };
}
