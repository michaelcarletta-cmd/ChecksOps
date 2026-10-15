/**
 * React commit-phase DOM errors from unmounting a node the browser already
 * removed (WebKit NotFoundError / Chromium removeChild). These are transient
 * reconciliation glitches, not application failures.
 *
 * Only DOM node-removal messages match: a bare NotFoundError name (IndexedDB,
 * getUserMedia, ...) is a real error and still reaches the error screen.
 */
const DOM_NODE_MESSAGES = [
  "Failed to execute 'removeChild' on 'Node'",
  "Failed to execute 'insertBefore' on 'Node'",
  "The node to be removed is not a child",
  "The object can not be found here",
];

export function isTransientDomNodeError(error: unknown): boolean {
  const message = String((error as { message?: unknown } | null)?.message || "");
  return DOM_NODE_MESSAGES.some((text) => message.includes(text));
}

/** At most this many silent recoveries inside the window; then show the error screen. */
export const TRANSIENT_RECOVERY_LIMIT = 2;
export const TRANSIENT_RECOVERY_WINDOW_MS = 10_000;

/**
 * Returns a recorder that says whether a transient DOM error may be recovered
 * silently. A render that throws the same DOM error every time stops looping
 * after TRANSIENT_RECOVERY_LIMIT recoveries within the window.
 */
export function createTransientRecoveryGate(
  limit = TRANSIENT_RECOVERY_LIMIT,
  windowMs = TRANSIENT_RECOVERY_WINDOW_MS,
) {
  let recent: number[] = [];
  return (error: unknown, now = Date.now()): boolean => {
    if (!isTransientDomNodeError(error)) return false;
    recent = recent.filter((at) => now - at < windowMs);
    if (recent.length >= limit) return false;
    recent.push(now);
    return true;
  };
}
