import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function deriveKey(secret: string): Promise<CryptoKey> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function decrypt(b64: string, secret: string): Promise<string> {
  const key = await deriveKey(secret);
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

function firstOfCurrentMonth(d = new Date()): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
}
function firstOfNextMonth(d = new Date()): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // Auth: allow either platform admin (via user JWT) or cron (service role header)
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const authHeader = req.headers.get("Authorization") ?? "";
    const isCron = authHeader === `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`;

    let actorUserId: string | null = null;
    if (!isCron) {
      const authClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } },
      );
      const { data: userData } = await authClient.auth.getUser();
      if (!userData?.user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      // Must be platform admin
      if (userData.user.email !== "mcarletta@freedomadj.com") {
        return new Response(JSON.stringify({ error: "Forbidden: platform admin only" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      actorUserId = userData.user.id;
    }

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const targetTenantIds: string[] | null = body?.tenant_ids ?? null;
    const dryRun: boolean = !!body?.dry_run;

    // Actum config (reuses the same merchant credentials used for disbursements)
    const parentId = Deno.env.get("ACTUM_PARENT_ID");
    const subId = Deno.env.get("ACTUM_SUB_ID");
    const syspass = Deno.env.get("ACTUM_SYSPASS");
    const apiUser = Deno.env.get("ACTUM_USERNAME");
    const apiPass = Deno.env.get("ACTUM_PASSWORD");
    if (!dryRun && (!parentId || !subId)) {
      throw new Error("Actum credentials not configured (ACTUM_PARENT_ID / ACTUM_SUB_ID)");
    }
    const keyB64 = Deno.env.get("TENANT_BILLING_ENCRYPTION_KEY");
    if (!keyB64) throw new Error("TENANT_BILLING_ENCRYPTION_KEY not configured");

    const period_start = firstOfCurrentMonth();
    const period_end = firstOfNextMonth();

    // Load candidate tenants
    let tenantsQ = supabase
      .from("tenants")
      .select("id, name, monthly_rate_cents, referral_discount_cents, is_system_tenant")
      .eq("is_system_tenant", false);
    if (targetTenantIds && targetTenantIds.length) tenantsQ = tenantsQ.in("id", targetTenantIds);
    const { data: tenants, error: tErr } = await tenantsQ;
    if (tErr) throw tErr;

    const results: any[] = [];
    for (const t of tenants ?? []) {
      const amount_cents = Math.max(0, (t.monthly_rate_cents ?? 0) - (t.referral_discount_cents ?? 0));
      if (amount_cents <= 0) {
        results.push({ tenant_id: t.id, name: t.name, skipped: "zero_amount" });
        continue;
      }

      // Idempotency: one charge per tenant per period
      const idempotence_key = `maint_${t.id}_${period_start}`;
      const { data: existing } = await supabase
        .from("tenant_maintenance_payments")
        .select("id, status")
        .eq("idempotence_key", idempotence_key)
        .maybeSingle();
      if (existing) {
        results.push({ tenant_id: t.id, name: t.name, skipped: "already_charged", status: existing.status });
        continue;
      }

      const { data: account } = await supabase
        .from("tenant_billing_accounts")
        .select("*")
        .eq("tenant_id", t.id)
        .maybeSingle();

      if (!account) {
        results.push({ tenant_id: t.id, name: t.name, skipped: "no_billing_account" });
        continue;
      }
      if (!account.auto_debit_enabled) {
        results.push({ tenant_id: t.id, name: t.name, skipped: "auto_debit_disabled" });
        continue;
      }
      if (!account.ach_authorized_at) {
        results.push({ tenant_id: t.id, name: t.name, skipped: "no_ach_authorization" });
        continue;
      }
      // Bank details come from the Plaid-verified stakeholder account.
      // No plaintext or encrypted bank numbers are stored on tenant_billing_accounts.
      if (!account.stakeholder_account_id) {
        results.push({ tenant_id: t.id, name: t.name, skipped: "no_linked_bank_account" });
        continue;
      }
      const { data: bank } = await supabase
        .from("stakeholder_accounts")
        .select("id, chk_aba, chk_acct, acct_type, custname, verification_status, is_active")
        .eq("id", account.stakeholder_account_id)
        .maybeSingle();
      if (!bank || !bank.is_active) {
        results.push({ tenant_id: t.id, name: t.name, skipped: "bank_account_inactive" });
        continue;
      }
      if (!["verified", "admin_override"].includes(bank.verification_status)) {
        results.push({ tenant_id: t.id, name: t.name, skipped: `bank_${bank.verification_status}` });
        continue;
      }

      if (dryRun) {
        results.push({ tenant_id: t.id, name: t.name, would_charge_cents: amount_cents });
        continue;
      }

      // Insert pending payment first
      const { data: payment, error: payErr } = await supabase
        .from("tenant_maintenance_payments")
        .insert({
          tenant_id: t.id,
          amount_cents,
          period_start,
          period_end,
          method: "actum_ach",
          status: "pending",
          idempotence_key,
          recorded_by: actorUserId,
          notes: `Auto-debit for ${period_start.slice(0, 7)}`,
        })
        .select()
        .single();
      if (payErr) {
        results.push({ tenant_id: t.id, name: t.name, error: `insert_failed: ${payErr.message}` });
        continue;
      }

      // Build Actum debit
      const params = new URLSearchParams();
      params.append("parent_id", parentId!);
      params.append("sub_id", subId!);
      if (syspass) params.append("syspass", syspass);
      if (apiUser) params.append("username", apiUser);
      if (apiPass) params.append("password", apiPass);
      params.append("pmt_type", "chk");
      params.append("initial_amount", (amount_cents / 100).toFixed(2));
      params.append("billing_cycle", "-1");
      params.append("action_code", "D"); // Debit
      params.append("creditflag", "0");
      params.append("currency", "US");
      params.append("merordernumber", `maint_${payment.id}`);
      params.append("postback", "1");
      params.append("idempotence", idempotence_key);

      if (account.actum_consumer_unique) {
        params.append("consumer_code", account.actum_consumer_unique);
      } else {
        params.append("custname", bank.custname);
        params.append("chk_acct", bank.chk_acct);
        params.append("chk_aba", bank.chk_aba);
        params.append("acct_type", bank.acct_type === "S" ? "S" : "C");
      }

      const actumRes = await fetch("https://join.actumprocessing.com/cgi-bin/dbs/man_trans.cgi", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
      const responseText = await actumRes.text();
      const parsed: Record<string, string> = {};
      for (const line of responseText.split("\n").map((l) => l.trim()).filter(Boolean)) {
        const eq = line.indexOf("=");
        if (eq > -1) parsed[line.slice(0, eq)] = line.slice(eq + 1);
      }
      const accepted = (parsed.status ?? "").toLowerCase() === "accepted";

      if (parsed.consumer_unique && !account.actum_consumer_unique) {
        await supabase
          .from("tenant_billing_accounts")
          .update({ actum_consumer_unique: parsed.consumer_unique })
          .eq("id", account.id);
      }

      await supabase.from("actum_transactions").insert({
        tenant_id: t.id,
        actum_order_id: parsed.order_id,
        actum_history_id: parsed.history_id,
        consumer_unique: parsed.consumer_unique,
        mer_order_number: `maint_${payment.id}`,
        transaction_type: "debit",
        amount: amount_cents / 100,
        status: accepted ? "accepted" : "declined",
        auth_code: parsed.authcode,
        response_reason: parsed.reason,
        raw_response: parsed,
        idempotence_key,
      });

      await supabase
        .from("tenant_maintenance_payments")
        .update({
          status: accepted ? "submitted" : "failed",
          actum_order_id: parsed.order_id ?? null,
          actum_history_id: parsed.history_id ?? null,
          actum_consumer_unique: parsed.consumer_unique ?? null,
          failure_reason: accepted ? null : (parsed.reason ?? parsed.authcode ?? "declined"),
          submitted_at: accepted ? new Date().toISOString() : null,
        })
        .eq("id", payment.id);

      results.push({
        tenant_id: t.id,
        name: t.name,
        amount_cents,
        status: accepted ? "submitted" : "failed",
        actum_order_id: parsed.order_id,
        reason: parsed.reason,
      });
    }

    return new Response(
      JSON.stringify({ success: true, period_start, period_end, count: results.length, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    console.error("[charge-tenant-maintenance]", err);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
