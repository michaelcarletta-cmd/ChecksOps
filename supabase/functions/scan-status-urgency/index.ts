// Hourly status-based urgency scanner
// - Iterates active urgency rules
// - For 'inactivity' rules: finds claims in matching status with last_activity_at older than threshold
// - For 'inspection_morning_of' / 'inspection_day_after' rules: finds inspections at the right window
// - Creates/updates a claim_warnings_log entry and an SMS notification (max once per 24h per claim+rule)
// - Daily reminder cadence is enforced via status_urgency_notifications_log.last_notified_at
// - Auto-resolves notifications when the claim leaves the breaching status

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { isWithinBusinessHours, outsideBusinessHoursResponse } from "../_shared/business-hours-gate.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

interface Rule {
  id: string;
  rule_key: string;
  display_label: string;
  status_names: string[];
  threshold_days: number;
  count_mode: "calendar" | "business";
  trigger_kind: "inactivity" | "inspection_morning_of" | "inspection_day_after";
  is_enabled: boolean;
}

const SEVERITY_FOR_THRESHOLD = (days: number): string => {
  if (days <= 2) return "high";
  if (days <= 10) return "medium";
  return "high";
};

// Subtract N business days (Mon-Fri) from a given date
function subtractBusinessDays(from: Date, days: number): Date {
  const d = new Date(from);
  let remaining = days;
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() - 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) remaining--;
  }
  return d;
}

