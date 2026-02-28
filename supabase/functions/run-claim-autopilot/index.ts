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
  tone: "firm" | "standard" | "soft";
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
  payment_velocity: number;
}

interface StabilityIndex {
  score: number;
  payment_velocity: number;
  carrier_response_consistency: number;
  unresolved_gap_ratio: number;
  deadline_pressure: number;
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
  stability_index: StabilityIndex;
}

// ===================== BASELINE PRIORITY WEIGHTS (frozen quarterly) =====================
const BASELINE_PRIORITY_WEIGHTS: Record<string, number> = {
  escalation_recommended: 85,
  deadline_overdue: 90,
  deadline_upcoming: 60,
  supplement_48h: 70,
  follow_up_14d: 55,
  follow_up_carrier: 55,
  initial_contact: 30,
  collect_payment: 65,
  gather_documents: 20,
  address_gaps: 30,
  review: 0,
};

// Penalty floor: never reduce below 60% of baseline
const PENALTY_FLOOR_PCT = 0.6;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response(null, { headers: corsHeaders });

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(url, serviceKey);

    const { claimId } = await req.json();
    if (!claimId) throw new Error("claimId required");

    const [claimRes, checksRes, emailsRes, filesRes, insightsRes, deadlinesRes, feedbackRes, prevStateRes] =
      await Promise.all([
        sb.from("claims").select("*, insurance_companies:insurance_company_id(name), loss_types:loss_type_id(name)").eq("id", claimId).single(),
        sb.from("claim_checks").select("*").eq("claim_id", claimId),
        sb.from("emails").select("id, direction, created_at, subject").eq("claim_id", claimId).order("created_at", { ascending: false }).limit(20),
        sb.from("claim_files").select("id, file_name, folder_key, created_at").eq("claim_id", claimId),
        sb.from("claim_strategic_insights").select("overall_health_score, evidence_gaps, recommended_next_moves, warnings, leverage_points").eq("claim_id", claimId).maybeSingle(),
        sb.from("claim_carrier_deadlines").select("*").eq("claim_id", claimId).eq("status", "pending").order("deadline_date", { ascending: true }).limit(5),
        sb.from("autopilot_action_feedback").select("action_type, confidence, user_action, resistance_at_action, gap_pct_at_action, phase_at_action").eq("claim_id", claimId).order("created_at", { ascending: false }).limit(100),
        sb.from("claim_master_state").select("state_json").eq("claim_id", claimId).maybeSingle(),
      ]);

    // Fetch carrier behavior profile for carrier-specific strategy
    const carrierName = claimRes.data?.insurance_companies?.name || claimRes.data?.insurance_company || null;
    let carrierProfile: any = null;
    if (carrierName) {
      const { data: cp } = await sb.from("carrier_behavior_profiles")
        .select("recommended_approach, preferred_communication, avg_initial_response_days, avg_supplement_response_days, supplement_approval_rate")
        .eq("carrier_name", carrierName).maybeSingle();
      carrierProfile = cp;
    }

    const claim = claimRes.data;
    if (!claim) throw new Error("Claim not found");

    const checks = checksRes.data || [];
    const emails = emailsRes.data || [];
    const files = filesRes.data || [];
    const insights = insightsRes.data;
    const deadlines = deadlinesRes.data || [];
    const feedback = feedbackRes.data || [];
    const prevState = prevStateRes.data?.state_json as MasterState | null;

    // ---- Derived metrics ----
    const daysOpen = Math.max(1, Math.ceil((Date.now() - new Date(claim.created_at).getTime()) / 86400000));
    const lastCarrierEmail = emails.find((e: any) => e.direction === "inbound");
    const daysSinceCarrier = lastCarrierEmail
      ? Math.floor((Date.now() - new Date(lastCarrierEmail.created_at).getTime()) / 86400000)
      : null;
    const lastContactAt = emails.length > 0 ? emails[0].created_at : null;
    const lastPaymentAt = checks.length > 0
      ? checks.sort((a: any, b: any) => new Date(b.check_date).getTime() - new Date(a.check_date).getTime())[0].check_date
      : null;

    // ---- Payment Snapshot ----
    const payment = computePayment(claim, checks, lastPaymentAt, daysOpen);

    // ---- Contextual confidence adjustments ----
    const resistance = computeResistance(claim, insights, emails, checks, daysSinceCarrier, prevState);
    const gapPct = payment.claimed > 0 ? Math.round((payment.gap / payment.claimed) * 100) : 0;
    const confidenceAdjustments = computeContextualConfidenceAdjustments(feedback, resistance, gapPct);

    // ---- Phase ----
    const phase = computePhase(claim, checks, files, emails, payment);

    // ---- Health (conservative) ----
    const health = computeHealth(insights, claim, files, deadlines, daysOpen, daysSinceCarrier, payment);

    // ---- Stability Index ----
    const stability = computeStabilityIndex(payment, emails, deadlines, daysOpen, daysSinceCarrier);

    // ---- Next Action (with escalation governance + penalty floor) ----
    const nextAction = computeNextAction(claim, phase, payment, deadlines, emails, files, insights, daysOpen, daysSinceCarrier, resistance, confidenceAdjustments, stability, carrierProfile);

    // ---- Gap Analysis ----
    const gaps = sortGaps(insights?.evidence_gaps || []);

    // ---- Phase label ----
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
      stability_index: stability,
    };

    // ---- Persist state ----
    const { error: upsertError } = await sb
      .from("claim_master_state")
      .upsert(
        { claim_id: claimId, state_json: masterState, updated_at: new Date().toISOString() },
        { onConflict: "claim_id" }
      );
    if (upsertError) throw upsertError;

    // ---- Background: Money integrity + drift + strategy tracking + quarterly snapshot + performance attribution + cash flow (fire and forget) ----
    runMoneyIntegrityCheck(sb, claimId, payment, prevState?.payment_snapshot).catch(console.error);
    updateDriftAnalytics(sb, feedback).catch(console.error);
    trackStrategyExecution(sb, claimId, nextAction, payment, resistance).catch(console.error);
    maybeCreateQuarterlySnapshot(sb, confidenceAdjustments).catch(console.error);
    updatePerformanceAttribution(sb, claimId, claim, payment, resistance, nextAction, daysOpen).catch(console.error);
    updateCashFlowForecast(sb).catch(console.error);

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

