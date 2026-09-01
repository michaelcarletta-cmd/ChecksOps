import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { generateAuthenticationOptions } from "https://esm.sh/@simplewebauthn/server@13.1.1";
import {
  corsHeaders,
  findUserByEmail,
  json,
  rpFromRequest,
  saveChallenge,
  serviceClient,
} from "../_shared/webauthn.ts";

/**
 * PUBLIC. Issues WebAuthn request options for passkey sign-in.
 * Never reveals whether an email exists: with no known credentials we still
 * return a valid discoverable-credential challenge.
 */
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const email = String(body?.email ?? "").trim().toLowerCase();

    const { rpID } = rpFromRequest(req);
    const supabase = serviceClient();

    let allowCredentials: { id: string; transports?: AuthenticatorTransport[] }[] = [];
    let userId: string | null = null;

    if (email) {
      const authUser = await findUserByEmail(supabase, email);
      if (authUser) {
        userId = authUser.id;
        const { data: creds } = await supabase
          .from("user_passkeys")
          .select("credential_id, transports")
          .eq("user_id", authUser.id);
        allowCredentials = (creds ?? []).map((c) => ({
          id: c.credential_id,
          transports: (c.transports ?? []) as AuthenticatorTransport[],
        }));
      }
    }

    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: "preferred",
      ...(allowCredentials.length > 0 ? { allowCredentials } : {}),
    });

    await saveChallenge(supabase, {
      challenge: options.challenge,
      purpose: "authenticate",
      email: email || null,
      userId,
    });

    return json({ options });
  } catch (err) {
    console.error("passkey-auth-options", err);
    return json({ error: (err as Error).message || "Unable to start passkey sign-in" }, 500);
  }
});
