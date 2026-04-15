/**
 * Claims Knowledge Engine — additive intelligence layer for Darwin.
 *
 * Gathers claim-specific facts, declared position, internal knowledge,
 * prior claim lessons, and optional external authority support, then
 * returns a structured context bundle that can be injected into any
 * AI prompt via `formatContextBundle()`.
 *
 * Usage:
 *   import { getClaimsContextBundle, formatContextBundle } from "../_shared/ai/claimsKnowledgeEngine.ts";
 *   const bundle = await getClaimsContextBundle({ claimId, userQuery, taskType, supabase });
 *   const enrichedSystem = formatContextBundle(bundle) + "\n\n" + originalSystemPrompt;
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.39.3";
import type { DarwinTaskType } from "./modelRouter.ts";
import { generate } from "./generate.ts";
import { searchTavily } from "./tavily.ts";
import { hashPrompt, getCache, setCache } from "./cache.ts";

// ── Types ────────────────────────────────────────────────────────────

export interface ClaimFacts {
  carrier: string;
  state: string;
  lossType: string;
  keyDamages: string[];
  disputedItems: string[];
  timelineHighlights: string[];
  estimateSummary: string;
  photoSummary: string;
}

export interface ClaimLesson {
  carrier: string;
  lossType: string;
  strategy: string;
  outcome: string;
  recoveryPercent: number | null;
  whatWorked: string;
}

export interface AuthoritySupport {
  summary: string;
  sources: Array<{ title: string; url: string }>;
}

export interface RetrievalMeta {
  usedSearch: boolean;
  knowledgeCount: number;
  lessonsCount: number;
}

export interface ClaimsContextBundle {
  claimFacts: ClaimFacts | null;
  declaredPosition: string | null;
  internalKnowledge: string[];
  claimLessons: ClaimLesson[];
  authoritySupport: AuthoritySupport | null;
  disputeType: string;
  retrievalMeta: RetrievalMeta;
}

export interface GetClaimsContextBundleOptions {
  claimId: string;
  userQuery: string;
  taskType: DarwinTaskType;
  supabase: SupabaseClient;
}

// ── Dispute types ────────────────────────────────────────────────────

const DISPUTE_TYPES = [
  "repairability", "causation", "scope", "code", "continuity",
  "delay", "engineer_report", "pricing", "policy_interpretation", "general",
] as const;

const SEARCH_WORTHY_DISPUTES = new Set(["code", "causation", "policy_interpretation"]);

const SEARCH_TRIGGER_TERMS = [
  "building code", "manufacturer", "regulation", "statute", "ordinance",
  "irc", "ibc", "nfpa", "standard", "requirement", "specification",
];

// ── Dispute classification ───────────────────────────────────────────

async function classifyDispute(userQuery: string): Promise<string> {
  if (!userQuery || userQuery.length < 10) return "general";

  // Fast keyword-based classification before burning an AI call
  const lower = userQuery.toLowerCase();
  if (/\b(code|irc|ibc|nfpa|building code|ordinance)\b/.test(lower)) return "code";
  if (/\b(cause|causation|proximate|peril|storm|hail|wind)\b/.test(lower)) return "causation";
  if (/\b(scope|missing|omit|left out|not included)\b/.test(lower)) return "scope";
  if (/\b(repair|replace|patch|repairability)\b/.test(lower)) return "repairability";
  if (/\b(price|pricing|unit cost|line item cost|rate)\b/.test(lower)) return "pricing";
  if (/\b(engineer|report|expert|inspection report)\b/.test(lower)) return "engineer_report";
  if (/\b(delay|timeline|days|overdue|prompt pay)\b/.test(lower)) return "delay";
  if (/\b(continuity|match|aesthetic|uniform)\b/.test(lower)) return "continuity";
  if (/\b(policy|coverage|exclusion|endorsement|deductible)\b/.test(lower)) return "policy_interpretation";

  // Fallback: cheap AI classification
  try {
    const result = await generate({
      task: "classification",
      system: `Classify the following insurance claim query into exactly ONE of these dispute types: ${DISPUTE_TYPES.join(", ")}. Return ONLY the dispute type word, nothing else.`,
      user: userQuery.slice(0, 500),
      temperature: 0,
      maxTokens: 20,
      searchMode: "off",
    });
    const classified = result.text.trim().toLowerCase().replace(/[^a-z_]/g, "");
    return (DISPUTE_TYPES as readonly string[]).includes(classified) ? classified : "general";
  } catch {
    return "general";
  }
}

// ── Claim facts gathering ────────────────────────────────────────────

async function gatherClaimFacts(claimId: string, supabase: SupabaseClient): Promise<ClaimFacts | null> {
  try {
    const [claimRes, eventsRes, photosRes, estimateRes, intelRes] = await Promise.all([
      supabase.from("claims").select("insurance_company, state, damage_type, loss_type, type_of_loss, denial_reason, roof_material, construction_trade, declared_position").eq("id", claimId).maybeSingle(),
      supabase.from("claim_events").select("event_type, summary, occurred_at, importance_score").eq("claim_id", claimId).order("occurred_at", { ascending: false }).limit(10),
      supabase.from("claim_photo_findings").select("finding_type, damage_description, evidence_strength, damage_indicators").eq("claim_id", claimId).limit(10),
      supabase.from("claim_estimate_analysis").select("analysis_type, total_gap_amount, missing_items_summary, disputed_items_summary").eq("claim_id", claimId).order("created_at", { ascending: false }).limit(1),
      supabase.from("claim_intelligence_summary").select("most_important_issue, strongest_evidence, missing_evidence, recommended_next_steps").eq("claim_id", claimId).maybeSingle(),
    ]);

    const claim = claimRes.data;
    if (!claim) return null;

    const estimate = estimateRes.data?.[0];
    const photos = photosRes.data || [];
    const events = eventsRes.data || [];
    const intel = intelRes.data;

    // Key damages from photos
    const keyDamages = photos
      .filter((p: any) => p.evidence_strength === "strong" || p.evidence_strength === "moderate")
      .map((p: any) => `${p.finding_type}: ${(p.damage_description || "").slice(0, 100)}`)
      .slice(0, 5);

    // Disputed items from estimate
    const disputedItems: string[] = [];
    if (estimate?.disputed_items_summary) {
      const summary = typeof estimate.disputed_items_summary === "string"
        ? estimate.disputed_items_summary
        : JSON.stringify(estimate.disputed_items_summary);
      disputedItems.push(summary.slice(0, 300));
    }
    if (estimate?.missing_items_summary) {
      const summary = typeof estimate.missing_items_summary === "string"
        ? estimate.missing_items_summary
        : JSON.stringify(estimate.missing_items_summary);
      disputedItems.push(`Missing: ${summary.slice(0, 300)}`);
    }

    // Timeline highlights
    const timelineHighlights = events
      .filter((e: any) => (e.importance_score || 0) >= 3)
      .map((e: any) => `${e.event_type}: ${(e.summary || "").slice(0, 80)}`)
      .slice(0, 5);

    // Photo summary
    const strongCount = photos.filter((p: any) => p.evidence_strength === "strong").length;
    const photoSummary = photos.length > 0
      ? `${photos.length} photos analyzed, ${strongCount} with strong evidence`
      : "No photos analyzed";

    // Estimate summary
    const estimateSummary = estimate
      ? `Gap: $${(estimate.total_gap_amount || 0).toLocaleString()}`
      : "No estimate analysis available";

    return {
      carrier: claim.insurance_company || "Unknown",
      state: claim.state || "Unknown",
      lossType: claim.damage_type || claim.loss_type || claim.type_of_loss || "Unknown",
      keyDamages,
      disputedItems,
      timelineHighlights,
      estimateSummary,
      photoSummary,
    };
  } catch (e) {
    console.error("[ClaimsKnowledgeEngine] Failed to gather claim facts:", e);
    return null;
  }
}

// ── Internal knowledge retrieval ─────────────────────────────────────

async function retrieveInternalKnowledge(
  supabase: SupabaseClient,
  disputeType: string,
  state: string,
  trade: string | null,
  material: string | null,
): Promise<string[]> {
  try {
    let query = supabase
      .from("claim_knowledge_library")
      .select("title, content, authority_level, source_type, trade, material, state, dispute_type")
      .order("authority_level", { ascending: true })
      .limit(5);

    if (disputeType && disputeType !== "general") {
      query = query.eq("dispute_type", disputeType);
    }
    if (state) {
      query = query.or(`state.eq.${state},state.is.null`);
    }

    const { data, error } = await query;
    if (error || !data?.length) return [];

    // Score and rank
    return data
      .map((entry: any) => {
        let relevance = entry.authority_level || 1;
        if (trade && entry.trade && entry.trade.toLowerCase() === trade.toLowerCase()) relevance += 1;
        if (material && entry.material && entry.material.toLowerCase() === material.toLowerCase()) relevance += 1;
        return { ...entry, relevance };
      })
      .sort((a: any, b: any) => b.relevance - a.relevance)
      .slice(0, 5)
      .map((entry: any) => `[${entry.source_type?.toUpperCase() || "INTERNAL"}] ${entry.title}\n${(entry.content || "").slice(0, 500)}`);
  } catch (e) {
    console.error("[ClaimsKnowledgeEngine] Knowledge retrieval error:", e);
    return [];
  }
}

// ── Prior claim lessons ──────────────────────────────────────────────

async function retrieveClaimLessons(
  supabase: SupabaseClient,
  carrier: string,
  lossType: string,
  state: string,
): Promise<ClaimLesson[]> {
  try {
    const queries = [
      // Exact: carrier + loss type
      supabase.from("claim_outcome_learning")
        .select("carrier, loss_type, strategy_sequence, outcome, recovery_delta, winning_arguments, key_turning_point")
        .ilike("carrier", `%${carrier}%`)
        .ilike("loss_type", `%${lossType}%`)
        .limit(5),
      // Broader: carrier + state
      supabase.from("claim_outcome_learning")
        .select("carrier, loss_type, strategy_sequence, outcome, recovery_delta, winning_arguments, key_turning_point")
        .ilike("carrier", `%${carrier}%`)
        .eq("state_code", state)
        .limit(5),
    ];

    const results = await Promise.all(queries);
    const allLessons = results.flatMap((r) => r.data || []);

    // Deduplicate by carrier+outcome
    const seen = new Set<string>();
    const unique: ClaimLesson[] = [];

    for (const l of allLessons) {
      const key = `${l.carrier}:${l.outcome}:${l.loss_type}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const strategies = l.strategy_sequence;
      const strategyText = Array.isArray(strategies)
        ? strategies.join(" → ")
        : typeof strategies === "string" ? strategies : "N/A";

      const winArgs = l.winning_arguments;
      const whatWorked = Array.isArray(winArgs)
        ? winArgs.slice(0, 3).join("; ")
        : l.key_turning_point || "N/A";

      unique.push({
        carrier: l.carrier || "Unknown",
        lossType: l.loss_type || "Unknown",
        strategy: strategyText,
        outcome: l.outcome || "Unknown",
        recoveryPercent: l.recovery_delta || null,
        whatWorked,
      });
    }

    return unique.slice(0, 3);
  } catch (e) {
    console.error("[ClaimsKnowledgeEngine] Lessons retrieval error:", e);
    return [];
  }
}

// ── Authority support (Tavily) ───────────────────────────────────────

async function retrieveAuthoritySupport(
  disputeType: string,
  userQuery: string,
  state: string,
  trade: string | null,
  material: string | null,
): Promise<AuthoritySupport | null> {
  // Only trigger for specific dispute types or explicit keywords
  const shouldSearch = SEARCH_WORTHY_DISPUTES.has(disputeType) ||
    SEARCH_TRIGGER_TERMS.some((t) => userQuery.toLowerCase().includes(t));

  if (!shouldSearch) return null;

  try {
    const searchQuery = [state, trade, material, disputeType, "insurance requirement manufacturer regulation"]
      .filter(Boolean)
      .join(" ");

    const result = await searchTavily(searchQuery, "basic");
    if (!result?.sources?.length) return null;

    const topSources = result.sources.slice(0, 3);
    return {
      summary: result.answer || "",
      sources: topSources.map((s) => ({ title: s.title, url: s.url })),
    };
  } catch (e) {
    console.error("[ClaimsKnowledgeEngine] Authority support search failed:", e);
    return null;
  }
}

// ── Main entry point ─────────────────────────────────────────────────

export async function getClaimsContextBundle(
  opts: GetClaimsContextBundleOptions,
): Promise<ClaimsContextBundle> {
  const { claimId, userQuery, taskType, supabase } = opts;

  // Cache check: claimId + query hash
  const queryHash = await hashPrompt(`${claimId}:${userQuery}:${taskType}`);
  const cacheKey = `cke:${queryHash}`;
  const cached = getCache<ClaimsContextBundle>(cacheKey);
  if (cached) {
    console.log(`[ClaimsKnowledgeEngine] Cache hit for ${claimId}`);
    return cached;
  }

  // Step 1 + 2: Claim facts (includes declared position)
  const [claimFacts, disputeType] = await Promise.all([
    gatherClaimFacts(claimId, supabase),
    classifyDispute(userQuery),
  ]);

  // Extract declared position from claim
  let declaredPosition: string | null = null;
  try {
    const { data } = await supabase
      .from("claims")
      .select("declared_position")
      .eq("id", claimId)
      .maybeSingle();
    if (data?.declared_position) {
      declaredPosition = typeof data.declared_position === "string"
        ? data.declared_position
        : JSON.stringify(data.declared_position);
    }
  } catch { /* non-fatal */ }

  const carrier = claimFacts?.carrier || "Unknown";
  const state = claimFacts?.state || "";
  const lossType = claimFacts?.lossType || "";

  // Get trade/material from claim for knowledge matching
  let trade: string | null = null;
  let material: string | null = null;
  try {
    const { data } = await supabase
      .from("claims")
      .select("construction_trade, roof_material")
      .eq("id", claimId)
      .maybeSingle();
    trade = data?.construction_trade || null;
    material = data?.roof_material || null;
  } catch { /* non-fatal */ }

  // Steps 3-6: Parallel retrieval
  const [internalKnowledge, claimLessons, authoritySupport] = await Promise.all([
    retrieveInternalKnowledge(supabase, disputeType, state, trade, material),
    retrieveClaimLessons(supabase, carrier, lossType, state),
    retrieveAuthoritySupport(disputeType, userQuery, state, trade, material),
  ]);

  const bundle: ClaimsContextBundle = {
    claimFacts,
    declaredPosition,
    internalKnowledge,
    claimLessons,
    authoritySupport,
    disputeType,
    retrievalMeta: {
      usedSearch: !!authoritySupport,
      knowledgeCount: internalKnowledge.length,
      lessonsCount: claimLessons.length,
    },
  };

  // Cache for reuse
  setCache(cacheKey, bundle);

  console.log(
    `[ClaimsKnowledgeEngine] Bundle for ${claimId}: dispute=${disputeType}, knowledge=${internalKnowledge.length}, lessons=${claimLessons.length}, search=${!!authoritySupport}`,
  );

  return bundle;
}