// ===================== CONTEXTUAL CONFIDENCE SELF-TUNING =====================
function computeContextualConfidenceAdjustments(
  feedback: any[], currentResistance: string, currentGapPct: number
): Record<string, number> {
  const adjustments: Record<string, number> = {};
  
  const contextKey = (f: any) => {
    const r = f.resistance_at_action || "unknown";
    const g = f.gap_pct_at_action != null ? (f.gap_pct_at_action > 50 ? "high_gap" : f.gap_pct_at_action > 20 ? "med_gap" : "low_gap") : "unknown_gap";
    return `${f.action_type}|${r}|${g}`;
  };

  const currentGapBucket = currentGapPct > 50 ? "high_gap" : currentGapPct > 20 ? "med_gap" : "low_gap";
  
  const byContext: Record<string, { done: number; negative: number; total: number }> = {};
  for (const f of feedback) {
    const key = contextKey(f);
    if (!byContext[key]) byContext[key] = { done: 0, negative: 0, total: 0 };
    byContext[key].total++;
    if (f.user_action === "done") byContext[key].done++;
    else byContext[key].negative++;
  }

  for (const [key, counts] of Object.entries(byContext)) {
    if (counts.total < 3) continue;
    const [actionType, resistance, gapBucket] = key.split("|");
    
    if (resistance !== currentResistance && resistance !== "unknown") continue;
    if (gapBucket !== currentGapBucket && gapBucket !== "unknown_gap") continue;

    const negativeRate = counts.negative / counts.total;
    if (negativeRate > 0.6) adjustments[actionType] = Math.min(adjustments[actionType] ?? 0, -15);
    else if (negativeRate > 0.4) adjustments[actionType] = Math.min(adjustments[actionType] ?? 0, -8);
    else if (counts.done / counts.total > 0.8) adjustments[actionType] = Math.max(adjustments[actionType] ?? 0, 5);
  }

  const globalByType: Record<string, { done: number; negative: number; total: number }> = {};
  for (const f of feedback) {
    if (!globalByType[f.action_type]) globalByType[f.action_type] = { done: 0, negative: 0, total: 0 };
    globalByType[f.action_type].total++;
    if (f.user_action === "done") globalByType[f.action_type].done++;
    else globalByType[f.action_type].negative++;
  }
  for (const [type, counts] of Object.entries(globalByType)) {
    if (counts.total < 5 || adjustments[type] !== undefined) continue;
    const negativeRate = counts.negative / counts.total;
    if (negativeRate > 0.6) adjustments[type] = -10;
    else if (negativeRate > 0.4) adjustments[type] = -5;
  }

  return adjustments;
}

// ===================== PHASE =====================
function computePhase(claim: any, checks: any[], files: any[], _emails: any[], payment: PaymentSnapshot): string {
  if (claim.status === "Claim Settled" || claim.status === "Dead File" || claim.is_closed) return "Closeout";
  if (payment.claimed > 0 && payment.paid >= payment.claimed) return "Closeout";
  const hasCarrierDocs = files.some((f: any) => f.folder_key === "carrier");
  const hasEstimate = files.some((f: any) => f.folder_key === "estimates");
  const hasPaid = checks.length > 0;
  if (hasPaid && payment.pct_paid > 80) return "Payment";
  if (hasPaid) return "Payment";
  if (hasCarrierDocs && hasEstimate) return "Negotiation";
  if (files.length > 2) return "Documentation";
  return "Intake";
}