function todayUTC(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Cron-style auth: accept any bearer or x-cron-secret
  const auth = req.headers.get("authorization") || req.headers.get("Authorization");
  const cronHdr = req.headers.get("x-cron-secret");
  if (!auth?.startsWith("Bearer ") && !cronHdr) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const summary = {
    rulesProcessed: 0,
    breachesFound: 0,
    warningsCreated: 0,
    warningsUpdated: 0,
    smsSent: 0,
    autoResolved: 0,
    errors: [] as string[],
  };

  try {
    // Pre-clean: any existing active log entries for claims now in Litigation
    const { data: litLogs } = await supabase
      .from("status_urgency_notifications_log")
      .select("id, claim_id, claims:claim_id(status)")
      .eq("is_resolved", false);

    for (const row of (litLogs || []) as any[]) {
      if (row.claims?.status === "Litigation") {
        await supabase
          .from("status_urgency_notifications_log")
          .update({ is_resolved: true, resolved_at: new Date().toISOString() })
          .eq("id", row.id);
        summary.autoResolved++;
      }
    }

    // Load active rules
    const { data: rules, error: rulesErr } = await supabase
      .from("status_urgency_rules")
      .select("*")
      .eq("is_enabled", true);
    if (rulesErr) throw rulesErr;

    // Load admin recipient phone numbers (workspace-wide)
    const { data: recipients } = await supabase
      .from("urgency_sms_recipients")
      .select("phone_number, display_name")
      .eq("is_active", true);

    const phones: string[] = (recipients || [])
      .map((r) => (r as any).phone_number)
      .filter(Boolean);

    const now = new Date();
    const nowIso = now.toISOString();

    for (const rule of (rules || []) as Rule[]) {
      summary.rulesProcessed++;

      try {
        if (rule.trigger_kind === "inactivity") {
          const cutoff =
            rule.count_mode === "business"
              ? subtractBusinessDays(now, rule.threshold_days)
              : new Date(now.getTime() - rule.threshold_days * 86400000);

          const { data: claims, error: cErr } = await supabase
            .from("claims")
            .select("id, claim_number, status, last_activity_at, policyholder_name")
            .eq("is_closed", false)
            .in("status", rule.status_names)
            .lte("last_activity_at", cutoff.toISOString())
            .neq("status", "Litigation")
            .limit(500);
          if (cErr) throw cErr;

          for (const claim of claims || []) {
            await processBreach(supabase, rule, claim as any, null, phones, nowIso, summary);
            summary.breachesFound++;
          }
        } else if (
          rule.trigger_kind === "inspection_morning_of" ||
          rule.trigger_kind === "inspection_day_after"
        ) {
          const target = todayUTC();
          if (rule.trigger_kind === "inspection_day_after") {
            target.setUTCDate(target.getUTCDate() - 1);
          }
          const targetDateStr = target.toISOString().slice(0, 10);

          const { data: inspections, error: iErr } = await supabase
            .from("inspections")
            .select("id, claim_id, inspection_date, inspection_time, claims:claim_id(id, claim_number, status, last_activity_at, policyholder_name, is_closed)")
            .eq("inspection_date", targetDateStr)
            .limit(500);
          if (iErr) throw iErr;

          for (const insp of inspections || []) {
            const claim = (insp as any).claims;
            if (!claim || claim.is_closed) continue;
            if (!rule.status_names.includes(claim.status)) continue;
            if (claim.status === "Litigation") continue;

            // For day-after: skip if any update has been logged after the inspection date
            if (rule.trigger_kind === "inspection_day_after") {
              const inspectionEnd = new Date(`${targetDateStr}T23:59:59Z`);
              if (claim.last_activity_at && new Date(claim.last_activity_at) > inspectionEnd) {
                continue;
              }
            }

            await processBreach(
              supabase,
              rule,
              { ...claim, id: claim.id },
              (insp as any).id,
              phones,
              nowIso,
              summary,
            );
            summary.breachesFound++;
          }
        }
      } catch (e: any) {
        console.error(`Rule ${rule.rule_key} failed:`, e?.message);
        summary.errors.push(`${rule.rule_key}: ${e?.message}`);
      }
    }

    // Auto-resolve: any active log row whose claim status no longer matches its rule
    const { data: openLogs } = await supabase
      .from("status_urgency_notifications_log")
      .select("id, claim_id, status_at_breach, rule_id, rule:rule_id(status_names), claims:claim_id(status)")
      .eq("is_resolved", false);

    for (const row of (openLogs || []) as any[]) {
      const currentStatus = row.claims?.status;
      const ruleStatuses: string[] = row.rule?.status_names || [];
      if (!currentStatus || !ruleStatuses.includes(currentStatus)) {
        await supabase
          .from("status_urgency_notifications_log")
          .update({ is_resolved: true, resolved_at: nowIso })
          .eq("id", row.id);
        summary.autoResolved++;
      }
    }

    return new Response(JSON.stringify({ success: true, summary }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("scan-status-urgency error:", error);
    return new Response(JSON.stringify({ error: error?.message, summary }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function processBreach(
  supabase: any,
  rule: Rule,
  claim: { id: string; claim_number?: string | null; status: string; last_activity_at?: string | null; policyholder_name?: string | null },
  inspectionId: string | null,
  phones: string[],
  nowIso: string,
  summary: { warningsCreated: number; warningsUpdated: number; smsSent: number },
) {
  const ref = claim.claim_number || `#${claim.id.slice(0, 8)}`;
  const severity = SEVERITY_FOR_THRESHOLD(rule.threshold_days);

  let title = "";
  let message = "";
  if (rule.trigger_kind === "inactivity") {
    // Compute actual days since last activity for a precise, human-readable reason
    const lastActivityIso = claim.last_activity_at;
    const daysSince = lastActivityIso
      ? Math.max(
          rule.threshold_days,
          Math.floor((Date.now() - new Date(lastActivityIso).getTime()) / 86400000),
        )
      : rule.threshold_days;
    const unit = rule.count_mode === "business" ? "business days" : "days";
    const lastTs = lastActivityIso
      ? new Date(lastActivityIso).toISOString().slice(0, 10)
      : "unknown";
    title = `No updates for ${daysSince} ${unit} — ${ref}`;
    message = `${ref} has been in "${claim.status}" with no updates for ${daysSince} ${unit} (last activity ${lastTs}). Take action to avoid stalling.`;
  } else if (rule.trigger_kind === "inspection_morning_of") {
    title = `Inspection scheduled today — ${ref}`;
    message = `${ref} has an inspection scheduled today. Confirm attendance and prep.`;
  } else {
    title = `Inspection follow-up needed — ${ref}`;
    message = `${ref} had an inspection yesterday with no update logged. Capture findings and next steps.`;
  }

  const inspKey = inspectionId ?? "00000000-0000-0000-0000-000000000000";

  // Find existing active log row
  const { data: existing } = await supabase
    .from("status_urgency_notifications_log")
    .select("id, last_notified_at, total_sent, warning_id")
    .eq("claim_id", claim.id)
    .eq("rule_id", rule.id)
    .eq("status_at_breach", claim.status)
    .eq("is_resolved", false)
    .maybeSingle();

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const shouldSendSms = !existing || new Date(existing.last_notified_at) < oneDayAgo;

  let warningId = existing?.warning_id ?? null;

  if (!existing) {
    // Create warning entry
    const { data: w } = await supabase
      .from("claim_warnings_log")
      .insert({
        claim_id: claim.id,
        warning_type: `urgency_${rule.rule_key}`,
        severity,
        title,
        message,
        source: "status_urgency",
        trigger_context: "general",
      })
      .select("id")
      .single();
    warningId = w?.id ?? null;

    await supabase.from("status_urgency_notifications_log").insert({
      claim_id: claim.id,
      rule_id: rule.id,
      status_at_breach: claim.status,
      inspection_id: inspectionId,
      notification_kind: rule.trigger_kind,
      first_breached_at: nowIso,
      last_notified_at: nowIso,
      total_sent: 1,
      sms_recipient_count: phones.length,
      warning_id: warningId,
    });
    summary.warningsCreated++;
  } else if (shouldSendSms) {
    await supabase
      .from("status_urgency_notifications_log")
      .update({
        last_notified_at: nowIso,
        total_sent: (existing.total_sent || 1) + 1,
        sms_recipient_count: phones.length,
      })
      .eq("id", existing.id);
    summary.warningsUpdated++;
  } else {
    return; // already notified within 24h, skip SMS
  }

  // Send SMS to all admin recipients
  if (shouldSendSms && phones.length > 0) {
    const smsBody = `[Freedom Claims] ${title}\n${message}`.slice(0, 480);
    for (const phone of phones) {
      try {
        await sendUrgencySms(supabase, claim.id, phone, smsBody);
        summary.smsSent++;
      } catch (e: any) {
        console.error(`SMS send failed for ${phone}:`, e?.message);
      }
    }
  }
}

// Direct Telnyx send (the existing /send-sms requires a user JWT; we run unattended).
async function sendUrgencySms(
  supabase: any,
  claimId: string,
  toNumber: string,
  body: string,
) {
  const TELNYX_API_KEY = Deno.env.get("TELNYX_API_KEY");
  const TELNYX_PHONE_NUMBER = Deno.env.get("TELNYX_PHONE_NUMBER");
  const TELNYX_MESSAGING_PROFILE_ID = Deno.env.get("TELNYX_MESSAGING_PROFILE_ID");
  if (!TELNYX_API_KEY || !TELNYX_PHONE_NUMBER) {
    throw new Error("Telnyx env not configured");
  }

  const normalize = (p: string) => {
    const d = p.replace(/\D/g, "");
    if (d.length === 10) return `+1${d}`;
    if (d.length === 11 && d.startsWith("1")) return `+${d}`;
    return p.startsWith("+") ? p : `+${d}`;
  };
  const to = normalize(toNumber);

  const resp = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TELNYX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: TELNYX_PHONE_NUMBER,
      to,
      text: body,
      messaging_profile_id: TELNYX_MESSAGING_PROFILE_ID || undefined,
    }),
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`Telnyx ${resp.status}: ${JSON.stringify(json)}`);
  }

  // Log lightweight audit so it shows in claim updates
  await supabase.from("claim_updates").insert({
    claim_id: claimId,
    update_type: "urgency_sms",
    content: `📱 Urgency SMS sent to ${to}: ${body.slice(0, 160)}`,
  });
}
