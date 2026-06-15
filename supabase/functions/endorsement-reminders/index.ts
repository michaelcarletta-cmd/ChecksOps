import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { isWithinBusinessHours, outsideBusinessHoursResponse } from "../_shared/business-hours-gate.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Business hours gate: skip execution outside 6 AM – 10 PM ET
  if (!isWithinBusinessHours()) {
    console.log("Skipping endorsement-reminders: outside business hours");
    return outsideBusinessHoursResponse(corsHeaders);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // System-default reminder copy (used when a tenant hasn't overridden it).
    const { data: brandingRow } = await supabase
      .from("company_branding")
      .select("endorsement_reminder_subject, endorsement_reminder_body")
      .limit(1)
      .maybeSingle();
    const defaultReminderSubject = brandingRow?.endorsement_reminder_subject || "Reminder: Endorsement Required — Check #{check.number}";
    const defaultReminderBody = brandingRow?.endorsement_reminder_body || "This is a reminder that your endorsement is still needed for the check below. Please take a moment to review and endorse.";

    // Per-tenant brand cache so each tenant's reminders use their own company name (never Freedom's).
    const tenantBrandCache = new Map<string, { name: string | null }>();
    async function getTenantBrand(checkId: string): Promise<{ name: string | null } | null> {
      const { data: ck } = await supabase.from("check_intake_items").select("tenant_id").eq("id", checkId).maybeSingle();
      const tenantId = (ck as any)?.tenant_id;
      if (!tenantId) return null;
      if (tenantBrandCache.has(tenantId)) return tenantBrandCache.get(tenantId)!;
      const { data: t } = await supabase.from("tenants").select("name, is_system_tenant").eq("id", tenantId).maybeSingle();
      const brand = { name: (t as any)?.is_system_tenant === false ? ((t as any)?.name ?? null) : null };
      tenantBrandCache.set(tenantId, brand);
      return brand;
    }

    // Fetch stale unsigned endorsements (> 48 hours since last contact, max 5 reminders)
    // CRITICAL: Only include endorsements that are NOT signed, waived, rejected, or expired
    const { data: stale, error: staleErr } = await supabase
      .from("check_endorsements")
      .select("id, check_id, payee_name, payee_type, status, contact_email, contact_phone, reminder_count, last_reminder_at, request_sent_at, created_at, token, signed_at, check_intake_items(check_number, carrier_name, amount)")
      .in("status", ["pending", "sent"])
      .is("signed_at", null)
      .neq("payee_type", "mortgage_company")
      .lt("reminder_count", 5);

    if (staleErr) throw staleErr;

    const FORTY_EIGHT_HOURS = 48 * 60 * 60 * 1000;
    const now = Date.now();
    let remindersCount = 0;
    let flaggedCount = 0;

    for (const endorsement of stale ?? []) {
      // Double-check: skip any endorsement that's somehow already signed
      if (endorsement.signed_at || endorsement.status === "signed" || endorsement.status === "waived" || endorsement.status === "rejected" || endorsement.status === "expired") {
        console.log(`[endorsement-reminders] Skipping ${endorsement.payee_name} — status: ${endorsement.status}, signed_at: ${endorsement.signed_at}`);
        continue;
      }

      const lastContact = endorsement.last_reminder_at || endorsement.request_sent_at || endorsement.created_at;
      const elapsed = now - new Date(lastContact).getTime();

      if (elapsed < FORTY_EIGHT_HOURS) continue;

      // If no contact info, just flag it
      if (!endorsement.contact_email && !endorsement.contact_phone) {
        await supabase.from("endorsement_audit_log").insert({
          endorsement_id: endorsement.id,
          check_id: endorsement.check_id,
          event_type: "stale_flagged",
          event_description: `${endorsement.payee_name} stale ${Math.round(elapsed / 3600000)}h — no contact info available`,
        });
        flaggedCount++;
        continue;
      }

      const checkInfo = endorsement.check_intake_items as any;
      const appUrl = Deno.env.get("APP_URL") || "https://freedomclaims.lovable.app";
      const endorsementUrl = `${appUrl}/endorse?token=${endorsement.token}`;
      let sent = false;

      // Try email first
      if (endorsement.contact_email) {
        try {
          const { error } = await supabase.functions.invoke("send-email", {
            body: {
              to: endorsement.contact_email,
              subject: reminderSubject.replace(/\{check\.number\}/g, checkInfo?.check_number ?? "N/A").replace(/\{check\.amount\}/g, checkInfo?.amount ?? "N/A").replace(/\{check\.carrier\}/g, checkInfo?.carrier_name ?? "your insurance carrier").replace(/\{payee\.name\}/g, endorsement.payee_name),
              body: `<p>Hi ${endorsement.payee_name},</p><p>${reminderBody.replace(/\{check\.number\}/g, checkInfo?.check_number ?? "N/A").replace(/\{check\.amount\}/g, `$${checkInfo?.amount ?? "N/A"}`).replace(/\{check\.carrier\}/g, checkInfo?.carrier_name ?? "your insurance carrier").replace(/\{payee\.name\}/g, endorsement.payee_name).replace(/\n/g, "</p><p>")}</p><p>This is reminder #${endorsement.reminder_count + 1}.</p><p><a href="${endorsementUrl}">Click here to review &amp; endorse</a></p>`,
              checkId: endorsement.check_id,
            },
          });
          if (!error) sent = true;
        } catch { /* continue */ }
      }

      // Try SMS if email failed or unavailable
      if (!sent && endorsement.contact_phone) {
        try {
          const { error } = await supabase.functions.invoke("send-sms", {
            body: {
              to: endorsement.contact_phone,
              message: `Reminder (${endorsement.reminder_count + 1}): Endorsement needed for check #${checkInfo?.check_number ?? "N/A"} ($${checkInfo?.amount ?? "N/A"}). Sign: ${endorsementUrl}`,
            },
          });
          if (!error) sent = true;
        } catch { /* continue */ }
      }

      // Update the endorsement record
      await supabase.from("check_endorsements").update({
        last_reminder_at: new Date().toISOString(),
        reminder_count: endorsement.reminder_count + 1,
        updated_at: new Date().toISOString(),
      }).eq("id", endorsement.id);

      // Log
      await supabase.from("endorsement_audit_log").insert({
        endorsement_id: endorsement.id,
        check_id: endorsement.check_id,
        event_type: sent ? "auto_reminder_sent" : "auto_reminder_failed",
        event_description: sent
          ? `Auto-reminder #${endorsement.reminder_count + 1} sent to ${endorsement.payee_name}`
          : `Auto-reminder #${endorsement.reminder_count + 1} failed for ${endorsement.payee_name}`,
      });

      // If hit max reminders, flag for escalation
      if (endorsement.reminder_count + 1 >= 5) {
        await supabase.from("endorsement_audit_log").insert({
          endorsement_id: endorsement.id,
          check_id: endorsement.check_id,
          event_type: "escalation_needed",
          event_description: `${endorsement.payee_name} has not responded after 5 reminders — escalation needed`,
        });
        flaggedCount++;
      }

      remindersCount++;
    }

    return new Response(
      JSON.stringify({ success: true, reminders_sent: remindersCount, flagged: flaggedCount }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("endorsement-reminders error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