// ===================== PAYMENT =====================
function computePayment(claim: any, checks: any[], lastPaymentAt: string | null, daysOpen: number): PaymentSnapshot {
  const claimed = claim.claim_amount || 0;
  const paid = checks.reduce((sum: number, c: any) => sum + (c.amount || 0), 0);
  const rdAvailable = claim.rd_amount || 0;
  const gap = Math.max(0, claimed - paid);
  const pctPaid = claimed > 0 ? Math.round((paid / claimed) * 100) : 0;
  const gapStaleDays = lastPaymentAt
    ? Math.floor((Date.now() - new Date(lastPaymentAt).getTime()) / 86400000)
    : null;
  const paymentVelocity = daysOpen > 0 ? Math.round((paid / daysOpen) * 100) / 100 : 0;
  return { claimed, paid, rd_available: rdAvailable, gap, pct_paid: pctPaid, gap_stale_days: gapStaleDays, payment_velocity: paymentVelocity };
}

// ===================== STABILITY INDEX =====================
function computeStabilityIndex(payment: PaymentSnapshot, emails: any[], deadlines: any[], _daysOpen: number, daysSinceCarrier: number | null): StabilityIndex {
  const maxExpectedVelocity = payment.claimed > 0 ? payment.claimed / 30 : 100;
  const velocityScore = Math.min(25, payment.payment_velocity > 0 ? (payment.payment_velocity / maxExpectedVelocity) * 25 : 0);

  const inboundEmails = emails.filter((e: any) => e.direction === "inbound");
  let responseConsistency = 0;
  if (inboundEmails.length >= 3) responseConsistency = 25;
  else if (inboundEmails.length >= 1 && daysSinceCarrier !== null && daysSinceCarrier < 14) responseConsistency = 18;
  else if (inboundEmails.length >= 1) responseConsistency = 10;

  const gapRatio = payment.claimed > 0 ? payment.gap / payment.claimed : 0;
  const gapPenalty = Math.min(25, gapRatio * 30);

  const overdueCount = deadlines.filter((d: any) => new Date(d.deadline_date) < new Date()).length;
  const upcomingCount = deadlines.filter((d: any) => {
    const daysUntil = (new Date(d.deadline_date).getTime() - Date.now()) / 86400000;
    return daysUntil > 0 && daysUntil <= 7;
  }).length;
  const deadlinePressure = Math.min(25, overdueCount * 15 + upcomingCount * 5);

  const score = Math.round(Math.max(0, Math.min(100, velocityScore + responseConsistency - gapPenalty - deadlinePressure)));
  return { score, payment_velocity: velocityScore, carrier_response_consistency: responseConsistency, unresolved_gap_ratio: gapPenalty, deadline_pressure: deadlinePressure };
}

// ===================== HEALTH (conservative – red = real danger) =====================
function computeHealth(
  insights: any, claim: any, files: any[], deadlines: any[],
  daysOpen: number, daysSinceCarrier: number | null, payment: PaymentSnapshot
): "green" | "yellow" | "red" {
  let riskScore = 0;

  if (daysOpen > 90) riskScore += 25;
  else if (daysOpen > 60) riskScore += 18;
  else if (daysOpen > 30) riskScore += 10;
  else if (daysOpen > 14) riskScore += 4;

  if (daysSinceCarrier !== null) {
    if (daysSinceCarrier > 30) riskScore += 22;
    else if (daysSinceCarrier > 21) riskScore += 15;
    else if (daysSinceCarrier > 14) riskScore += 8;
    else if (daysSinceCarrier > 7) riskScore += 3;
  }

  const overdueCount = deadlines.filter((d: any) => new Date(d.deadline_date) < new Date()).length;
  riskScore += Math.min(overdueCount * 12, 25);

  if (payment.claimed > 0) {
    const gapPct = payment.gap / payment.claimed;
    if (gapPct > 0.6) riskScore += 12;
    else if (gapPct > 0.3) riskScore += 6;
  }

  if (payment.payment_velocity === 0 && payment.gap > 0 && daysOpen > 14) riskScore += 8;
  else if (payment.gap > 0 && payment.gap_stale_days !== null && payment.gap_stale_days > 30) riskScore += 10;

  if (files.length < 3 && daysOpen > 7) riskScore += 3;

  const insightScore = insights?.overall_health_score;
  if (insightScore !== null && insightScore !== undefined) {
    if (insightScore < 30) riskScore += 12;
    else if (insightScore < 50) riskScore += 5;
  }

  if (claim.status === "Denied") riskScore += 12;

  if (riskScore >= 50) return "red";
  if (riskScore >= 25) return "yellow";
  return "green";
}