// ── Format bundle into prompt sections ───────────────────────────────

export function formatContextBundle(bundle: ClaimsContextBundle): string {
  const sections: string[] = [];

  // 1. Claim facts (highest priority)
  if (bundle.claimFacts) {
    const f = bundle.claimFacts;
    sections.push(`=== CLAIM FACTS ===
Carrier: ${f.carrier}
State: ${f.state}
Loss Type: ${f.lossType}
Key Damages: ${f.keyDamages.length > 0 ? f.keyDamages.join("; ") : "None documented"}
Disputed Items: ${f.disputedItems.length > 0 ? f.disputedItems.join("; ") : "None identified"}
Timeline Highlights: ${f.timelineHighlights.length > 0 ? f.timelineHighlights.join("; ") : "None"}
Estimate: ${f.estimateSummary}
Photos: ${f.photoSummary}
=== END CLAIM FACTS ===`);
  }

  // 2. Declared position
  if (bundle.declaredPosition) {
    sections.push(`=== DECLARED POSITION ===
${bundle.declaredPosition}
=== END DECLARED POSITION ===`);
  }

  // 3. Internal knowledge
  if (bundle.internalKnowledge.length > 0) {
    sections.push(`=== INTERNAL KNOWLEDGE ===
${bundle.internalKnowledge.join("\n\n")}
=== END INTERNAL KNOWLEDGE ===`);
  }

  // 4. Claim lessons
  if (bundle.claimLessons.length > 0) {
    const lessonsText = bundle.claimLessons.map((l, i) =>
      `[${i + 1}] ${l.carrier} | ${l.lossType} | Strategy: ${l.strategy} | Outcome: ${l.outcome}${l.recoveryPercent ? ` | Recovery: ${l.recoveryPercent}%` : ""} | What Worked: ${l.whatWorked}`
    ).join("\n");
    sections.push(`=== PRIOR CLAIM LESSONS ===
${lessonsText}
=== END PRIOR CLAIM LESSONS ===`);
  }

  // 5. Authority support
  if (bundle.authoritySupport) {
    const sourcesText = bundle.authoritySupport.sources
      .map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`)
      .join("\n");
    sections.push(`=== AUTHORITY SUPPORT ===
${bundle.authoritySupport.summary}
Sources:
${sourcesText}
=== END AUTHORITY SUPPORT ===`);
  }

  return sections.join("\n\n");
}
