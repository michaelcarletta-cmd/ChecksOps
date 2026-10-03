/**
 * Production pay-setup public routes go to AWS, not Lovable Edge.
 * Same-origin `/prep/public/moov-recipient-*` on checksops.com.
 * No Cognito. Bank-verify routes exist but stay dark until the narrow
 * `bank_verify_available` session flag is true.
 */
import { awsApiBaseUrl } from "@/lib/awsStaging";

const AWS_PUBLIC_SESSION = "/public/moov-recipient-session";
const AWS_PUBLIC_KYC = "/public/moov-recipient-kyc-update";
const AWS_PUBLIC_TOS_TOKEN = "/public/moov-recipient-tos-token";
const AWS_PUBLIC_TOS_ACCEPT = "/public/moov-recipient-tos-accept";
const AWS_PUBLIC_BANK_VERIFY_INITIATE = "/public/moov-recipient-bank-verify-initiate";
const AWS_PUBLIC_BANK_VERIFY_CONFIRM = "/public/moov-recipient-bank-verify-confirm";

export function recipientPublicUrl(path: string, windowOrigin?: string): string {
  const origin = String(windowOrigin || (typeof window !== "undefined" ? window.location.origin : "")).replace(/\/$/, "");
  const host = (() => {
    try { return origin ? new URL(origin).hostname.toLowerCase() : ""; } catch { return ""; }
  })();
  if (host === "checksops.com" || host === "www.checksops.com" || host.endsWith(".checksops.com")) {
    return `${origin}/prep${path}`;
  }
  const configured = awsApiBaseUrl();
  if (configured) return `${configured.replace(/\/$/, "")}${path}`;
  return `/prep${path}`;
}

export function recipientSessionUrl(windowOrigin?: string): string {
  return recipientPublicUrl(AWS_PUBLIC_SESSION, windowOrigin);
}

async function postRecipientPublic(
  path: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
) {
  const response = await fetchImpl(recipientPublicUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || (data as { error?: string })?.error) {
    const message = String((data as { error?: string; message?: string })?.message
      || (data as { error?: string })?.error
      || "Request failed");
    throw new Error(message);
  }
  return data;
}

export async function loadRecipientSession(token: string, fetchImpl: typeof fetch = fetch) {
  return postRecipientPublic(AWS_PUBLIC_SESSION, { token }, fetchImpl);
}

export async function submitRecipientKyc(
  token: string,
  identity: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
) {
  return postRecipientPublic(AWS_PUBLIC_KYC, { token, ...identity }, fetchImpl);
}

export async function loadRecipientTosDropToken(token: string, fetchImpl: typeof fetch = fetch) {
  return postRecipientPublic(AWS_PUBLIC_TOS_TOKEN, { token }, fetchImpl);
}

export async function submitRecipientTos(
  token: string,
  termsOfServiceToken: string,
  fetchImpl: typeof fetch = fetch,
) {
  return postRecipientPublic(AWS_PUBLIC_TOS_ACCEPT, {
    token,
    terms_of_service_token: termsOfServiceToken,
  }, fetchImpl);
}

export async function initiateRecipientBankVerify(token: string, fetchImpl: typeof fetch = fetch) {
  return postRecipientPublic(AWS_PUBLIC_BANK_VERIFY_INITIATE, { token }, fetchImpl);
}

export async function confirmRecipientBankVerify(
  token: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
) {
  return postRecipientPublic(AWS_PUBLIC_BANK_VERIFY_CONFIRM, { token, code }, fetchImpl);
}
