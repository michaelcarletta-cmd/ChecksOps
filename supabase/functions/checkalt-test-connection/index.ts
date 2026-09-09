// Legacy Lovable CheckAlt test-connection is shut down. Fail closed before
// authentication, credential reads, or cached JWT use.
import { legacyCheckAltMoneyShutdownResponse } from "../_shared/legacy-checkalt-money-shutdown.ts";

Deno.serve((req) => {
  const out = legacyCheckAltMoneyShutdownResponse(req);
  return new Response(out.body, { status: out.status, headers: out.headers });
});
