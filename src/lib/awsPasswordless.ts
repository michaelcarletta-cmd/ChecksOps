import { awsApiBaseUrl } from "@/lib/awsStaging";

const PENDING_KEY = "checksops.aws.staging.passwordless.pending";
const AUTH_KEY = "checksops.aws.staging.auth";

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

const post = async (path: string, body: Record<string, unknown>) => {
  const response = await fetch(`${awsApiBaseUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let payload: any = {};
  try { payload = await response.json(); } catch { payload = {}; }
  if (!response.ok || payload?.ok === false) {
    throw new Error(String(payload?.message || payload?.error || `AWS auth request failed (${response.status})`));
  }
  return payload;
};

export async function startAwsEmailOtp(email: string): Promise<StartResult> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) throw new Error("Enter your email first.");
  const result = await post("/auth/passwordless/start", { email: normalized });
  if (result.challenge !== "EMAIL_OTP" || !result.session) {
    throw new Error("Email verification is not enabled for this AWS staging account yet.");
  }
  const pending: StartResult = {
    email: normalized,
    session: String(result.session),
    challenge: "EMAIL_OTP",
    destination: result.delivery?.destination ?? null,
  };
  try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending)); } catch { /* best effort */ }
  return pending;
}

export async function verifyAwsEmailOtp(email: string, session: string, code: string): Promise<VerifyResult> {
  const normalized = email.trim().toLowerCase();
  const otp = code.trim().replace(/\s+/g, "");
  if (!normalized || !session || !otp) throw new Error("Enter the email verification code.");
  const result = await post("/auth/passwordless/verify", { email: normalized, session, code: otp });
  const tokens = result.authentication as VerifyResult | undefined;
  if (!tokens?.idToken || !tokens?.accessToken) throw new Error("AWS did not return an authenticated session.");

  const identityResponse = await fetch(`${awsApiBaseUrl()}/identity/me`, {
    headers: { authorization: `Bearer ${tokens.idToken}` },
  });
  const identity: any = await identityResponse.json().catch(() => ({}));
  if (!identityResponse.ok || !identity?.applicationUserId) {
    throw new Error(String(identity?.error || "This AWS identity is not linked to a ChecksOps user."));
  }
  if (String(identity.applicationUserId) === String(identity.cognitoSub || "")) {
    throw new Error("Unsafe AWS identity mapping was refused.");
  }

  const now = new Date().toISOString();
  const mappedEmail = String(identity?.profile?.email || identity?.email || normalized);
  const user = {
    id: String(identity.applicationUserId),
    aud: "authenticated",
    role: "authenticated",
    email: mappedEmail,
    email_confirmed_at: now,
    phone: "",
    confirmed_at: now,
    last_sign_in_at: now,
    app_metadata: { provider: "cognito", providers: ["cognito"] },
    user_metadata: {
      email: mappedEmail,
      full_name: identity?.profile?.fullName || null,
      application_user_id: String(identity.applicationUserId),
    },
    identities: [],
    created_at: now,
    updated_at: now,
    is_anonymous: false,
  };
  const expiresIn = Number(tokens.expiresIn || 3600);
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
  try {
    localStorage.setItem(AUTH_KEY, JSON.stringify({
      tokens: {
        idToken: tokens.idToken,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken || null,
        expiresIn,
      },
      user,
      expiresAt,
    }));
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    throw new Error("The authenticated AWS session could not be saved in this browser.");
  }
  return tokens;
}

export function readPendingAwsEmailOtp(): StartResult | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (!value?.email || !value?.session || value?.challenge !== "EMAIL_OTP") return null;
    return value as StartResult;
  } catch { return null; }
}

export function clearPendingAwsEmailOtp() {
  try { sessionStorage.removeItem(PENDING_KEY); } catch { /* best effort */ }
}
