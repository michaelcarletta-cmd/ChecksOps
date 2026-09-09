// Legacy Lovable CheckAlt register is shut down. Fail closed before
// authentication, provider-side account creation, or tenant account upsert.
import { legacyCheckAltMoneyShutdownResponse } from "../_shared/legacy-checkalt-money-shutdown.ts";

Deno.serve((req) => {
  const out = legacyCheckAltMoneyShutdownResponse(req);
  return new Response(out.body, { status: out.status, headers: out.headers });
});
