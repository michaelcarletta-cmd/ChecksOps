/**
 * Rule Learning Engine — discovers, scores, and activates new rule candidates
 * from past dismantlers, rebuttals, and winning claim outcomes.
 *
 * NON-BREAKING / ADDITIVE:
 *  - Does not replace any existing handcrafted rules
 *  - Discovered rules live in `learned_rule_candidates` until promoted
 *  - Only candidates passing thresholds are copied into `learned_rules_active`
 *  - Active rules are consumed by preDismantlerRules + claimsKnowledgeEngine
 *
 * Public API:
 *   discoverRuleCandidatesForClaim(claimId, supabase)
 *   discoverGlobalRuleCandidates(supabase, opts?)
 *   scoreRuleCandidate(candidate, supabase)
 *   activateApprovedRules(supabase)
 *   getActiveLearnedRules(supabase, { carrier, state, trade, material, disputeType })
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

// ── Types ────────────────────────────────────────────────────────────

export type LearnedRuleType =
  | "phrase_trigger"
  | "denial_pattern"
  | "engineer_weakness"
  | "carrier_behavior_trigger"
  | "rebuttal_angle"
  | "escalation_rule"
  | "evidence_gap_rule";

export type ActivationStatus = "candidate" | "approved" | "active" | "rejected";

export interface RuleCandidate {
  id?: string;
  rule_type: LearnedRuleType;
  trigger_pattern: string;
  normalized_pattern: string;
  source_phrase?: string | null;
  weakness_category?: string | null;
  rebuttal_strategy?: string | null;
  evidence_request?: string | null;
  source_document_type?: string | null;
  carrier?: string | null;
  state?: string | null;
  trade?: string | null;
  material?: string | null;
  dispute_type?: string | null;
  supporting_claim_count?: number;
  win_count?: number;
  loss_count?: number;
  confidence_score?: number;
  activation_status?: ActivationStatus;
  created_from_claim_ids?: string[];
  notes?: string | null;
}

export interface ActiveLearnedRule {
  id: string;
  candidate_id: string;
  rule_type: LearnedRuleType;
  trigger_pattern: string;
  normalized_pattern: string;
  weakness_category: string | null;
  rebuttal_strategy: string | null;
  evidence_request: string | null;
  carrier: string | null;
  state: string | null;
  trade: string | null;
  material: string | null;
  dispute_type: string | null;
  confidence_score: number;
}

export interface LearnedRuleQuery {
  carrier?: string | null;
  state?: string | null;
  trade?: string | null;
  material?: string | null;
  disputeType?: string | null;
  limit?: number;
}

// ── Constants ────────────────────────────────────────────────────────

const ACTIVATION_THRESHOLDS = {
  minSupportingClaims: 3,
  minWins: 2,
  minConfidenceScore: 8,
  minPatternLength: 6,
  maxPatternLength: 120,
};

// Phrases too generic to ever be promoted on their own
const GENERIC_BLOCKLIST = new Set([
  "damage", "report", "the roof", "the property", "claim", "loss", "estimate",
  "however", "therefore", "in addition", "as a result", "based on",
]);

const BOILERPLATE_STRIP = [
  /^the\s+/i, /^a\s+/i, /^an\s+/i, /^this\s+/i, /^that\s+/i,
];

// ── Normalization ────────────────────────────────────────────────────

export function normalizePattern(raw: string): string {
  if (!raw) return "";
  let s = raw.toLowerCase().trim();
  s = s.replace(/[^\w\s-]/g, " ");          // strip punctuation
  s = s.replace(/\s+/g, " ").trim();        // collapse whitespace
  for (const re of BOILERPLATE_STRIP) s = s.replace(re, "");
  // Collapse common variants
  s = s.replace(/\bvisually inspected\b/g, "visual inspection");
  s = s.replace(/\bnon[\s-]?invasive\b/g, "non invasive");
  s = s.replace(/\blocalized\b/g, "localized");
  s = s.replace(/\b(spot|patch)\s+repair\b/g, "spot repair");
  return s.trim();
}

function isGenericPattern(normalized: string): boolean {
  if (!normalized) return true;
  if (normalized.length < ACTIVATION_THRESHOLDS.minPatternLength) return true;
  if (normalized.length > ACTIVATION_THRESHOLDS.maxPatternLength) return true;
  if (GENERIC_BLOCKLIST.has(normalized)) return true;
  // Single word patterns are too generic unless they're long technical terms
  if (!normalized.includes(" ") && normalized.length < 12) return true;
  return false;
}

// ── Phrase extraction (simple n-gram + keyword) ──────────────────────

const SEED_WEAKNESS_PHRASES = [
  "visual inspection only", "visual inspection", "limited inspection",
  "non invasive", "exterior only", "spot repair", "localized repair",
  "wear and tear", "deterioration", "deferred maintenance", "normal aging",
  "appears consistent with", "appears to", "may have", "could be", "likely",
  "condition related", "pre existing", "not caused by", "no evidence of",
  "patch", "limited to",
];

function extractCandidatePhrases(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const found = new Set<string>();
  for (const seed of SEED_WEAKNESS_PHRASES) {
    if (lower.includes(seed)) found.add(seed);
  }
  return Array.from(found);
}

// ── Discovery: per claim ─────────────────────────────────────────────

export async function discoverRuleCandidatesForClaim(
  claimId: string,
  supabase: SupabaseClient,
): Promise<{ created: number; updated: number; skipped: number }> {
  let created = 0, updated = 0, skipped = 0;

  // Load claim context
  const { data: claim } = await supabase
    .from("claims")
    .select("id, insurance_company, state, construction_trade, roof_material")
    .eq("id", claimId)
    .maybeSingle();

  const ctx = {
    carrier: claim?.insurance_company || null,
    state: claim?.state || null,
    trade: claim?.construction_trade || null,
    material: claim?.roof_material || null,
  };

  // Sources in parallel
  const [dismantlersRes, outcomesRes, argsRes] = await Promise.all([
    supabase.from("claim_document_dismantlers")
      .select("document_type, strongest_rebuttal_points, evidence_to_gather_next, main_position, report_summary, draft_rebuttal_language")
      .eq("claim_id", claimId)
      .limit(20),
    supabase.from("claim_outcome_learning")
      .select("outcome, winning_arguments, key_turning_point, denial_rationale, strategy_sequence")
      .eq("claim_id", claimId)
      .limit(10),
    supabase.from("claim_argument_map")
      .select("argument_type, argument_text, carrier_position_summary, rebuttal_strategies")
      .eq("claim_id", claimId)
      .limit(50),
  ]);

  const dismantlers = dismantlersRes.data || [];
  const outcomes = outcomesRes.data || [];
  const args = argsRes.data || [];

  const winOutcomes = outcomes.filter((o: any) =>
    String(o.outcome || "").toLowerCase().match(/win|paid|approved|reversed|settled.*above|favorable/)
  );
  const lossOutcomes = outcomes.filter((o: any) =>
    String(o.outcome || "").toLowerCase().match(/loss|denied|closed.*denied|adverse/)
  );
  const isWinningClaim = winOutcomes.length > 0;
  const isLosingClaim = lossOutcomes.length > 0 && winOutcomes.length === 0;

  const candidates: RuleCandidate[] = [];

  // From dismantlers — phrase triggers + rebuttal angles
  for (const d of dismantlers) {
    const docType = d.document_type || null;
    const sourceText = [d.main_position, d.report_summary, d.draft_rebuttal_language].filter(Boolean).join(" ");
    const phrases = extractCandidatePhrases(sourceText);
    const rebuttals: string[] = Array.isArray(d.strongest_rebuttal_points) ? d.strongest_rebuttal_points : [];
    const evidence: string[] = Array.isArray(d.evidence_to_gather_next) ? d.evidence_to_gather_next : [];

    for (const phrase of phrases) {
      const normalized = normalizePattern(phrase);
      if (isGenericPattern(normalized)) continue;
      candidates.push({
        rule_type: docType === "carrier_denial" ? "denial_pattern" : "phrase_trigger",
        trigger_pattern: phrase,
        normalized_pattern: normalized,
        source_phrase: phrase,
        weakness_category: docType === "engineer_report" ? "engineer_weakness" : "carrier_position",
        rebuttal_strategy: rebuttals[0]?.toString().slice(0, 500) || null,
        evidence_request: evidence[0]?.toString().slice(0, 500) || null,
        source_document_type: docType,
        carrier: ctx.carrier,
        state: ctx.state,
        trade: ctx.trade,
        material: ctx.material,
        dispute_type: null,
        created_from_claim_ids: [claimId],
      });
    }

    // Treat each rebuttal point as a potential rebuttal_angle candidate
    for (const r of rebuttals.slice(0, 3)) {
      const text = String(r).slice(0, 200);
      const normalized = normalizePattern(text);
      if (isGenericPattern(normalized)) continue;
      candidates.push({
        rule_type: "rebuttal_angle",
        trigger_pattern: text,
        normalized_pattern: normalized,
        source_phrase: text,
        weakness_category: "rebuttal_angle",
        rebuttal_strategy: text,
        evidence_request: evidence[0]?.toString().slice(0, 500) || null,
        source_document_type: docType,
        carrier: ctx.carrier,
        state: ctx.state,
        trade: ctx.trade,
        material: ctx.material,
        created_from_claim_ids: [claimId],
      });
    }
  }

  // From outcomes — winning arguments
  for (const o of outcomes) {
    const winning: string[] = Array.isArray(o.winning_arguments) ? o.winning_arguments : [];
    for (const w of winning.slice(0, 3)) {
      const text = String(w).slice(0, 200);
      const normalized = normalizePattern(text);
      if (isGenericPattern(normalized)) continue;
      candidates.push({
        rule_type: "rebuttal_angle",
        trigger_pattern: text,
        normalized_pattern: normalized,
        source_phrase: text,
        weakness_category: "winning_argument",
        rebuttal_strategy: text,
        carrier: ctx.carrier,
        state: ctx.state,
        trade: ctx.trade,
        material: ctx.material,
        created_from_claim_ids: [claimId],
        notes: `outcome=${o.outcome}`,
      });
    }
    if (o.denial_rationale) {
      const text = String(o.denial_rationale).slice(0, 200);
      const normalized = normalizePattern(text);
      if (!isGenericPattern(normalized)) {
        candidates.push({
          rule_type: "denial_pattern",
          trigger_pattern: text,
          normalized_pattern: normalized,
          source_phrase: text,
          weakness_category: "denial_rationale",
          carrier: ctx.carrier,
          state: ctx.state,
          trade: ctx.trade,
          material: ctx.material,
          created_from_claim_ids: [claimId],
        });
      }
    }
  }

  // From argument map — carrier position triggers
  for (const a of args) {
    if (!a.argument_text) continue;
    const phrases = extractCandidatePhrases(String(a.argument_text));
    const rebuttals: string[] = Array.isArray(a.rebuttal_strategies) ? a.rebuttal_strategies : [];
    for (const phrase of phrases) {
      const normalized = normalizePattern(phrase);
      if (isGenericPattern(normalized)) continue;
      candidates.push({
        rule_type: "phrase_trigger",
        trigger_pattern: phrase,
        normalized_pattern: normalized,
        source_phrase: phrase,
        weakness_category: a.argument_type || null,
        rebuttal_strategy: rebuttals[0]?.toString().slice(0, 500) || null,
        carrier: ctx.carrier,
        state: ctx.state,
        trade: ctx.trade,
        material: ctx.material,
        created_from_claim_ids: [claimId],
      });
    }
  }

  // Upsert each candidate (merge into existing where pattern+context matches)
  for (const c of candidates) {
    try {
      const { data: existing } = await supabase
        .from("learned_rule_candidates")
        .select("id, supporting_claim_count, win_count, loss_count, created_from_claim_ids, confidence_score")
        .eq("rule_type", c.rule_type)
        .eq("normalized_pattern", c.normalized_pattern)
        .eq("carrier", c.carrier ?? "")
        .eq("state", c.state ?? "")
        .eq("trade", c.trade ?? "")
        .eq("material", c.material ?? "")
        .eq("dispute_type", c.dispute_type ?? "")
        .maybeSingle();

      if (existing) {
        const claimIds: string[] = existing.created_from_claim_ids || [];
        const alreadyCounted = claimIds.includes(claimId);
        const newClaimIds = alreadyCounted ? claimIds : [...claimIds, claimId];
        const newSupporting = newClaimIds.length;
        const newWin = (existing.win_count || 0) + (alreadyCounted ? 0 : (isWinningClaim ? 1 : 0));
        const newLoss = (existing.loss_count || 0) + (alreadyCounted ? 0 : (isLosingClaim ? 1 : 0));
        const updateRow = {
          supporting_claim_count: newSupporting,
          win_count: newWin,
          loss_count: newLoss,
          created_from_claim_ids: newClaimIds,
          confidence_score: computeScore({ ...c, supporting_claim_count: newSupporting, win_count: newWin, loss_count: newLoss }),
          updated_at: new Date().toISOString(),
        };
        await supabase.from("learned_rule_candidates").update(updateRow).eq("id", existing.id);
        updated++;
      } else {
        const supporting = 1;
        const win = isWinningClaim ? 1 : 0;
        const loss = isLosingClaim ? 1 : 0;
        const insertRow = {
          ...c,
          carrier: c.carrier ?? null,
          state: c.state ?? null,
          trade: c.trade ?? null,
          material: c.material ?? null,
          dispute_type: c.dispute_type ?? null,
          supporting_claim_count: supporting,
          win_count: win,
          loss_count: loss,
          confidence_score: computeScore({ ...c, supporting_claim_count: supporting, win_count: win, loss_count: loss }),
          activation_status: "candidate" as ActivationStatus,
        };
        const { error } = await supabase.from("learned_rule_candidates").insert(insertRow);
        if (error) {
          // Likely a race on the unique index — fall through silently
          skipped++;
        } else {
          created++;
        }
      }
    } catch (e) {
      console.error("[RuleLearning] upsert error:", (e as Error).message);
      skipped++;
    }
  }

  console.log(`[RuleLearning] claim=${claimId} candidates=${candidates.length} created=${created} updated=${updated} skipped=${skipped}`);
  return { created, updated, skipped };
}

// ── Discovery: global batch ─────────────────────────────────────────

export async function discoverGlobalRuleCandidates(
  supabase: SupabaseClient,
  opts: { limit?: number; sinceDays?: number } = {},
): Promise<{ processedClaims: number; totalCreated: number; totalUpdated: number }> {
  const limit = opts.limit ?? 100;
  const sinceDays = opts.sinceDays ?? 365;
  const sinceIso = new Date(Date.now() - sinceDays * 86400_000).toISOString();

  const { data: claims } = await supabase
    .from("claims")
    .select("id")
    .gte("updated_at", sinceIso)
    .order("updated_at", { ascending: false })
    .limit(limit);

  let totalCreated = 0, totalUpdated = 0;
  const list = claims || [];
  for (const c of list) {
    try {
      const r = await discoverRuleCandidatesForClaim(c.id, supabase);
      totalCreated += r.created;
      totalUpdated += r.updated;
    } catch (e) {
      console.error(`[RuleLearning] global error for ${c.id}:`, (e as Error).message);
    }
  }
  console.log(`[RuleLearning] global discover: claims=${list.length} created=${totalCreated} updated=${totalUpdated}`);
  return { processedClaims: list.length, totalCreated, totalUpdated };
}

// ── Scoring ──────────────────────────────────────────────────────────

function computeScore(c: RuleCandidate): number {
  const supporting = c.supporting_claim_count ?? 0;
  const wins = c.win_count ?? 0;
  const losses = c.loss_count ?? 0;
  let score = 0;
  score += supporting * 2;
  score += wins * 3;
  score -= losses * 2;
  if (c.carrier) score += 1;
  if (c.dispute_type) score += 1;
  if (c.rule_type === "rebuttal_angle" && wins > 0) score += 2;
  if (c.normalized_pattern && c.normalized_pattern.length > 30) score += 1;
  // Penalty if loss-heavy
  if (losses > wins && losses >= 2) score -= 3;
  // Generic phrase penalty
  if (isGenericPattern(c.normalized_pattern || "")) score -= 5;
  return Number(score.toFixed(2));
}

export async function scoreRuleCandidate(
  candidate: RuleCandidate,
  _supabase: SupabaseClient,
): Promise<number> {
  return computeScore(candidate);
}

// ── Activation ───────────────────────────────────────────────────────

export async function activateApprovedRules(
  supabase: SupabaseClient,
): Promise<{ approved: number; activated: number; rejected: number }> {
  let approved = 0, activated = 0, rejected = 0;

  // Pull all candidates still in 'candidate' or 'approved' status
  const { data: candidates } = await supabase
    .from("learned_rule_candidates")
    .select("*")
    .in("activation_status", ["candidate", "approved"])
    .order("confidence_score", { ascending: false })
    .limit(500);

  for (const c of candidates || []) {
    const meetsThresholds =
      (c.supporting_claim_count ?? 0) >= ACTIVATION_THRESHOLDS.minSupportingClaims &&
      (c.win_count ?? 0) >= ACTIVATION_THRESHOLDS.minWins &&
      (c.confidence_score ?? 0) >= ACTIVATION_THRESHOLDS.minConfidenceScore &&
      !isGenericPattern(c.normalized_pattern || "");

    const tooNoisy = (c.loss_count ?? 0) > (c.win_count ?? 0) && (c.loss_count ?? 0) >= 3;

    if (tooNoisy) {
      await supabase.from("learned_rule_candidates")
        .update({ activation_status: "rejected", notes: "auto-rejected: loss-heavy" })
        .eq("id", c.id);
      rejected++;
      continue;
    }

    if (!meetsThresholds) continue;

    // Mark approved
    if (c.activation_status !== "approved") {
      await supabase.from("learned_rule_candidates")
        .update({ activation_status: "approved" })
        .eq("id", c.id);
      approved++;
    }

    // Promote into learned_rules_active if not already there
    const { data: existingActive } = await supabase
      .from("learned_rules_active")
      .select("id")
      .eq("candidate_id", c.id)
      .maybeSingle();

    if (!existingActive) {
      const { error } = await supabase.from("learned_rules_active").insert({
        candidate_id: c.id,
        rule_type: c.rule_type,
        trigger_pattern: c.trigger_pattern,
        normalized_pattern: c.normalized_pattern,
        weakness_category: c.weakness_category,
        rebuttal_strategy: c.rebuttal_strategy,
        evidence_request: c.evidence_request,
        carrier: c.carrier,
        state: c.state,
        trade: c.trade,
        material: c.material,
        dispute_type: c.dispute_type,
        confidence_score: c.confidence_score,
      });
      if (!error) {
        await supabase.from("learned_rule_candidates")
          .update({ activation_status: "active" })
          .eq("id", c.id);
        activated++;
      }
    }
  }

  console.log(`[RuleLearning] activation: approved=${approved} activated=${activated} rejected=${rejected}`);
  return { approved, activated, rejected };
}

// ── Retrieval ────────────────────────────────────────────────────────

export async function getActiveLearnedRules(
  supabase: SupabaseClient,
  q: LearnedRuleQuery = {},
): Promise<ActiveLearnedRule[]> {
  const limit = q.limit ?? 50;
  try {
    let query = supabase
      .from("learned_rules_active")
      .select("*")
      .eq("is_enabled", true)
      .order("confidence_score", { ascending: false })
      .limit(limit);

    // Match either exact context OR null context (global rule)
    if (q.carrier) query = query.or(`carrier.eq.${q.carrier},carrier.is.null`);
    if (q.state) query = query.or(`state.eq.${q.state},state.is.null`);
    if (q.trade) query = query.or(`trade.eq.${q.trade},trade.is.null`);
    if (q.material) query = query.or(`material.eq.${q.material},material.is.null`);
    if (q.disputeType) query = query.or(`dispute_type.eq.${q.disputeType},dispute_type.is.null`);

    const { data, error } = await query;
    if (error) {
      console.error("[RuleLearning] getActiveLearnedRules error:", error.message);
      return [];
    }
    return (data || []) as ActiveLearnedRule[];
  } catch (e) {
    console.error("[RuleLearning] getActiveLearnedRules exception:", (e as Error).message);
    return [];
  }
}

// ── Format helpers for prompt injection ─────────────────────────────

export function formatLearnedRulesForPrompt(rules: ActiveLearnedRule[]): string {
  if (!rules || rules.length === 0) return "";
  const lines = rules.slice(0, 10).map((r, i) => {
    const ctx = [r.carrier, r.state, r.trade, r.material].filter(Boolean).join(" / ") || "global";
    const reb = r.rebuttal_strategy ? ` → ${r.rebuttal_strategy}` : "";
    const ev = r.evidence_request ? ` [evidence: ${r.evidence_request}]` : "";
    return `[${i + 1}] (${r.rule_type}, ${ctx}, score=${r.confidence_score}) "${r.trigger_pattern}"${reb}${ev}`;
  });
  return `=== LEARNED RULES (auto-discovered, additive) ===\n${lines.join("\n")}\n=== END LEARNED RULES ===`;
}
