import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { verifyAuthenticationResponse } from "https://esm.sh/@simplewebauthn/server@13.1.1";
import {
  b64uDecode,
  b64uEncode,
  consumeChallenge,
  corsHeaders,
  json,
  rpFromRequest,
  serviceClient,
} from "../_shared/webauthn.ts";

/**
 * PUBLIC. Verifies a passkey assertion and, on success, mints a one-time
 * magic-link token hash the browser exchanges for a real session via
 * supabase.auth.verifyOtp(). The token never leaves this response body.
 */
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const assertion = body?.assertion;
    const expectedChallenge = String(body?.challenge ?? "");
    if (!assertion?.id || !expectedChallenge) {
      return json({ error: "assertion and challenge are required" }, 400);
    }

    const { rpID, origin } = rpFromRequest(req);
    const supabase = serviceClient();

    const stored = await consumeChallenge(supabase, expectedChallenge, "authenticate");
    if (!stored) {
      return json({ error: "This sign-in attempt expired. Please try again." }, 400);
    }

    const { data: cred } = await supabase
      .from("user_passkeys")
      .select("id, user_id, credential_id, public_key, counter, transports")
      .eq("credential_id", assertion.id)
      .maybeSingle();

    if (!cred) return json({ error: "That passkey is not registered." }, 404);
    if (stored.user_id && stored.user_id !== cred.user_id) {
      return json({ error: "That passkey does not match this account." }, 403);
    }

    const verification = await verifyAuthenticationResponse({
      response: assertion,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
      credential: {
        id: cred.credential_id,
        publicKey: b64uDecode(cred.public_key),
        counter: Number(cred.counter ?? 0),
        transports: (cred.transports ?? []) as AuthenticatorTransport[],
      },
    });

    if (!verification.verified) {
      return json({ error: "We could not verify that passkey." }, 401);
    }

    await supabase
      .from("user_passkeys")
      .update({
        counter: verification.authenticationInfo.newCounter,
        last_used_at: new Date().toISOString(),
      })
      .eq("id", cred.id);

    const { data: authUser } = await supabase.auth.admin.getUserById(cred.user_id);
    const email = authUser?.user?.email;
    if (!email) return json({ error: "This account cannot sign in with a passkey." }, 400);

    const { data: link, error: linkError } = await supabase.auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    if (linkError || !link?.properties?.hashed_token) {
      console.error("generateLink failed", linkError);
      return json({ error: "Could not start your session. Please try again." }, 500);
    }

    return json({
      verified: true,
      email,
      token_hash: link.properties.hashed_token,
    });
  } catch (err) {
    console.error("passkey-auth-verify", err);
    return json({ error: (err as Error).message || "Passkey sign-in failed" }, 500);
  }
});
