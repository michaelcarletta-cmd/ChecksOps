/**
 * Cognito native WebAuthn client for AWS staging HTTPS only.
 * Production Supabase SimpleWebAuthn (`src/lib/passkeys.ts`) is untouched.
 */
import {
  startAuthentication,
  startRegistration,
  browserSupportsWebAuthn,
} from "@simplewebauthn/browser";
import {
  AWS_STAGING_HTTPS_ORIGIN,
  AWS_STAGING_RP_ID,
  awsApiBaseUrl,
  isAwsStagingHttpsPasskeysEnabled,
} from "@/lib/awsStaging";

const AUTH_KEY = "checksops.aws.staging.auth";

export type AwsPasskeyCredential = {
  credentialId: string;
  friendlyName: string | null;
  relyingPartyId: string | null;
  createdAt: string | null;
  authenticatorAttachment: string | null;
};

const requireHttpsPasskeys = () => {
  if (!isAwsStagingHttpsPasskeysEnabled()) {
    throw new Error(
      `Passkeys are only available at ${AWS_STAGING_HTTPS_ORIGIN}. This origin is not allowed.`,
    );
  }
  if (typeof window === "undefined" || !browserSupportsWebAuthn()) {
    throw new Error("This browser does not support passkeys.");
  }
};

const readAccessToken = (): string | null => {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const token = parsed?.tokens?.accessToken;
    return typeof token === "string" && token ? token : null;
  } catch {
    return null;
  }
};

const post = async (
  path: string,
  body: Record<string, unknown> = {},
  accessToken?: string | null,
) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const response = await fetch(`${awsApiBaseUrl()}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  let payload: any = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok || payload?.ok === false) {
    throw new Error(
      String(payload?.message || payload?.error || `AWS passkey request failed (${response.status})`),
    );
  }
  return payload;
};

const persistAwsSession = async (
  tokens: {
    idToken: string;
    accessToken: string;
    refreshToken?: string | null;
    expiresIn?: number;
  },
  emailHint?: string,
) => {
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
  const mappedEmail = String(identity?.profile?.email || identity?.email || emailHint || "");
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
  localStorage.setItem(
    AUTH_KEY,
    JSON.stringify({
      tokens: {
        idToken: tokens.idToken,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken || null,
        expiresIn,
      },
      user,
      expiresAt,
    }),
  );
  return user;
};

/** Register a Cognito passkey after EMAIL_OTP (or other) sign-in. */
export async function registerAwsPasskey(): Promise<true> {
  requireHttpsPasskeys();
  const accessToken = readAccessToken();
  if (!accessToken) {
    throw new Error("Sign in with email verification first, then add a passkey.");
  }

  const start = await post("/auth/passkey/register/options", {}, accessToken);
  const optionsJSON = start.options;
  if (!optionsJSON) throw new Error("Cognito did not return passkey registration options.");

  let attestation;
  try {
    attestation = await startRegistration({ optionsJSON });
  } catch (err: any) {
    if (err?.name === "NotAllowedError") throw new Error("Passkey setup was cancelled.");
    throw new Error(err?.message || "Passkey setup failed on this device.");
  }

  await post("/auth/passkey/register/verify", { credential: attestation }, accessToken);
  return true;
}

export async function listAwsPasskeys(): Promise<AwsPasskeyCredential[]> {
  requireHttpsPasskeys();
  const accessToken = readAccessToken();
  if (!accessToken) return [];
  const result = await post("/auth/passkey/list", {}, accessToken);
  return Array.isArray(result.credentials) ? result.credentials : [];
}

export async function deleteAwsPasskey(credentialId: string): Promise<void> {
  requireHttpsPasskeys();
  const accessToken = readAccessToken();
  if (!accessToken) throw new Error("Sign in again to manage passkeys.");
  await post("/auth/passkey/delete", { credentialId }, accessToken);
}

/** Cognito WEB_AUTHN sign-in. Falls back to EMAIL_OTP when unavailable. */
export async function signInWithAwsPasskey(email: string): Promise<{ id: string; email: string }> {
  requireHttpsPasskeys();
  const normalized = email.trim().toLowerCase();
  if (!normalized) throw new Error("Enter your email first so we can find your passkey.");

  const start = await post("/auth/passkey/authenticate/start", { email: normalized });
  if (start.completed && start.authentication?.idToken) {
    const user = await persistAwsSession(start.authentication, normalized);
    return { id: user.id, email: user.email };
  }
  if (start.error === "webauthn_unavailable" || !start.options || !start.session) {
    throw new Error(
      "Passkey sign-in is not available for this account yet. Use email verification, then add a passkey under Sign-in security.",
    );
  }

  let assertion;
  try {
    assertion = await startAuthentication({ optionsJSON: start.options });
  } catch (err: any) {
    if (err?.name === "NotAllowedError") throw new Error("Passkey sign-in was cancelled.");
    throw new Error(err?.message || "Passkey sign-in failed on this device.");
  }

  const verified = await post("/auth/passkey/authenticate/verify", {
    email: normalized,
    session: start.session,
    credential: assertion,
  });
  if (!verified.authentication?.idToken) {
    throw new Error("AWS did not return an authenticated session.");
  }
  const user = await persistAwsSession(verified.authentication, normalized);
  return { id: user.id, email: user.email };
}

export const AWS_PASSKEY_META = {
  rpId: AWS_STAGING_RP_ID,
  requiredOrigin: AWS_STAGING_HTTPS_ORIGIN,
  registrationRequiresAuthenticatedSession: true,
  emailOtpFallback: true,
} as const;
