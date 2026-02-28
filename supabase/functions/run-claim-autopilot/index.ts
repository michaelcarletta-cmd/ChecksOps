import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

interface NextAction {
  type: string;
  summary: string;
  due_at: string | null;
  draft_id: string | null;
  why: string;
  priority: number; // higher = more urgent
  bullets: string[];
}

interface PaymentSnapshot {
  claimed: number;
  paid: number;
  rd_available: number;
  gap: number;
}

interface MasterState {
  phase: string;
  health: "green" | "yellow" | "red";
  resistance: "low" | "med" | "high";
  next_action: NextAction;
  payment_snapshot: PaymentSnapshot;
  gap_analysis: any[];
  last_contact_at: string | null;
  last_payment_at: string | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response(null, { headers: corsHeaders });

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(url, serviceKey);

    const { claimId } = await req.json();
    if (!claimId) throw new Error("claimId required");

    // Fetch claim + related data in parallel
    const [claimRes, checksRes, emailsRes, filesRes, insightsRes, deadlinesRes] =
      await Promise.all([
        sb.from("claims").select("*, insurance_companies:insurance_company_id(name), loss_types:loss_type_id(name)").eq("id", claimId).single(),
        sb.from("claim_checks").select("*").eq("claim_id", claimId),
        sb.from("emails").select("id, direction, created_at, subject").eq("claim_id", claimId).order("created_at", { ascending: false }).limit(10),
        sb.from("claim_files").select("id, file_name, folder_key, created_at").eq("claim_id", claimId),
        sb.from("claim_strategic_insights").select("overall_health_score, evidence_gaps, recommended_next_moves, warnings, leverage_points").eq("claim_id", claimId).maybeSingle(),
        sb.from("claim_carrier_deadlines").select("*").eq("claim_id", claimId).eq("status", "pending").order("deadline_date", { ascending: true }).limit(5),
      ]);

    const claim = claimRes.data;
    if (!claim) throw new Error("Claim not found");

    const checks = checksRes.data || [];
    const emails = emailsRes.data || [];
    const files = filesRes.data || [];
    const insights = insightsRes.data;
    const deadlines = deadlinesRes.data || [];

    // ---- Compute Phase ----
    const phase = computePhase(claim, checks, files, emails);

    // ---- Compute Payment Snapshot ----
    const payment = computePayment(claim, checks);

    // ---- Compute Health ----
    const health = computeHealth(insights, claim, files, deadlines);

    // ---- Compute Resistance ----
    const resistance = computeResistance(claim, insights, emails);

    // ---- Compute Next Action ----
    const nextAction = computeNextAction(claim, phase, payment, deadlines, emails, files, insights);

    // ---- Compute Gap Analysis ----
    const gaps = insights?.evidence_gaps || [];

    // ---- Last contact / last payment ----
    const lastContactAt = emails.length > 0 ? emails[0].created_at : null;
    const lastPaymentAt = checks.length > 0
      ? checks.sort((a: any, b: any) => new Date(b.check_date).getTime() - new Date(a.check_date).getTime())[0].check_date
      : null;

    const masterState: MasterState = {
      phase,
      health,
      resistance,
      next_action: nextAction,
      payment_snapshot: payment,
      gap_analysis: gaps,
      last_contact_at: lastContactAt,
      last_payment_at: lastPaymentAt,
    };

    // Upsert
    const { error: upsertError } = await sb
      .from("claim_master_state")
      .upsert(
        { claim_id: claimId, state_json: masterState, updated_at: new Date().toISOString() },
        { onConflict: "claim_id" }
      );

    if (upsertError) throw upsertError;

