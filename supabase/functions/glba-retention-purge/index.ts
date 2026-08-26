// GLBA retention purge — runs nightly, deletes PII from claims past their retention_purge_after date.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const dryRun = new URL(req.url).searchParams.get("dry_run") === "1";
  const summary: Record<string, unknown> = { started_at: new Date().toISOString(), dry_run: dryRun };

  try {
    // 1. Select claims past retention and not on legal hold
    const { data: due, error: dueErr } = await supabase
      .from("claims")
      .select("id, tenant_id, retention_purge_after, legal_hold")
      .lte("retention_purge_after", new Date().toISOString())
      .or("legal_hold.is.null,legal_hold.eq.false")
      .limit(500);

    if (dueErr) throw dueErr;
    summary.candidate_count = due?.length ?? 0;

    if (!due || due.length === 0 || dryRun) {
      await supabase.from("glba_security_events").insert({
        event_type: "retention_purge_run",
        severity: "info",
        description: dryRun ? "Dry run" : "No claims due for purge",
        metadata: summary,
      });
      return new Response(JSON.stringify(summary), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const claimIds = due.map((c) => c.id);
    const tenantsTouched = Array.from(new Set(due.map((c) => c.tenant_id).filter(Boolean)));

    // 2. Purge PII from related tables. Keep skeletal rows for aggregate financial audit trail.
    const tablesToDelete = [
      "claim_files",
      "claim_photos",
      "claim_communications_diary",
      "claim_additional_contacts",
      "claim_ai_conversations",
      "guided_communications",
    ];
    const deletions: Record<string, number> = {};

    for (const table of tablesToDelete) {
      const { error, count } = await supabase
        .from(table)
        .delete({ count: "exact" })
        .in("claim_id", claimIds);
      if (error) {
        console.warn(`[retention-purge] ${table}: ${error.message}`);
        deletions[table] = -1;
      } else {
        deletions[table] = count ?? 0;
      }
    }

    // 3. Redact NPI on claims themselves (keep id + financial totals for audit)
    const { error: redactErr } = await supabase
      .from("claims")
      .update({
        policyholder_name: null,
        policyholder_email: null,
        policyholder_phone: null,
        policyholder_address: null,
        policy_number: null,
        ssn_last_four: null,
        notes: null,
      } as Record<string, unknown>)
      .in("id", claimIds);
    if (redactErr) console.warn("[retention-purge] claims redact:", redactErr.message);

    summary.deletions = deletions;
    summary.purged_claim_count = claimIds.length;
    summary.tenants_touched = tenantsTouched;
    summary.completed_at = new Date().toISOString();

    await supabase.from("glba_security_events").insert({
      event_type: "retention_purge_run",
      severity: "info",
      description: `Purged ${claimIds.length} claim(s) past retention window`,
      metadata: summary,
    });

    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    await supabase.from("glba_security_events").insert({
      event_type: "retention_purge_error",
      severity: "error",
      description: msg,
      metadata: summary,
    });
    return new Response(JSON.stringify({ error: msg, summary }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
