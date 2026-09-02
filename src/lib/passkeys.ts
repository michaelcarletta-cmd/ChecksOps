import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
} from "@simplewebauthn/browser";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase as defaultClient } from "@/integrations/supabase/client";

type Client = SupabaseClient<any, any, any>;

/** True when this browser can create/use passkeys at all. */
export function passkeysSupported() {
  return typeof window !== "undefined" && browserSupportsWebAuthn();
}

/** True when the device has a built-in authenticator (Touch ID, Face ID, Windows Hello). */
export async function platformPasskeyAvailable() {
  if (!passkeysSupported()) return false;
  try {
    return await platformAuthenticatorIsAvailable();
  } catch {
    return false;
  }
}

/** Best-effort friendly name for the device the passkey is created on. */
export function guessDeviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Android/.test(ua)) return "Android device";
  if (/Windows/.test(ua)) return "Windows PC";
  return "This device";
}

function unwrap<T>(res: { data: T | null; error: any }, fallback: string): T {
  // functions.invoke surfaces non-2xx as an error; surface the server message.
  if (res.error) {
    const detail = (res.data as any)?.error;
    throw new Error(detail || res.error.message || fallback);
  }
  if (!res.data) throw new Error(fallback);
  if ((res.data as any).error) throw new Error((res.data as any).error);
  return res.data;
}

/**
 * Registers a new passkey for the currently signed-in user.
 * Must be called from a user gesture (click) — browsers require it.
 */
export async function registerPasskey(
  client: Client = defaultClient,
  deviceName = guessDeviceName(),
) {
  if (!passkeysSupported()) {
    throw new Error("This browser does not support passkeys.");
  }

  const optionsRes = await client.functions.invoke("passkey-register-options", { body: {} });
  const { options } = unwrap<{ options: any }>(optionsRes, "Could not start passkey setup.");

  let attestation;
  try {
    attestation = await startRegistration({ optionsJSON: options });
  } catch (err: any) {
    if (err?.name === "NotAllowedError") {
      throw new Error("Passkey setup was cancelled.");
    }
    throw new Error(err?.message || "Passkey setup failed on this device.");
  }

  const verifyRes = await client.functions.invoke("passkey-register-verify", {
    body: { attestation, challenge: options.challenge, device_name: deviceName },
  });
  unwrap(verifyRes, "Could not save that passkey.");
  return true;
}

/**
 * Signs the user in with a passkey. On success the backend returns a one-time
 * magic-link token hash which we immediately exchange for a real session.
 */
export async function signInWithPasskey(
  email: string | undefined,
  client: Client = defaultClient,
) {
  if (!passkeysSupported()) {
    throw new Error("This browser does not support passkeys.");
  }
  if (!email?.trim()) {
    throw new Error("Enter your email first so we can find your passkey.");
  }

  const optionsRes = await client.functions.invoke("passkey-auth-options", {
    body: { email: email.trim().toLowerCase() },
  });
  if ((optionsRes.data as any)?.error === "no_passkeys") {
    throw new Error(
      "No passkey is registered for this email yet. Sign in with the email link below, then open the shield icon in the header (Sign-in security) to add a passkey.",
    );
  }
  const { options } = unwrap<{ options: any }>(optionsRes, "Could not start passkey sign-in.");

  let assertion;
  try {
    assertion = await startAuthentication({ optionsJSON: options });
  } catch (err: any) {
    if (err?.name === "NotAllowedError") {
      throw new Error("Passkey sign-in was cancelled.");
    }
    throw new Error(err?.message || "Passkey sign-in failed on this device.");
  }

  const verifyRes = await client.functions.invoke("passkey-auth-verify", {
    body: { assertion, challenge: options.challenge },
  });
  const result = unwrap<{ email: string; token_hash: string }>(
    verifyRes,
    "Passkey sign-in failed.",
  );

  const { data, error } = await client.auth.verifyOtp({
    type: "email",
    token_hash: result.token_hash,
  });
  if (error) throw new Error(error.message);
  return data;
}

/** Sends a one-time magic-link email. */
export async function sendMagicLink(
  email: string,
  redirectTo: string,
  client: Client = defaultClient,
) {
  const { error } = await client.auth.signInWithOtp({
    email: email.trim().toLowerCase(),
    options: { emailRedirectTo: redirectTo, shouldCreateUser: false },
  });
  if (error) throw new Error(error.message);
}