// ===================== RESISTANCE (with decay) =====================
function computeResistance(
  claim: any, insights: any, emails: any[], checks: any[],
  daysSinceCarrier: number | null, prevState: MasterState | null
): "low" | "med" | "high" {
  let score = 0;

  const warnings = insights?.warnings || [];
  const criticals = warnings.filter((w: any) => w.severity === "critical" || w.severity === "high").length;

  if (claim.status === "Denied") score += 25;
  if (criticals >= 2) score += 25;
  else if (criticals >= 1) score += 15;

  const hasEngineer = warnings.some((w: any) =>
    (w.title || w.message || "").toLowerCase().includes("engineer")
  );
  if (hasEngineer) score += 15;

  if (daysSinceCarrier !== null && daysSinceCarrier > 21) score += 15;

  const partialPayments = checks.filter((c: any) => c.check_type !== "final");
  if (partialPayments.length >= 2 && claim.status !== "Claim Settled") score += 10;

  if (checks.length > 0) {
    const mostRecent = checks.sort((a: any, b: any) => new Date(b.check_date).getTime() - new Date(a.check_date).getTime())[0];
    const daysSincePayment = Math.floor((Date.now() - new Date(mostRecent.check_date).getTime()) / 86400000);
    if (daysSincePayment < 14) score -= 10;
  }

  if (daysSinceCarrier !== null && daysSinceCarrier < 7) score -= 10;

  if (prevState?.payment_snapshot) {
    const prevGap = prevState.payment_snapshot.gap;
    const claimed = claim.claim_amount || 0;
    if (prevGap > 0 && claimed > 0) {
      const gapDecrease = (prevGap - Math.max(0, claimed - checks.reduce((s: number, c: any) => s + (c.amount || 0), 0))) / prevGap;
      if (gapDecrease >= 0.15) score -= 15;
    }
  }

  score = Math.max(0, Math.min(100, score));
  if (score >= 60) return "high";
  if (score >= 30) return "med";
  return "low";
}

// ===================== TONE =====================
function computeTone(resistance: "low" | "med" | "high"): "firm" | "standard" | "soft" {
  if (resistance === "high") return "firm";
  if (resistance === "low") return "soft";
  return "standard";
}

