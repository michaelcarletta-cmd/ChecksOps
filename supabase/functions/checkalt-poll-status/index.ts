// Legacy Lovable CheckAlt poll is shut down. Fail closed before any
// CheckAlt authentication, FinCapture HTTP, or deposit/check mutation.
import { legacyCheckAltMoneyShutdownResponse } from "../_shared/legacy-checkalt-money-shutdown.ts";

Deno.serve((req) => {
  const out = legacyCheckAltMoneyShutdownResponse(req);
  return new Response(out.body, { status: out.status, headers: out.headers });
});
