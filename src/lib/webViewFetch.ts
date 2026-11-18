/**
 * The web view's own fetch, for uploading file bytes straight to storage with a presigned URL.
 *
 * The iOS/Android app turns on CapacitorHttp (mobile/capacitor.config.json), which replaces
 * window.fetch with native networking so API calls need no CORS entry for capacitor://localhost
 * (API Gateway HTTP APIs refuse that origin). Capacitor keeps the original as
 * window.CapacitorWebFetch. Its native bridge sends a File as base64 but a plain Blob as JSON,
 * which would corrupt an upload, so presigned PUTs use the original fetch; the files bucket's
 * CORS allows the app origins. On the website there is no CapacitorWebFetch and this is fetch.
 */
export function webViewFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const original = typeof window === "undefined"
    ? undefined
    : (window as unknown as { CapacitorWebFetch?: typeof fetch }).CapacitorWebFetch;
  return typeof original === "function" ? original(input, init) : fetch(input, init);
}