    return new Response(JSON.stringify({ success: true, state: masterState }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("Autopilot error:", e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function computePhase(claim: any, checks: any[], files: any[], emails: any[]): string {
  if (claim.status === "Claim Settled" || claim.status === "Dead File" || claim.is_closed) return "Closeout";
  const hasCarrierDocs = files.some((f: any) => f.folder_key === "carrier");
  const hasEstimate = files.some((f: any) => f.folder_key === "estimates");
  const hasPaid = checks.length > 0;
  
  if (hasPaid) return "Payment";
  if (hasCarrierDocs && hasEstimate) return "Negotiation";
  if (files.length > 2) return "Documentation";
  return "Intake";
}

function computePayment(claim: any, checks: any[]): PaymentSnapshot {
  const claimed = claim.claim_amount || 0;
  const paid = checks.reduce((sum: number, c: any) => sum + (c.amount || 0), 0);
  const rdAvailable = claim.depreciation_amount || 0;
  return { claimed, paid, rd_available: rdAvailable, gap: Math.max(0, claimed - paid) };
}

function computeHealth(insights: any, claim: any, files: any[], deadlines: any[]): "green" | "yellow" | "red" {
  const score = insights?.overall_health_score;
  if (score !== null && score !== undefined) {
    if (score >= 70) return "green";
    if (score >= 40) return "yellow";
    return "red";
  }
  // Heuristic fallback
  const overdueDeadlines = deadlines.filter((d: any) => new Date(d.deadline_date) < new Date());
  if (overdueDeadlines.length > 0) return "red";
  if (files.length < 3) return "yellow";
  return "green";
}

function computeResistance(claim: any, insights: any, emails: any[]): "low" | "med" | "high" {
  const warnings = insights?.warnings || [];
  const criticals = warnings.filter((w: any) => w.severity === "critical" || w.severity === "high").length;
  if (criticals >= 2) return "high";
  if (criticals >= 1 || claim.status === "Denied") return "med";
  return "low";
}

function computeNextAction(
  claim: any, phase: string, payment: PaymentSnapshot,
  deadlines: any[], emails: any[], files: any[], insights: any
): NextAction {
  const candidates: NextAction[] = [];

  // Overdue deadline = top priority
  const overdue = deadlines.filter((d: any) => new Date(d.deadline_date) < new Date());
  if (overdue.length > 0) {
    candidates.push({
      type: "deadline_overdue",
      summary: `Respond to overdue ${overdue[0].deadline_type} deadline`,
      due_at: overdue[0].deadline_date,
      draft_id: null,
      why: `Deadline was ${overdue[0].deadline_date} — carrier may use delay against you`,
      priority: 100,
      bullets: [
        `Deadline type: ${overdue[0].deadline_type}`,
        `Days overdue: ${Math.ceil((Date.now() - new Date(overdue[0].deadline_date).getTime()) / 86400000)}`,
        "File response immediately to preserve rights",
      ],
    });
  }

  // Upcoming deadline
  const upcoming = deadlines.filter((d: any) => {
    const days = (new Date(d.deadline_date).getTime() - Date.now()) / 86400000;
    return days > 0 && days <= 7;
  });
  if (upcoming.length > 0) {
    candidates.push({
      type: "deadline_upcoming",
      summary: `Prepare for ${upcoming[0].deadline_type} deadline`,
      due_at: upcoming[0].deadline_date,
      draft_id: null,
      why: `Due in ${Math.ceil((new Date(upcoming[0].deadline_date).getTime() - Date.now()) / 86400000)} days`,
      priority: 80,
      bullets: [
        `Deadline: ${upcoming[0].deadline_date}`,
        `Type: ${upcoming[0].deadline_type}`,
        "Review required documents and prepare submission",
      ],
    });
  }

  // No carrier response in 7+ days
  const lastCarrierEmail = emails.find((e: any) => e.direction === "inbound");
  if (lastCarrierEmail) {
    const daysSince = (Date.now() - new Date(lastCarrierEmail.created_at).getTime()) / 86400000;
    if (daysSince >= 7) {
      candidates.push({
        type: "follow_up_carrier",
        summary: "Send carrier follow-up — no response in 7+ days",
        due_at: new Date().toISOString(),
        draft_id: null,
        why: `Last carrier response was ${Math.floor(daysSince)} days ago`,
        priority: 70,
        bullets: [
          `Last carrier email: ${Math.floor(daysSince)} days ago`,
          "Reference previous correspondence",
          "Request status update and timeline",
        ],
      });
    }
  } else if (emails.length === 0 && phase !== "Intake") {
    candidates.push({
      type: "initial_contact",
      summary: "Send initial carrier contact letter",
      due_at: new Date().toISOString(),
      draft_id: null,
      why: "No correspondence on file yet",
      priority: 65,
      bullets: ["Draft initial contact letter", "Include claim number and policy details", "Request acknowledgment"],
    });
  }

  // Payment gap
  if (payment.gap > 0 && phase === "Payment") {
    candidates.push({
      type: "collect_payment",
      summary: `Outstanding balance: $${payment.gap.toLocaleString()}`,
      due_at: null,
      draft_id: null,
      why: `$${payment.paid.toLocaleString()} paid of $${payment.claimed.toLocaleString()} claimed`,
      priority: 50,
      bullets: [
        `Claimed: $${payment.claimed.toLocaleString()}`,
        `Paid: $${payment.paid.toLocaleString()}`,
        `Gap: $${payment.gap.toLocaleString()}`,
      ],
    });
  }

  // Missing documents (intake phase)
  if (phase === "Intake" && files.length < 3) {
    candidates.push({
      type: "gather_documents",
      summary: "Upload essential claim documents",
      due_at: null,
      draft_id: null,
      why: `Only ${files.length} documents on file`,
      priority: 60,
      bullets: [
        "Upload policy declarations page",
        "Upload carrier estimate or denial letter",
        "Upload photos of damage",
      ],
    });
  }

  // Evidence gaps from insights
  const gaps = insights?.evidence_gaps || [];
  if (gaps.length > 0 && phase !== "Intake") {
    candidates.push({
      type: "address_gaps",
      summary: `Address ${gaps.length} evidence gap${gaps.length > 1 ? "s" : ""}`,
      due_at: null,
      draft_id: null,
      why: "Darwin identified missing evidence that weakens your position",
      priority: 55,
      bullets: gaps.slice(0, 3).map((g: any) => typeof g === "string" ? g : g.description || g.item || "Missing evidence"),
    });
  }

  // Sort by priority descending, pick top
  candidates.sort((a, b) => b.priority - a.priority);
  
  return candidates[0] || {
    type: "review",
    summary: "Review claim status — no urgent actions",
    due_at: null,
    draft_id: null,
    why: "Claim appears up to date",
    priority: 0,
    bullets: ["All deadlines met", "No outstanding gaps detected", "Monitor for carrier response"],
  };
}