// ===================== NEXT ACTION (with escalation governance + penalty floor + carrier strategy) =====================
function computeNextAction(
  claim: any, phase: string, payment: PaymentSnapshot,
  deadlines: any[], emails: any[], files: any[], insights: any,
  daysOpen: number, daysSinceCarrier: number | null, resistance: "low" | "med" | "high",
  confidenceAdjustments: Record<string, number>, stability: StabilityIndex,
  carrierProfile?: any
): NextAction {
  const candidates: NextAction[] = [];
  const resistanceWeight = resistance === "high" ? 20 : resistance === "med" ? 10 : 0;
  // Carrier-specific tone override: if carrier profile recommends aggressive approach, bias firm
  let tone = computeTone(resistance);
  if (carrierProfile?.recommended_approach) {
    const approach = carrierProfile.recommended_approach.toLowerCase();
    if (approach.includes("aggressive") || approach.includes("firm")) tone = "firm";
    else if (approach.includes("collaborative") || approach.includes("soft")) tone = resistance === "high" ? "standard" : "soft";
  }
  const gapPct = payment.claimed > 0 ? payment.gap / payment.claimed : 0;
  const outboundFollowUps = emails.filter((e: any) => e.direction === "outbound").length;

  // ---- SPEED RULE: Supplement within 48h of estimate upload ----
  const hasEstimate = files.some((f: any) => f.folder_key === "estimates");
  const hasSupplementEmail = emails.some((e: any) => 
    e.direction === "outbound" && (e.subject || "").toLowerCase().includes("supplement")
  );
  if (hasEstimate && !hasSupplementEmail && phase !== "Intake" && phase !== "Closeout") {
    const estimateFiles = files.filter((f: any) => f.folder_key === "estimates")
      .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const latestEstimate = estimateFiles[0];
    if (latestEstimate) {
      const hoursSinceEstimate = (Date.now() - new Date(latestEstimate.created_at).getTime()) / 3600000;
      if (hoursSinceEstimate <= 72) { // within 72h window (target 48h)
        const urgency = hoursSinceEstimate > 48 ? 15 : 10;
        const scores = {
          money_impact: payment.gap > 20000 ? 35 : payment.gap > 10000 ? 25 : 15,
          deadline_risk: urgency,
          aging: 5,
          resistance: resistanceWeight,
        };
        candidates.push({
          type: "supplement_48h",
          summary: `Send First Supplement – ${Math.round(hoursSinceEstimate)}h Since Estimate`,
          due_at: new Date(new Date(latestEstimate.created_at).getTime() + 48 * 3600000).toISOString(),
          draft_id: null,
          why: `Estimate uploaded ${Math.round(hoursSinceEstimate)}h ago. First supplement should go out within 48 hours to establish speed and credibility.`,
          confidence: "high",
          tone,
          priority: scores.money_impact + scores.deadline_risk + scores.aging + scores.resistance,
          bullets: [
            "Draft supplement referencing estimate discrepancies",
            "Include line-item comparison if carrier estimate available",
            hoursSinceEstimate > 48 ? "⚠️ Past 48h target — send immediately" : `${Math.round(48 - hoursSinceEstimate)}h remaining in speed window`,
            tone === "firm" ? "Cite policy language supporting additional scope" : "Present scope differences professionally",
          ],
          scores,
        });
      }
    }
  }

  // ---- SPEED RULE: 14-day follow-up cadence ----
  const lastOutbound = emails.find((e: any) => e.direction === "outbound");
  if (lastOutbound && daysSinceCarrier !== null && daysSinceCarrier >= 7) {
    const daysSinceLastOutbound = Math.floor((Date.now() - new Date(lastOutbound.created_at).getTime()) / 86400000);
    const followUpInterval = 14; // exact 14-day intervals
    if (daysSinceLastOutbound >= followUpInterval && phase !== "Closeout") {
      const intervalsMissed = Math.floor(daysSinceLastOutbound / followUpInterval);
      const scores = {
        money_impact: payment.gap > 20000 ? 25 : payment.gap > 5000 ? 15 : 5,
        deadline_risk: intervalsMissed > 1 ? 15 : 5,
        aging: Math.min(25, daysSinceLastOutbound),
        resistance: resistanceWeight,
      };
      candidates.push({
        type: "follow_up_14d",
        summary: `14-Day Follow-Up Due – ${daysSinceLastOutbound}d Since Last Contact`,
        due_at: new Date().toISOString(),
        draft_id: null,
        why: `${daysSinceLastOutbound} days since last outbound (${intervalsMissed} interval${intervalsMissed > 1 ? "s" : ""} elapsed). Consistent 14-day cadence establishes professional persistence.`,
        confidence: "high",
        tone,
        priority: scores.money_impact + scores.deadline_risk + scores.aging + scores.resistance,
        bullets: [
          `Last outbound: ${daysSinceLastOutbound} days ago`,
          `Follow-up intervals missed: ${intervalsMissed}`,
          "Reference previous correspondence and pending items",
          tone === "firm" ? "Include regulatory timeline reminder" : "Request written status update",
        ],
        scores,
      });
    }
  }

  // ---- Stale Strategy Detection (with escalation governance) ----
  if (gapPct > 0.2 && (payment.gap_stale_days ?? 0) > 30 && outboundFollowUps >= 2) {
    const stabilityBelowThreshold = stability.score < 40;
    const noPaymentMovement = (payment.gap_stale_days ?? 0) > 30;
    const hasFormalFollowUp = outboundFollowUps >= 1;
    
    if (stabilityBelowThreshold && noPaymentMovement && hasFormalFollowUp) {
      const scores = {
        money_impact: payment.gap > 20000 ? 40 : payment.gap > 10000 ? 30 : 20,
        deadline_risk: 10,
        aging: Math.min(25, Math.floor((payment.gap_stale_days ?? 0) / 3)),
        resistance: resistanceWeight,
      };
      candidates.push({
        type: "escalation_recommended",
        summary: `Strategy Stalled – Consider Escalation`,
        due_at: new Date().toISOString(),
        draft_id: null,
        why: `$${payment.gap.toLocaleString()} gap unchanged for ${payment.gap_stale_days}+ days despite ${outboundFollowUps} follow-ups. Stability index: ${stability.score}/100`,
        confidence: "high",
        tone,
        priority: scores.money_impact + scores.deadline_risk + scores.aging + scores.resistance,
        bullets: [
          `Gap: $${payment.gap.toLocaleString()} (${Math.round(gapPct * 100)}% unpaid)`,
          `${outboundFollowUps} follow-ups sent with no payment movement`,
          tone === "firm" ? "Consider appraisal demand or DOI complaint" : "Evaluate appraisal, supervisor review, or formal complaint",
          `Claim stability: ${stability.score}/100`,
        ],
        scores,
      });
    }
  }

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
      tone,
      priority: scores.money_impact + scores.deadline_risk + scores.aging + scores.resistance,
      bullets: [
        `Deadline type: ${overdue[0].deadline_type}`,
        `${daysOverdue} days overdue`,
        tone === "firm" ? "File response immediately — cite regulatory obligation" : "File response to preserve rights",
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
      tone,
      priority: scores.money_impact + scores.deadline_risk + scores.aging + scores.resistance,
      bullets: [`Deadline: ${upcoming[0].deadline_date}`, `Type: ${upcoming[0].deadline_type}`, "Review required documents and prepare submission"],
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
    const silenceBullets = [`Last carrier communication: ${daysSinceCarrier} days ago`, "Reference previous correspondence"];
    if (tone === "firm") {
      silenceBullets.push("Include regulatory timeline citations");
      silenceBullets.push("Request written response within 10 business days");
    } else {
      silenceBullets.push("Request status update and timeline");
    }
    candidates.push({
      type: "follow_up_carrier",
      summary: `Demand Response – ${daysSinceCarrier} Days Silent`,
      due_at: new Date().toISOString(),
      draft_id: null,
      why: `No carrier response in ${daysSinceCarrier} days`,
      confidence: daysSinceCarrier > 14 ? "high" : "medium",
      tone,
      priority: scores.money_impact + scores.deadline_risk + scores.aging + scores.resistance,
      bullets: silenceBullets,
      scores,
    });
  } else if (emails.length === 0 && phase !== "Intake") {
    const scores = { money_impact: 5, deadline_risk: 5, aging: Math.min(20, Math.floor(daysOpen / 3)), resistance: 0 };
    candidates.push({
      type: "initial_contact",
      summary: "Send Initial Carrier Contact",
      due_at: new Date().toISOString(),
      draft_id: null,
      why: "No correspondence on file yet",
      confidence: "medium",
      tone: "standard",
      priority: scores.money_impact + scores.deadline_risk + scores.aging + scores.resistance,
      bullets: ["Draft initial contact letter", "Include claim number and policy details", "Request acknowledgment"],
      scores,
    });
  }

  // ---- Payment gap ----
  if (payment.gap > 0 && phase === "Payment") {
    const moneyImpact = payment.gap > 40000 ? 40 : payment.gap > 20000 ? 30 : payment.gap > 10000 ? 20 : 10;
    const staleBonus = (payment.gap_stale_days ?? 0) > 21 ? 15 : (payment.gap_stale_days ?? 0) > 14 ? 8 : 0;
    const velocityBonus = payment.payment_velocity < 50 && payment.gap > 10000 ? 10 : 0;
    const scores = { money_impact: moneyImpact, deadline_risk: 0, aging: staleBonus + velocityBonus, resistance: resistanceWeight };
    candidates.push({
      type: "collect_payment",
      summary: `$${payment.gap.toLocaleString()} Outstanding – ${payment.gap_stale_days ?? 0}d Stale`,
      due_at: null,
      draft_id: null,
      why: `$${payment.paid.toLocaleString()} paid of $${payment.claimed.toLocaleString()} claimed (velocity: $${payment.payment_velocity}/day)`,
      confidence: "high",
      tone,
      priority: scores.money_impact + scores.deadline_risk + scores.aging + scores.resistance,
      bullets: [
        `Claimed: $${payment.claimed.toLocaleString()}`,
        `Paid: $${payment.paid.toLocaleString()}`,
        `Gap: $${payment.gap.toLocaleString()}`,
        payment.payment_velocity < 50 ? "Payment velocity is low — consider escalation" : `Velocity: $${payment.payment_velocity}/day`,
      ],
      scores,
    });
  }

  // ---- Missing documents ----
  if (phase === "Intake" && files.length < 3) {
    const scores = { money_impact: 5, deadline_risk: 5, aging: Math.min(10, Math.floor(daysOpen / 3)), resistance: 0 };
    candidates.push({
      type: "gather_documents",
      summary: "Upload Essential Claim Documents",
      due_at: null,
      draft_id: null,
      why: `Only ${files.length} documents on file`,
      confidence: "medium",
      tone: "standard",
      priority: scores.money_impact + scores.deadline_risk + scores.aging + scores.resistance,
      bullets: ["Upload policy declarations page", "Upload carrier estimate or denial letter", "Upload photos of damage"],
      scores,
    });
  }

  // ---- Evidence gaps ----
  const evidenceGaps = insights?.evidence_gaps || [];
  if (evidenceGaps.length > 0 && phase !== "Intake") {
    const scores = { money_impact: evidenceGaps.length > 3 ? 15 : 8, deadline_risk: 3, aging: Math.min(10, Math.floor(daysOpen / 7)), resistance: resistanceWeight };
    candidates.push({
      type: "address_gaps",
      summary: `Address ${evidenceGaps.length} Evidence Gap${evidenceGaps.length > 1 ? "s" : ""} – Weakens Position`,
      due_at: null,
      draft_id: null,
      why: "Missing evidence weakens your negotiating position",
      confidence: "medium",
      tone: "standard",
      priority: scores.money_impact + scores.deadline_risk + scores.aging + scores.resistance,
      bullets: evidenceGaps.slice(0, 3).map((g: any) => typeof g === "string" ? g : g.description || g.item || "Missing evidence"),
      scores,
    });
  }

  // ---- Apply contextual confidence adjustments WITH PENALTY FLOOR ----
  for (const c of candidates) {
    const adj = confidenceAdjustments[c.type] || 0;
    const baseline = BASELINE_PRIORITY_WEIGHTS[c.type] ?? c.priority;
    const floor = Math.round(baseline * PENALTY_FLOOR_PCT);
    c.priority = Math.max(floor, c.priority + adj);
    if (adj < -10 && c.confidence === "high") c.confidence = "medium";
    else if (adj < -10 && c.confidence === "medium") c.confidence = "low";
  }

  candidates.sort((a, b) => b.priority - a.priority);

  return candidates[0] || {
    type: "review",
    summary: "Claim Current – No Urgent Actions",
    due_at: null,
    draft_id: null,
    why: "All deadlines met, no outstanding gaps detected",
    confidence: "low" as const,
    tone: "standard" as const,
    priority: 0,
    bullets: ["All deadlines met", "No outstanding gaps detected", "Monitor for carrier response"],
    scores: { money_impact: 0, deadline_risk: 0, aging: 0, resistance: 0 },
  };
}

