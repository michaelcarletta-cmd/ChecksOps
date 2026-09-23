/**
 * Cognito native WebAuthn client for AWS staging HTTPS only.
 * Production Supabase SimpleWebAuthn (`src/lib/passkeys.ts`) is untouched.
 */
import {
  startAuthentication,
  startRegistration,
  browserSupportsWebAuthn,
} from "@simplewebauthn/browser";
import { supabase } from "@/integrations/aws/client";
import {
  AWS_STAGING_AUTH_SESSION_KEY,
  AWS_STAGING_HTTPS_ORIGIN,
  AWS_STAGING_RP_ID,
  awsApiBaseUrl,
  isAwsStagingHttpsPasskeysEnabled,
} from "@/lib/awsStaging";

export type AwsPasskeyCredential = {
  credentialId: string;
  friendlyName: string | null;
  relyingPartyId: string | null;
  createdAt: string | null;
  authenticatorAttachment: string | null;
  authenticatorTransports?: string[];
  /** Cognito ListWebAuthnCredentials does not provide last-used; always null. */
  lastUsedAt?: string | null;
};

export type AwsPasskeyOptions = {
  /** Portal session key for token reads (Mortgage Desk isolation). */
  sessionKey?: string;
  /**
   * Portal client whose establishCognitoSession should receive tokens.
   * Defaults to the CheckOps/WhiteLabel `supabase` client.
   */
  authClient?: {
    auth: {
      establishCognitoSession?: (
        authentication: CognitoAuthTokens,
        emailFallback?: string | null,
      ) => Promise<{
        data: { user: { id: string; email?: string } | null };
        error: { message?: string } | null;
      }>;
    };
  };
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

const readAccessToken = (sessionKey: string): string | null => {
  try {
    const raw = localStorage.getItem(sessionKey);
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

type CognitoAuthTokens = {
  idToken: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresIn?: number;
};

/**
 * Persist Cognito tokens and notify React auth via SIGNED_IN on the portal client.
 * Writing localStorage alone is not enough — guards read useAuth()/useMortgageAuth().
 */
const persistAwsSession = async (
  tokens: CognitoAuthTokens,
  emailHint: string | undefined,
  options: AwsPasskeyOptions,
) => {
  const client = options.authClient || (supabase as any);
  const establish = client?.auth?.establishCognitoSession as
    | ((auth: CognitoAuthTokens, email?: string | null) => Promise<{
      data: { user: { id: string; email?: string } | null };
      error: { message?: string } | null;
    }>)
    | undefined;

  if (typeof establish === "function") {
    const { data, error } = await establish(tokens, emailHint || null);
    if (error || !data.user?.id) {
      throw new Error(error?.message || "Could not establish the AWS staging session.");
    }
    return { id: String(data.user.id), email: String(data.user.email || emailHint || "") };
  }

  // Fallback for non-AWS builds (should not run when VITE_AUTH_PROVIDER=cognito).
  throw new Error("AWS Cognito session handoff is unavailable in this build.");
};

/** Register a Cognito passkey after EMAIL_OTP (or other) sign-in. */
export async function registerAwsPasskey(options: AwsPasskeyOptions = {}): Promise<true> {
  requireHttpsPasskeys();
  const sessionKey = options.sessionKey || AWS_STAGING_AUTH_SESSION_KEY;
  const accessToken = readAccessToken(sessionKey);
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

export async function listAwsPasskeys(options: AwsPasskeyOptions = {}): Promise<AwsPasskeyCredential[]> {
  requireHttpsPasskeys();
  const sessionKey = options.sessionKey || AWS_STAGING_AUTH_SESSION_KEY;
  const accessToken = readAccessToken(sessionKey);
  if (!accessToken) return [];
  const result = await post("/auth/passkey/list", {}, accessToken);
  return Array.isArray(result.credentials) ? result.credentials : [];
}

export async function deleteAwsPasskey(
  credentialId: string,
  options: AwsPasskeyOptions = {},
): Promise<void> {
  requireHttpsPasskeys();
  const sessionKey = options.sessionKey || AWS_STAGING_AUTH_SESSION_KEY;
  const accessToken = readAccessToken(sessionKey);
  if (!accessToken) throw new Error("Sign in again to manage passkeys.");
  await post("/auth/passkey/delete", { credentialId }, accessToken);
}

/** Cognito WEB_AUTHN sign-in. Falls back to EMAIL_OTP when unavailable. */
export async function signInWithAwsPasskey(
  email: string,
  options: AwsPasskeyOptions = {},
): Promise<{ id: string; email: string }> {
  requireHttpsPasskeys();
  const normalized = email.trim().toLowerCase();
  if (!normalized) throw new Error("Enter your email first so we can find your passkey.");

  const start = await post("/auth/passkey/authenticate/start", { email: normalized });
  if (start.completed && start.authentication?.idToken) {
    return persistAwsSession(start.authentication, normalized, options);
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
  return persistAwsSession(verified.authentication, normalized, options);
}

export const AWS_PASSKEY_META = {
  rpId: AWS_STAGING_RP_ID,
  requiredOrigin: AWS_STAGING_HTTPS_ORIGIN,
  registrationRequiresAuthenticatedSession: true,
  emailOtpFallback: true,
} as const;
