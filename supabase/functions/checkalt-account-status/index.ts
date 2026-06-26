// On-demand CheckAlt (FinCapture) lookups that don't fit the
// submit/approve/poll lifecycle:
//   - user_account     -> GET-style lookup of a registered depositor's user account
//   - deposit_account  -> GET-style lookup of the bank account tied to that user
//   - deposit_item     -> single-item live status refresh (vs. the batch
//                         /deposit/history poll in checkalt-poll-status)
//
// CheckAlt has not provided sample payloads for these three endpoints — see
// the disclaimer in _shared/checkalt.ts. Treat responses as best-effort until
// verified against live UAT.

import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2/cors";
import { z } from "https://esm.sh/zod@3.23.8";
import {
  getServiceClient,
  loadTenantAccount,
  getUserAccountInfo,
  getDepositAccountInfo,
  getDepositItemStatus,
  mapDepositStatus,
  syncDepositItem,
} from "../_shared/checkalt.ts";

const BodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("user_account"), tenant_id: z.string().uuid() }),
  z.object({ action: z.literal("deposit_account"), tenant_id: z.string().uuid() }),
  z.object({ action: z.literal("deposit_item"), deposit_id: z.string().uuid() }),
]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const supabase = getServiceClient();
    const token = authHeader.replace("Bearer ", "");
    const { data: claims } = await supabase.auth.getClaims(token);
    const userId = claims?.claims?.sub;
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: parsed.error.flatten() }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const body = parsed.data;

    if (body.action === "user_account" || body.action === "deposit_account") {
      const { data: isTenantAdmin } = await supabase.rpc("is_tenant_admin", {
        _user_id: userId,
        _tenant_id: body.tenant_id,
      });
      const { data: isPlatformAdmin } = await supabase.rpc("has_role", {
        _user_id: userId,
        _role: "admin",
      });
      if (!isTenantAdmin && !isPlatformAdmin) {
        return new Response(JSON.stringify({ error: "Only tenant or platform admins can view CheckAlt account details" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const tenantAccount = await loadTenantAccount(supabase, body.tenant_id);
      const result = body.action === "user_account"
        ? await getUserAccountInfo(supabase, tenantAccount.sso_user_id)
        : await getDepositAccountInfo(supabase, tenantAccount.sso_user_id, tenantAccount.deposit_account_number);

      return new Response(JSON.stringify(result), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // deposit_item: live single-deposit status refresh, available to any
    // tenant member (read-only) or platform admin — not just admins.
    const { data: deposit, error: depErr } = await supabase
      .from("checkalt_deposits")
      .select("id, tenant_id, checkalt_reference, status, check_intake_item_id, submitted_by")
      .eq("id", body.deposit_id)
      .maybeSingle();
    if (depErr || !deposit) throw new Error(depErr?.message || "Deposit not found");
    if (!deposit.checkalt_reference) {
      throw new Error("Deposit has no CheckAlt reference yet");
    }

    const { data: isMember } = await supabase.rpc("is_tenant_member", {
      _user_id: userId,
      _tenant_id: deposit.tenant_id,
    });
    const { data: isPlatformAdmin } = await supabase.rpc("has_role", {
      _user_id: userId,
      _role: "admin",
    });
    if (!isMember && !isPlatformAdmin) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const tenantAccount = await loadTenantAccount(supabase, deposit.tenant_id);
    const result = await getDepositItemStatus(supabase, tenantAccount, deposit.checkalt_reference);

    if (result.ok) {
      const code = Number(result.json?.status ?? result.json?.statusCode ?? 0);
      const internal = mapDepositStatus(code, deposit.status);
      const updates: Record<string, unknown> = {
        last_polled_at: new Date().toISOString(),
        last_status_payload: result.json,
      };
      if (internal !== deposit.status) {
        updates.status = internal;
        if (internal === "cleared") updates.cleared_at = new Date().toISOString();
        if (internal === "rejected") updates.returned_at = new Date().toISOString();

        if ((internal === "cleared" || internal === "rejected" || internal === "error") && deposit.check_intake_item_id && deposit.submitted_by) {
          const { data: depositItem } = await supabase
            .from("deposit_items")
            .select("id, provider")
            .eq("check_id", deposit.check_intake_item_id)
            .maybeSingle();
          if (depositItem && depositItem.provider === "checkalt") {
            await syncDepositItem(supabase, {
              action: internal === "cleared" ? "record_success" : "record_failure",
              deposit_item_id: depositItem.id,
              actor_id: deposit.submitted_by,
              extra: internal === "cleared"
                ? { response: result.json }
                : { error: internal, error_code: String(code), response: result.json },
            });
          }
        }
      }
      await supabase.from("checkalt_deposits").update(updates).eq("id", deposit.id);
    }

    return new Response(JSON.stringify(result), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[checkalt-account-status]", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