// ===================== MONEY INTEGRITY CHECK =====================
async function runMoneyIntegrityCheck(
  sb: any, claimId: string, payment: PaymentSnapshot, prevPayment?: PaymentSnapshot | null
) {
  const anomalies: { type: string; desc: string; severity: string }[] = [];

  if (payment.paid > payment.claimed && payment.claimed > 0) {
    anomalies.push({ type: "paid_exceeds_claimed", desc: `Paid ($${payment.paid.toLocaleString()}) exceeds claimed ($${payment.claimed.toLocaleString()})`, severity: "warning" });
  }
  if (payment.rd_available < 0) {
    anomalies.push({ type: "negative_rd", desc: `Recoverable depreciation is negative: $${payment.rd_available}`, severity: "warning" });
  }
  if (prevPayment && prevPayment.payment_velocity > 0 && payment.payment_velocity > prevPayment.payment_velocity * 5) {
    anomalies.push({ type: "velocity_spike", desc: `Payment velocity spiked from $${prevPayment.payment_velocity}/day to $${payment.payment_velocity}/day`, severity: "info" });
  }
  if (prevPayment && prevPayment.gap > 5000 && payment.gap === 0 && payment.paid <= (prevPayment.paid || 0)) {
    anomalies.push({ type: "gap_flip_no_payment", desc: `Gap dropped from $${prevPayment.gap.toLocaleString()} to $0 without new payments`, severity: "critical" });
  }

  if (anomalies.length === 0) return;

  const { data: existing } = await sb.from("autopilot_anomaly_log").select("anomaly_type").eq("claim_id", claimId).eq("resolved", false);
  const existingTypes = new Set((existing || []).map((e: any) => e.anomaly_type));
  const newAnomalies = anomalies.filter((a) => !existingTypes.has(a.type)).map((a) => ({
    claim_id: claimId, anomaly_type: a.type, description: a.desc, severity: a.severity,
  }));
  if (newAnomalies.length > 0) await sb.from("autopilot_anomaly_log").insert(newAnomalies);
}

