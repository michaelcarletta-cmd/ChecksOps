import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { moovFetch, scopes, moovOrigin, moovHost } from "../_shared/moovClient.ts";

// Temporary diagnostic: lists the platform's visible accounts and any fee plans
// attached to them. Read-only.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const out: any = { host: moovHost(), origin: moovOrigin(), accounts: [], errors: [] };

  try {
    const accounts = await moovFetch<any>("/accounts", {
      method: "GET",
      scopes: scopes.accountsWrite(),
    });
    const list = Array.isArray(accounts) ? accounts : accounts?.accounts ?? [];
    for (const a of list) {
      const id = a?.accountID ?? a?.accountId;
      const entry: any = {
        accountID: id,
        displayName: a?.displayName ?? a?.profile?.business?.legalBusinessName ?? null,
        mode: a?.mode ?? null,
        feePlans: null,
        feePlanError: null,
      };
      try {
        const plans = await moovFetch<any>(`/accounts/${id}/fee-plans`, {
          method: "GET",
          scopes: scopes.accountWrite(id),
        });
        entry.feePlans = Array.isArray(plans) ? plans : plans?.feePlans ?? plans;
      } catch (e) {
        entry.feePlanError = (e as Error).message;
      }
      out.accounts.push(entry);
    }
  } catch (e) {
    const err = e as any;
    out.errors.push({ step: "accounts", message: err.message, status: err.status ?? null, body: err.body ?? null });
  }

  // Also try the platform/facilitator account implied by the credentials.
  try {
    const me = await moovFetch<any>("/ping", { method: "GET", scopes: scopes.accountsWrite() });
    out.ping = me ?? "ok";
  } catch (e) {
    const err = e as any;
    out.errors.push({ step: "ping", message: err.message, status: err.status ?? null, body: err.body ?? null });
  }

  return new Response(JSON.stringify(out, null, 2), {
    headers: { ...cors, "Content-Type": "application/json" },
  });
});
