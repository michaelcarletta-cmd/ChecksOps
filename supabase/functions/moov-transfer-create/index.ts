// Historical combined transfer writer is held. Fail closed before any Moov POST.
import { legacyMoovMoneyShutdownResponse } from '../_shared/legacy-moov-money-shutdown.ts';

Deno.serve((req) => {
  const out = legacyMoovMoneyShutdownResponse(req);
  return new Response(out.body, { status: out.status, headers: out.headers });
});