// ===================== DRIFT ANALYTICS =====================
async function updateDriftAnalytics(sb: any, feedback: any[]) {
  if (feedback.length < 5) return;

  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0];

  const byType: Record<string, { done: number; snooze: number; override: number; dismiss: number; count: number }> = {};
  for (const f of feedback) {
    const key = f.action_type;
    if (!byType[key]) byType[key] = { done: 0, snooze: 0, override: 0, dismiss: 0, count: 0 };
    byType[key][f.user_action as keyof typeof byType[string]] !== undefined && (byType[key] as any)[f.user_action]++;
    byType[key].count++;
  }

  for (const [actionType, counts] of Object.entries(byType)) {
    if (counts.count < 3) continue;
    const total = counts.done + counts.snooze + counts.override + counts.dismiss;
    const overrideRate = total > 0 ? Math.round((counts.override / total) * 100) : 0;
    const executionRate = total > 0 ? Math.round((counts.done / total) * 100) : 0;

    await sb.from("autopilot_drift_analytics").upsert({
      action_type: actionType, context_key: "global", period_start: periodStart, period_end: periodEnd,
      total_count: total, done_count: counts.done, snooze_count: counts.snooze,
      override_count: counts.override, dismiss_count: counts.dismiss,
      override_rate: overrideRate, execution_rate: executionRate,
      flagged_misalignment: overrideRate > 40, updated_at: new Date().toISOString(),
    }, { onConflict: "action_type,context_key,period_start" });
  }
}

// ===================== STRATEGY OUTCOME TRACKING =====================
async function trackStrategyExecution(
  sb: any, claimId: string, nextAction: NextAction, payment: PaymentSnapshot, resistance: string
) {
  const strategyTypes = ["escalation_recommended", "deadline_overdue", "collect_payment"];
  if (!strategyTypes.includes(nextAction.type)) return;

  // Only log once per strategy type per claim per 7-day window
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data: recent } = await sb.from("strategy_outcome_tracking")
    .select("id").eq("claim_id", claimId).eq("strategy_type", nextAction.type)
    .gte("executed_at", weekAgo).limit(1);
  if (recent && recent.length > 0) return;

  const gapPct = payment.claimed > 0 ? Math.round((payment.gap / payment.claimed) * 100) : 0;
  await sb.from("strategy_outcome_tracking").insert({
    claim_id: claimId,
    strategy_type: nextAction.type,
    gap_at_execution: payment.gap,
    gap_pct_at_execution: gapPct,
    resistance_at_execution: resistance,
  });
}

