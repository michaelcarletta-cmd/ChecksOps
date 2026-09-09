// Legacy Lovable CheckAlt submit is shut down. Fail closed before any
// CheckAlt authentication, FinCapture HTTP, auto-approve, or financial writes.
import { legacyCheckAltMoneyShutdownResponse } from "../_shared/legacy-checkalt-money-shutdown.ts";

Deno.serve((req) => {
  const out = legacyCheckAltMoneyShutdownResponse(req);
  return new Response(out.body, { status: out.status, headers: out.headers });
});
