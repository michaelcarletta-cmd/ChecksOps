import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { generateRegistrationOptions } from "https://esm.sh/@simplewebauthn/server@13.1.1";
import {
  corsHeaders,
  json,
  requireUser,
  rpFromRequest,
  saveChallenge,
  serviceClient,
} from "../_shared/webauthn.ts";

/** Issues WebAuthn creation options so a signed-in user can add a passkey. */
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const user = await requireUser(req);
    if (!user) return json({ error: "Not authenticated" }, 401);

    const { rpID, rpName } = rpFromRequest(req);
    const supabase = serviceClient();

    const { data: existing } = await supabase
      .from("user_passkeys")
      .select("credential_id, transports")
      .eq("user_id", user.id);

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userID: new TextEncoder().encode(user.id),
      userName: user.email ?? user.id,
      userDisplayName: (user.user_metadata?.full_name as string) ?? user.email ?? "ChecksOps user",
      attestationType: "none",
      excludeCredentials: (existing ?? []).map((c) => ({
        id: c.credential_id,
        transports: c.transports ?? [],
      })),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
    });

    await saveChallenge(supabase, {
      challenge: options.challenge,
      purpose: "register",
      userId: user.id,
      email: user.email,
    });

    return json({ options });
  } catch (err) {
    console.error("passkey-register-options", err);
    return json({ error: (err as Error).message || "Unable to start passkey setup" }, 500);
  }
});
