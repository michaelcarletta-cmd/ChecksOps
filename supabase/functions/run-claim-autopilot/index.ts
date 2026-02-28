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
  priority: number;
  confidence: "high" | "medium" | "low";
  bullets: string[];
  scores: {
    money_impact: number;
    deadline_risk: number;
    aging: number;
    resistance: number;
  };
}

interface PaymentSnapshot {
  claimed: number;
  paid: number;
  rd_available: number;
  gap: number;
  pct_paid: number;
  gap_stale_days: number | null;
}

interface MasterState {
  phase: string;
  phase_label: string;
  health: "green" | "yellow" | "red";
  resistance: "low" | "med" | "high";
  next_action: NextAction;
  payment_snapshot: PaymentSnapshot;
  gap_analysis: any[];
  last_contact_at: string | null;
  last_payment_at: string | null;
  days_open: number;
  days_since_carrier: number | null;
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

    // ---- Derived metrics ----
    const daysOpen = Math.ceil((Date.now() - new Date(claim.created_at).getTime()) / 86400000);
    const lastCarrierEmail = emails.find((e: any) => e.direction === "inbound");
    const daysSinceCarrier = lastCarrierEmail
      ? Math.floor((Date.now() - new Date(lastCarrierEmail.created_at).getTime()) / 86400000)
      : null;
    const lastContactAt = emails.length > 0 ? emails[0].created_at : null;
    const lastPaymentAt = checks.length > 0
      ? checks.sort((a: any, b: any) => new Date(b.check_date).getTime() - new Date(a.check_date).getTime())[0].check_date
      : null;

    // ---- Payment Snapshot (smarter) ----
    const payment = computePayment(claim, checks, lastPaymentAt);

    // ---- Phase (smarter with payment awareness) ----
    const phase = computePhase(claim, checks, files, emails, payment);

    // ---- Health (risk-based, multi-factor) ----
    const health = computeHealth(insights, claim, files, deadlines, daysOpen, daysSinceCarrier, payment);

    // ---- Resistance ----
    const resistance = computeResistance(claim, insights, emails);

    // ---- Next Action (weighted scoring) ----
    const nextAction = computeNextAction(claim, phase, payment, deadlines, emails, files, insights, daysOpen, daysSinceCarrier, resistance);

    // ---- Gap Analysis (sorted by impact) ----
    const gaps = sortGaps(insights?.evidence_gaps || []);

    // ---- Phase label (contextual) ----
    const phaseLabel = buildPhaseLabel(phase, payment);

