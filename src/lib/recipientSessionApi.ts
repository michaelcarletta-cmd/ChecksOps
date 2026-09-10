/**
 * Production pay-setup session reads go to AWS, not Lovable Edge.
 * Same-origin `/prep/public/moov-recipient-session` on checksops.com.
 * No Cognito. Mutations stay on existing Edge handlers.
 */
import { awsApiBaseUrl } from "@/lib/awsStaging";

const AWS_PUBLIC_SESSION = "/public/moov-recipient-session";

export function recipientSessionUrl(windowOrigin?: string): string {
  const origin = String(windowOrigin || (typeof window !== "undefined" ? window.location.origin : "")).replace(/\/$/, "");
  const host = (() => {
    try { return origin ? new URL(origin).hostname.toLowerCase() : ""; } catch { return ""; }
  })();
  if (host === "checksops.com" || host === "www.checksops.com" || host.endsWith(".checksops.com")) {
    return `${origin}/prep${AWS_PUBLIC_SESSION}`;
  }
  const configured = awsApiBaseUrl();
  if (configured) return `${configured.replace(/\/$/, "")}${AWS_PUBLIC_SESSION}`;
  return `/prep${AWS_PUBLIC_SESSION}`;
}

export async function loadRecipientSession(token: string, fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl(recipientSessionUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || (data as { error?: string })?.error) {
    const message = String((data as { error?: string })?.error || "Request failed");
    throw new Error(message);
  }
  return data;
}
