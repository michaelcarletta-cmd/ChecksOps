// Nightly reconciliation: detects orphan storage files, dashboard count
// mismatches, missing mortgage rows, and stale checks past SLA.
// Writes to public.check_reconciliation_alerts.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const alerts: Array<{
    alert_type: string;
    severity: string;
    check_intake_item_id?: string;
    details: Record<string, unknown>;
  }> = [];

  try {
    // 1. Stale checks (past SLA in non-terminal status)
    const { data: stuck } = await admin.rpc("get_stuck_checks");
    for (const c of (stuck as any[]) ?? []) {
      if (c.is_overdue) {
        alerts.push({
          alert_type: "stale_status",
          severity:
            c.hours_in_status > c.sla_hours * 2 ? "critical" : "warning",
          check_intake_item_id: c.id,
          details: {
            status: c.status,
            hours_in_status: c.hours_in_status,
            sla_hours: c.sla_hours,
          },
        });
      }
    }

    // 2. Mortgage row gap: check has a mortgagee but no loss_draft_tracking row
    const { data: mortChecks } = await admin
      .from("check_intake_items")
      .select("id, payee_line, mortgage_monitoring_type")
      .neq("mortgage_monitoring_type", "not_set");
    for (const c of (mortChecks as any[]) ?? []) {
      const { count } = await admin
        .from("loss_draft_tracking")
        .select("id", { count: "exact", head: true })
        .eq("check_intake_item_id", c.id);
      if ((count ?? 0) === 0) {
        alerts.push({
          alert_type: "missing_loss_draft_row",
          severity: "warning",
          check_intake_item_id: c.id,
          details: { payee_line: c.payee_line },
        });
      }
    }

    // 3. Orphan storage files in check-intake bucket
    const { data: files } = await admin.storage
      .from("check-intake")
      .list("", { limit: 1000 });
    if (files) {
      for (const f of files) {
        if (!f.name) continue;
        const { count } = await admin
          .from("check_intake_items")
          .select("id", { count: "exact", head: true })
          .or(
            `front_image_path.ilike.%${f.name}%,back_image_path.ilike.%${f.name}%`,
          );
        if ((count ?? 0) === 0) {
          alerts.push({
            alert_type: "orphan_storage_file",
            severity: "info",
            details: { file_name: f.name, bucket: "check-intake" },
          });
        }
      }
    }

    // 4. Dashboard count parity (ChecksOps statuses)
    const { count: total } = await admin
      .from("check_intake_items")
      .select("id", { count: "exact", head: true });
    const buckets = [
      "uploaded",
      "needs_review",
      "endorsing",
      "approved_for_deposit",
      "loss_draft_required",
      "branch_deposit_required",
      "deposited",
    ];
    let sum = 0;
    for (const s of buckets) {
      const { count } = await admin
        .from("check_intake_items")
        .select("id", { count: "exact", head: true })
        .eq("status", s);
      sum += count ?? 0;
    }
    if ((total ?? 0) !== sum) {
      alerts.push({
        alert_type: "dashboard_count_mismatch",
        severity: "critical",
        details: { total, bucket_sum: sum, missing: (total ?? 0) - sum },
      });
    }

    // Insert alerts (skip dup unresolved ones for same check + type)
    let inserted = 0;
    for (const a of alerts) {
      if (a.check_intake_item_id) {
        const { count } = await admin
          .from("check_reconciliation_alerts")
          .select("id", { count: "exact", head: true })
          .eq("check_intake_item_id", a.check_intake_item_id)
          .eq("alert_type", a.alert_type)
          .eq("resolved", false);
        if ((count ?? 0) > 0) continue;
      }
      await admin.from("check_reconciliation_alerts").insert(a);
      inserted++;
    }

    return new Response(
      JSON.stringify({
        ok: true,
        total_checked: total,
        alerts_found: alerts.length,
        alerts_inserted: inserted,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    console.error("check-reconciliation error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
