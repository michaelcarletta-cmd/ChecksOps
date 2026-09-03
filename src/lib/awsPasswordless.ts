import { awsApiBaseUrl } from "@/lib/awsStaging";

const SESSION_KEY = "checksops.aws.staging.passwordless.pending";

type StartResult = {
  email: string;
  session: string;
  challenge: "EMAIL_OTP";
  destination?: string | null;
};

type VerifyResult = {
  idToken: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresIn?: number;
};

const api = async (path: string, body: Record<string, unknown>) => {
  const response = await fetch(`${awsApiBaseUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let payload: any = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok || payload?.ok === false) {
    throw new Error(String(payload?.message || payload?.error || `AWS auth request failed (${response.status})`));
  }
  return payload;
};

export async function startAwsEmailOtp(email: string): Promise<StartResult> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) throw new Error("Enter your email first.");
  const result = await api("/auth/passwordless/start", { email: normalized });
  if (result.completed && result.authentication) {
    throw new Error("Unexpected completed authentication without an email challenge.");
  }
  if (result.challenge !== "EMAIL_OTP" || !result.session) {
    throw new Error("Email verification is not enabled for this AWS staging account yet.");
  }
  const pending: StartResult = {
    email: normalized,
    session: String(result.session),
    challenge: "EMAIL_OTP",
    destination: result.delivery?.destination ?? null,
  };
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(pending));
  } catch {
    // The form also retains the session in React state; storage is only a refresh convenience.
  }
  return pending;
}

export async function verifyAwsEmailOtp(email: string, session: string, code: string): Promise<VerifyResult> {
  const normalized = email.trim().toLowerCase();
  const otp = code.trim().replace(/\s+/g, "");
  if (!normalized || !session || !otp) throw new Error("Enter the email verification code.");
  const result = await api("/auth/passwordless/verify", {
    email: normalized,
    session,
    code: otp,
  });
  if (!result.authentication?.idToken || !result.authentication?.accessToken) {
    throw new Error("AWS did not return an authenticated session.");
  }
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Best effort only.
  }
  return result.authentication as VerifyResult;
}

export function readPendingAwsEmailOtp(): StartResult | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (!value?.email || !value?.session || value?.challenge !== "EMAIL_OTP") return null;
    return value as StartResult;
  } catch {
    return null;
  }
}

export function clearPendingAwsEmailOtp() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Best effort only.
  }
}