// ===================== QUARTERLY MODEL SNAPSHOT =====================
async function maybeCreateQuarterlySnapshot(sb: any, confidenceAdjustments: Record<string, number>) {
  // Check if we need a quarterly snapshot (every 90 days)
  const { data: latest } = await sb.from("autopilot_model_snapshot")
    .select("snapshot_date").order("snapshot_date", { ascending: false }).limit(1);
  
  const lastDate = latest?.[0]?.snapshot_date ? new Date(latest[0].snapshot_date) : null;
  const daysSinceLast = lastDate ? Math.floor((Date.now() - lastDate.getTime()) / 86400000) : 999;
  
  if (daysSinceLast < 90) return;

  // Fetch current drift analytics for summary
  const { data: drift } = await sb.from("autopilot_drift_analytics")
    .select("action_type, override_rate, execution_rate, flagged_misalignment")
    .order("updated_at", { ascending: false }).limit(20);

  await sb.from("autopilot_model_snapshot").insert({
    snapshot_type: "quarterly",
    scoring_weights: BASELINE_PRIORITY_WEIGHTS,
    resistance_thresholds: { low_max: 30, med_max: 60, high_min: 60 },
    health_parameters: {
      aging_thresholds: [14, 30, 60, 90],
      silence_thresholds: [7, 14, 21, 30],
      red_threshold: 50,
      yellow_threshold: 25,
    },
    confidence_adjustments: confidenceAdjustments,
    escalation_governance: {
      min_confidence: "medium",
      max_stability: 40,
      min_stale_days: 30,
      min_followups: 1,
      penalty_floor_pct: PENALTY_FLOOR_PCT,
    },
    drift_analytics_summary: drift || [],
  });
}

// ===================== PERFORMANCE ATTRIBUTION =====================
async function updatePerformanceAttribution(
  sb: any, claimId: string, claim: any, payment: PaymentSnapshot,
  resistance: string, nextAction: NextAction, daysOpen: number
) {
  // Only update on settled/closed claims or periodically
  if (claim.status !== "Claim Settled" && claim.status !== "Dead File" && !claim.is_closed) return;

  const gapRecoveryPct = payment.claimed > 0 ? Math.round((payment.paid / payment.claimed) * 100) : 0;
  const carrierName = claim.insurance_companies?.name || claim.insurance_company || null;
  const lossType = claim.loss_types?.name || claim.loss_type || null;

  // Check if escalation was used
  const { data: strategies } = await sb.from("strategy_outcome_tracking")
    .select("strategy_type").eq("claim_id", claimId);
  const escalationTypes = (strategies || [])
    .filter((s: any) => s.strategy_type === "escalation_recommended")
    .map((s: any) => s.strategy_type);

  await sb.from("claim_performance_attribution").upsert({
    claim_id: claimId,
    revenue_captured: payment.paid,
    gap_recovery_pct: gapRecoveryPct,
    days_to_recovery: daysOpen,
    escalation_used: escalationTypes.length > 0,
    escalation_types: [...new Set(escalationTypes)],
    resistance_peak_score: resistance === "high" ? 80 : resistance === "med" ? 45 : 15,
    carrier_name: carrierName,
    loss_type: lossType,
    state_code: claim.state || null,
    final_velocity: payment.payment_velocity,
    updated_at: new Date().toISOString(),
  }, { onConflict: "claim_id" });
}

// ===================== CASH FLOW FORECASTING =====================
async function updateCashFlowForecast(sb: any) {
  // Only recompute once per day
  const today = new Date().toISOString().split("T")[0];
  const { data: existing } = await sb.from("cash_flow_forecast")
    .select("id").eq("forecast_date", today).limit(1);
  if (existing && existing.length > 0) return;

  // Fetch all active claim states
  const { data: states } = await sb.from("claim_master_state")
    .select("state_json, claim_id");
  if (!states || states.length === 0) return;

  let totalGap = 0;
  let totalVelocity = 0;
  let totalResistance = 0;
  let activeCount = 0;

  for (const s of states) {
    const state = s.state_json as MasterState;
    if (!state || state.phase === "Closeout") continue;
    activeCount++;
    totalGap += state.payment_snapshot?.gap || 0;
    totalVelocity += state.payment_snapshot?.payment_velocity || 0;
    const rScore = state.resistance === "high" ? 80 : state.resistance === "med" ? 45 : 15;
    totalResistance += rScore;
  }

  const avgVelocity = activeCount > 0 ? Math.round((totalVelocity / activeCount) * 100) / 100 : 0;
  const avgResistance = activeCount > 0 ? Math.round(totalResistance / activeCount) : 0;

  // Forecast: velocity-based projection adjusted by resistance
  const resistanceDrag = 1 - (avgResistance / 200); // 0.5 to 0.925
  const dailyRecovery = totalVelocity * resistanceDrag;
  const expected30d = Math.round(dailyRecovery * 30);
  const expected60d = Math.round(dailyRecovery * 60);
  const expected90dExposure = Math.max(0, Math.round(totalGap - dailyRecovery * 90));

  await sb.from("cash_flow_forecast").upsert({
    forecast_date: today,
    expected_30d_recovery: expected30d,
    expected_60d_recovery: expected60d,
    expected_90d_exposure: expected90dExposure,
    total_outstanding_gap: totalGap,
    total_claims_active: activeCount,
    avg_payment_velocity: avgVelocity,
    avg_resistance_score: avgResistance,
    methodology_notes: "Velocity-based projection with resistance drag factor",
  }, { onConflict: "forecast_date" });
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
