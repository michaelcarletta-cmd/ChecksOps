// Legacy Lovable CheckAlt account-status is shut down. Fail closed before
// authentication, FinCapture HTTP, or checkalt_deposits mutation.
import { legacyCheckAltMoneyShutdownResponse } from "../_shared/legacy-checkalt-money-shutdown.ts";

Deno.serve((req) => {
  const out = legacyCheckAltMoneyShutdownResponse(req);
  return new Response(out.body, { status: out.status, headers: out.headers });
});
