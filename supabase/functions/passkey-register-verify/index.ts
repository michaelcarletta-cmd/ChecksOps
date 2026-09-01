import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { verifyRegistrationResponse } from "https://esm.sh/@simplewebauthn/server@13.1.1";
import {
  b64uEncode,
  consumeChallenge,
  corsHeaders,
  json,
  requireUser,
  rpFromRequest,
  serviceClient,
} from "../_shared/webauthn.ts";

/** Verifies an attestation and stores the new passkey for the signed-in user. */
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const user = await requireUser(req);
    if (!user) return json({ error: "Not authenticated" }, 401);

    const body = await req.json().catch(() => ({}));
    const attestation = body?.attestation;
    const expectedChallenge = String(body?.challenge ?? "");
    const deviceName = String(body?.device_name ?? "").trim() || "Passkey";
    if (!attestation || !expectedChallenge) {
      return json({ error: "attestation and challenge are required" }, 400);
    }

    const { rpID, origin } = rpFromRequest(req);
    const supabase = serviceClient();

    const stored = await consumeChallenge(supabase, expectedChallenge, "register");
    if (!stored || stored.user_id !== user.id) {
      return json({ error: "This passkey setup attempt expired. Please try again." }, 400);
    }

    const verification = await verifyRegistrationResponse({
      response: attestation,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return json({ error: "We could not verify that passkey." }, 400);
    }

    const cred = verification.registrationInfo.credential;
    const { error: insertError } = await supabase.from("user_passkeys").insert({
      user_id: user.id,
      credential_id: cred.id,
      public_key: b64uEncode(cred.publicKey),
      counter: cred.counter ?? 0,
      transports: cred.transports ?? [],
      backed_up: verification.registrationInfo.credentialBackedUp ?? false,
      device_name: deviceName,
    });
    if (insertError) {
      if (insertError.code === "23505") {
        return json({ error: "That passkey is already registered." }, 409);
      }
      throw insertError;
    }

    await supabase
      .from("profiles")
      .update({
        passkey_enrolled_at: new Date().toISOString(),
        preferred_auth_method: "passkey",
      })
      .eq("id", user.id)
      .is("passkey_enrolled_at", null);

    return json({ verified: true });
  } catch (err) {
    console.error("passkey-register-verify", err);
    return json({ error: (err as Error).message || "Unable to save that passkey" }, 500);
  }
});
