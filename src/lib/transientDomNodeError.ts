/**
 * React commit-phase DOM errors from unmounting a node the browser already
 * removed (WebKit NotFoundError / Chromium removeChild). These are transient
 * reconciliation glitches, not application failures.
 */
export function isTransientDomNodeError(error: unknown): boolean {
  const name = String((error as { name?: unknown } | null)?.name || "");
  const message = String((error as { message?: unknown } | null)?.message || "");
  return (
    name === "NotFoundError" ||
    message.includes("removeChild") ||
    message.includes("The object can not be found here") ||
    message.includes("The node to be removed is not a child")
  );
}