    const masterState: MasterState = {
      phase,
      phase_label: phaseLabel,
      health,
      resistance,
      next_action: nextAction,
      payment_snapshot: payment,
      gap_analysis: gaps,
      last_contact_at: lastContactAt,
      last_payment_at: lastPaymentAt,
      days_open: daysOpen,
      days_since_carrier: daysSinceCarrier,
    };

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

// ===================== PHASE =====================
function computePhase(claim: any, checks: any[], files: any[], emails: any[], payment: PaymentSnapshot): string {
  if (claim.status === "Claim Settled" || claim.status === "Dead File" || claim.is_closed) return "Closeout";
  // Auto-shift: if paid >= claimed, closeout
  if (payment.claimed > 0 && payment.paid >= payment.claimed) return "Closeout";
  const hasCarrierDocs = files.some((f: any) => f.folder_key === "carrier");
  const hasEstimate = files.some((f: any) => f.folder_key === "estimates");
  const hasPaid = checks.length > 0;
  // Paid > 80% and RD outstanding → Payment phase
  if (hasPaid && payment.pct_paid > 80) return "Payment";
  if (hasPaid) return "Payment";
  if (hasCarrierDocs && hasEstimate) return "Negotiation";
  if (files.length > 2) return "Documentation";
  return "Intake";
}

// ===================== PAYMENT =====================
function computePayment(claim: any, checks: any[], lastPaymentAt: string | null): PaymentSnapshot {
  const claimed = claim.claim_amount || 0;
  const paid = checks.reduce((sum: number, c: any) => sum + (c.amount || 0), 0);
  const rdAvailable = claim.depreciation_amount || 0;
  const gap = Math.max(0, claimed - paid);
  const pctPaid = claimed > 0 ? Math.round((paid / claimed) * 100) : 0;
  // Days since gap has been unchanged (approximated by last payment)
  const gapStaleDays = lastPaymentAt
    ? Math.floor((Date.now() - new Date(lastPaymentAt).getTime()) / 86400000)
    : null;
  return { claimed, paid, rd_available: rdAvailable, gap, pct_paid: pctPaid, gap_stale_days: gapStaleDays };
}

// ===================== HEALTH (risk-based) =====================
function computeHealth(
  insights: any, claim: any, files: any[], deadlines: any[],
  daysOpen: number, daysSinceCarrier: number | null, payment: PaymentSnapshot
): "green" | "yellow" | "red" {
  let riskScore = 0; // 0-100

  // Factor 1: Aging
  if (daysOpen > 60) riskScore += 30;
  else if (daysOpen > 30) riskScore += 20;
  else if (daysOpen > 14) riskScore += 10;

  // Factor 2: Carrier silence
  if (daysSinceCarrier !== null) {
    if (daysSinceCarrier > 21) riskScore += 25;
    else if (daysSinceCarrier > 14) riskScore += 15;
    else if (daysSinceCarrier > 7) riskScore += 8;
  }

  // Factor 3: Overdue deadlines
  const overdueCount = deadlines.filter((d: any) => new Date(d.deadline_date) < new Date()).length;
  riskScore += Math.min(overdueCount * 15, 30);

  // Factor 4: Large unresolved gap
  if (payment.claimed > 0) {
    const gapPct = payment.gap / payment.claimed;
    if (gapPct > 0.5) riskScore += 15;
    else if (gapPct > 0.2) riskScore += 8;
  }

  // Factor 5: Gap stale (no payment movement in 21+ days)
  if (payment.gap > 0 && payment.gap_stale_days !== null && payment.gap_stale_days > 21) {
    riskScore += 10;
  }

  // Factor 6: Few documents
  if (files.length < 3) riskScore += 5;

  // Factor 7: Strategic insights health score override
  const insightScore = insights?.overall_health_score;
  if (insightScore !== null && insightScore !== undefined) {
    if (insightScore < 40) riskScore += 15;
    else if (insightScore < 70) riskScore += 5;
  }

  // Factor 8: Denial status
  if (claim.status === "Denied") riskScore += 15;

  // Thresholds
  if (riskScore >= 40) return "red";
  if (riskScore >= 20) return "yellow";
  return "green";
}

// ===================== RESISTANCE =====================
function computeResistance(claim: any, insights: any, emails: any[]): "low" | "med" | "high" {
  const warnings = insights?.warnings || [];
  const criticals = warnings.filter((w: any) => w.severity === "critical" || w.severity === "high").length;
  if (criticals >= 2) return "high";
  if (criticals >= 1 || claim.status === "Denied") return "med";
  return "low";
}

// ===================== NEXT ACTION (weighted scoring) =====================
function computeNextAction(
  claim: any, phase: string, payment: PaymentSnapshot,
  deadlines: any[], emails: any[], files: any[], insights: any,
  daysOpen: number, daysSinceCarrier: number | null, resistance: "low" | "med" | "high"
): NextAction {
  const candidates: NextAction[] = [];
  const resistanceWeight = resistance === "high" ? 20 : resistance === "med" ? 10 : 0;

  // ---- Overdue deadline ----
  const overdue = deadlines.filter((d: any) => new Date(d.deadline_date) < new Date());
  if (overdue.length > 0) {
    const daysOverdue = Math.ceil((Date.now() - new Date(overdue[0].deadline_date).getTime()) / 86400000);
    const scores = {
      money_impact: payment.gap > 10000 ? 30 : payment.gap > 5000 ? 20 : 10,
      deadline_risk: Math.min(50, 30 + daysOverdue * 2),
      aging: Math.min(20, Math.floor(daysOpen / 5)),
      resistance: resistanceWeight,
    };
    candidates.push({
      type: "deadline_overdue",
      summary: `Respond to Overdue ${overdue[0].deadline_type} – ${daysOverdue}d Late`,
      due_at: overdue[0].deadline_date,
      draft_id: null,
      why: `Statutory deadline passed ${daysOverdue} days ago — carrier may use delay against you`,
      confidence: "high",
      priority: scores.money_impact + scores.deadline_risk + scores.aging + scores.resistance,
      bullets: [
        `Deadline type: ${overdue[0].deadline_type}`,
        `${daysOverdue} days overdue`,
        "File response immediately to preserve rights",
      ],
      scores,
    });
  }

  // ---- Upcoming deadline ----
  const upcoming = deadlines.filter((d: any) => {
    const days = (new Date(d.deadline_date).getTime() - Date.now()) / 86400000;
    return days > 0 && days <= 7;
  });
  if (upcoming.length > 0) {
    const daysUntil = Math.ceil((new Date(upcoming[0].deadline_date).getTime() - Date.now()) / 86400000);
    const scores = {
      money_impact: payment.gap > 10000 ? 20 : 10,
      deadline_risk: Math.max(15, 40 - daysUntil * 5),
      aging: Math.min(15, Math.floor(daysOpen / 7)),
      resistance: resistanceWeight,
    };
    candidates.push({
      type: "deadline_upcoming",
      summary: `${upcoming[0].deadline_type} Deadline – ${daysUntil}d Remaining`,
      due_at: upcoming[0].deadline_date,
      draft_id: null,
      why: `Due in ${daysUntil} days — prepare submission now`,
      confidence: "high",
      priority: scores.money_impact + scores.deadline_risk + scores.aging + scores.resistance,
      bullets: [
        `Deadline: ${upcoming[0].deadline_date}`,
        `Type: ${upcoming[0].deadline_type}`,
        "Review required documents and prepare submission",
      ],
      scores,
    });
  }

  // ---- Carrier silence follow-up ----
  if (daysSinceCarrier !== null && daysSinceCarrier >= 7) {
    const scores = {
      money_impact: payment.gap > 20000 ? 30 : payment.gap > 5000 ? 15 : 5,
      deadline_risk: 5,
      aging: Math.min(30, daysSinceCarrier),
      resistance: resistanceWeight,
    };
    candidates.push({
      type: "follow_up_carrier",
      summary: `Demand Response – ${daysSinceCarrier} Days Silent`,
      due_at: new Date().toISOString(),
      draft_id: null,
      why: `No carrier response in ${daysSinceCarrier} days`,
      confidence: daysSinceCarrier > 14 ? "high" : "medium",
      priority: scores.money_impact + scores.deadline_risk + scores.aging + scores.resistance,
      bullets: [
        `Last carrier email: ${daysSinceCarrier} days ago`,
        "Reference previous correspondence",
        "Request status update and timeline",
      ],
      scores,
    });
  } else if (emails.length === 0 && phase !== "Intake") {
    const scores = {
      money_impact: 5,
      deadline_risk: 5,
      aging: Math.min(20, Math.floor(daysOpen / 3)),
      resistance: 0,
    };
    candidates.push({
      type: "initial_contact",
      summary: "Send Initial Carrier Contact",
      due_at: new Date().toISOString(),
      draft_id: null,
      why: "No correspondence on file yet",
      confidence: "medium",
      priority: scores.money_impact + scores.deadline_risk + scores.aging + scores.resistance,
      bullets: ["Draft initial contact letter", "Include claim number and policy details", "Request acknowledgment"],
      scores,
    });
  }

  // ---- Payment gap (money-dominant scoring) ----
  if (payment.gap > 0 && phase === "Payment") {
    const moneyImpact = payment.gap > 40000 ? 40 : payment.gap > 20000 ? 30 : payment.gap > 10000 ? 20 : 10;
    const staleBonus = (payment.gap_stale_days ?? 0) > 21 ? 15 : (payment.gap_stale_days ?? 0) > 14 ? 8 : 0;
    const scores = {
      money_impact: moneyImpact,
      deadline_risk: 0,
      aging: staleBonus,
      resistance: resistanceWeight,
    };
    candidates.push({
      type: "collect_payment",
      summary: `$${payment.gap.toLocaleString()} Outstanding – ${payment.gap_stale_days ?? 0}d Stale`,
      due_at: null,
      draft_id: null,
      why: `$${payment.paid.toLocaleString()} paid of $${payment.claimed.toLocaleString()} claimed`,
      confidence: "high",
      priority: scores.money_impact + scores.deadline_risk + scores.aging + scores.resistance,
      bullets: [
        `Claimed: $${payment.claimed.toLocaleString()}`,
        `Paid: $${payment.paid.toLocaleString()}`,
        `Gap: $${payment.gap.toLocaleString()}`,
      ],
      scores,
    });
  }

  // ---- Missing documents ----
  if (phase === "Intake" && files.length < 3) {
    const scores = {
      money_impact: 5,
      deadline_risk: 5,
      aging: Math.min(10, Math.floor(daysOpen / 3)),
      resistance: 0,
    };
    candidates.push({
      type: "gather_documents",
      summary: "Upload Essential Claim Documents",
      due_at: null,
      draft_id: null,
      why: `Only ${files.length} documents on file`,
      confidence: "medium",
      priority: scores.money_impact + scores.deadline_risk + scores.aging + scores.resistance,
      bullets: [
        "Upload policy declarations page",
        "Upload carrier estimate or denial letter",
        "Upload photos of damage",
      ],
      scores,
    });
  }

  // ---- Evidence gaps ----
  const gaps = insights?.evidence_gaps || [];
  if (gaps.length > 0 && phase !== "Intake") {
    const scores = {
      money_impact: gaps.length > 3 ? 15 : 8,
      deadline_risk: 3,
      aging: Math.min(10, Math.floor(daysOpen / 7)),
      resistance: resistanceWeight,
    };
    candidates.push({
      type: "address_gaps",
      summary: `Address ${gaps.length} Evidence Gap${gaps.length > 1 ? "s" : ""} – Weakens Position`,
      due_at: null,
      draft_id: null,
      why: "Missing evidence identified by Darwin weakens your negotiating position",
      confidence: "medium",
      priority: scores.money_impact + scores.deadline_risk + scores.aging + scores.resistance,
      bullets: gaps.slice(0, 3).map((g: any) => typeof g === "string" ? g : g.description || g.item || "Missing evidence"),
      scores,
    });
  }

  // Sort by weighted priority, pick top
  candidates.sort((a, b) => b.priority - a.priority);

  return candidates[0] || {
    type: "review",
    summary: "Claim Current – No Urgent Actions",
    due_at: null,
    draft_id: null,
    why: "All deadlines met, no outstanding gaps detected",
    confidence: "low" as const,
    priority: 0,
    bullets: ["All deadlines met", "No outstanding gaps detected", "Monitor for carrier response"],
    scores: { money_impact: 0, deadline_risk: 0, aging: 0, resistance: 0 },
  };
}

// ===================== GAP SORTING =====================
function sortGaps(gaps: any[]): any[] {
  if (!Array.isArray(gaps)) return [];
  return gaps.map((g: any) => {
    if (typeof g === "string") return { description: g, money_impact: 0, legal_strength: 0, evidence_completeness: 0 };
    return {
      description: g.description || g.item || JSON.stringify(g),
      money_impact: g.money_impact ?? g.impact ?? 0,
      legal_strength: g.legal_strength ?? g.statutory_support ?? 0,
      evidence_completeness: g.evidence_completeness ?? 0,
      ...g,
    };
  }).sort((a: any, b: any) => {
    // Sort by money impact desc, then legal strength desc
    const aScore = (a.money_impact || 0) * 3 + (a.legal_strength || 0) * 2 + (a.evidence_completeness || 0);
    const bScore = (b.money_impact || 0) * 3 + (b.legal_strength || 0) * 2 + (b.evidence_completeness || 0);
    return bScore - aScore;
  });
}

// ===================== PHASE LABEL =====================
function buildPhaseLabel(phase: string, payment: PaymentSnapshot): string {
  if (phase === "Closeout") return "Closeout";
  if (phase === "Payment" && payment.gap > 0) return `Payment – $${payment.gap.toLocaleString()} Outstanding`;
  if (phase === "Negotiation" && payment.gap > 0) return `Negotiation – $${payment.gap.toLocaleString()} Outstanding`;
  if (phase === "Negotiation") return "Negotiation";
  if (phase === "Documentation") return "Documentation";
  return "Intake";
}
