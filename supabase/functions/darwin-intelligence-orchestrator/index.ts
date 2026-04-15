import { createClient } from "npm:@supabase/supabase-js@2.39.3";
import { generate } from "../_shared/ai/generate.ts";
import { getClaimsContextBundle, formatContextBundle } from "../_shared/ai/claimsKnowledgeEngine.ts";
import { formatDismantlerForPrompt, type DismantlerResult } from "../_shared/ai/universalDismantler.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// ── Deterministic pre-scoring weights ──
const WEIGHTS = {
  evidence:  0.30,
  financial: 0.25,
  strategy:  0.20,
  rebuttal:  0.15,
  learning:  0.10,
};

function clamp(v: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

/** Compute deterministic sub-scores from raw intelligence data */
function computePreScores(ctx: {
  estimates: any[];
  photos: any[];
  strategies: any[];
  arguments_: any[];
  rebuttals: any[];
  carrierOutcomes: any[];
  feedback: any[];
  deadlines: any[];
  claim: any;
}) {
  const { estimates, photos, strategies, arguments_, rebuttals, carrierOutcomes, feedback, deadlines, claim } = ctx;

  // ── Evidence confidence ──
  const hasEstimate = estimates.length > 0;
  const hasPhotos = photos.length > 0;
  const strongPhotos = photos.filter((p: any) => p.evidence_strength === 'strong').length;
  const hasArguments = arguments_.length > 0;
  const hasRebuttals = rebuttals.length > 0;
  const layerCount = [hasEstimate, hasPhotos, hasArguments, hasRebuttals].filter(Boolean).length;
  const evidenceScore = clamp(
    (layerCount / 4) * 50 +
    Math.min(strongPhotos, 5) * 6 +
    Math.min(rebuttals.length, 5) * 4
  );

  // ── Financial confidence ──
  const gap = estimates[0]?.total_gap_amount || 0;
  const missingItems = estimates[0]?.missing_items_count || 0;
  const underpaid = estimates[0]?.underpaid_items_count || 0;
  const paEstimate = claim?.pa_estimate_amount || 0;
  const carrierEstimate = claim?.carrier_estimate_amount || 0;
  const gapRatio = paEstimate > 0 ? gap / paEstimate : 0;
  const financialScore = clamp(
    Math.min(gapRatio * 100, 40) +
    Math.min(missingItems * 5, 30) +
    Math.min(underpaid * 5, 30)
  );

  // ── Strategy confidence ──
  const topStrategy = strategies.find((s: any) => s.is_recommended) || strategies[0];
  const simCount = strategies.length;
  const topScore = topStrategy?.score || 0;
  const strategyScore = clamp(
    (simCount > 0 ? 30 : 0) +
    (topScore * 0.5) +
    (topStrategy?.required_missing_evidence?.length === 0 ? 20 : 0)
  );

  // ── Rebuttal confidence ──
  const weakArgs = arguments_.filter((a: any) => (a.strength_score || 0) < 40);
  const contradictions = arguments_.filter((a: any) =>
    a.contradictions && Array.isArray(a.contradictions) && a.contradictions.length > 0
  );
  const rebuttalScore = clamp(
    (rebuttals.length > 0 ? 30 : 0) +
    Math.min(contradictions.length * 15, 30) +
    Math.min(weakArgs.length * 10, 20) +
    (hasArguments ? 20 : 0)
  );

  // ── Learning confidence ──
  const outcomeCount = carrierOutcomes.length;
  const feedbackPos = feedback.filter((f: any) => f.feedback_type === 'thumbs_up').length;
  const feedbackNeg = feedback.filter((f: any) => f.feedback_type === 'thumbs_down').length;
  const feedbackTotal = feedback.length;
  const feedbackRatio = feedbackTotal > 0 ? feedbackPos / feedbackTotal : 0.5;
  const learningScore = clamp(
    Math.min(outcomeCount * 10, 50) +
    feedbackRatio * 30 +
    (feedbackTotal > 5 ? 20 : feedbackTotal * 4)
  );

  // ── Overall ──
  const overall = clamp(
    evidenceScore * WEIGHTS.evidence +
    financialScore * WEIGHTS.financial +
    strategyScore * WEIGHTS.strategy +
    rebuttalScore * WEIGHTS.rebuttal +
    learningScore * WEIGHTS.learning
  );

  return {
    evidence_confidence: evidenceScore,
    financial_confidence: financialScore,
    strategy_confidence: strategyScore,
    rebuttal_confidence: rebuttalScore,
    learning_confidence: learningScore,
    overall_confidence: overall,
    pre_scores: {
      evidence: {
        layer_count: layerCount,
        strong_photos: strongPhotos,
        rebuttal_count: rebuttals.length,
        score: evidenceScore,
      },
      financial: {
        gap_amount: gap,
        missing_items: missingItems,
        underpaid_items: underpaid,
        gap_ratio: Math.round(gapRatio * 100),
        score: financialScore,
      },
      strategy: {
        sim_count: simCount,
        top_score: topScore,
        evidence_complete: topStrategy?.required_missing_evidence?.length === 0,
        score: strategyScore,
      },
      rebuttal: {
        weak_arguments: weakArgs.length,
        contradictions: contradictions.length,
        rebuttals_available: rebuttals.length,
        score: rebuttalScore,
      },
      learning: {
        outcome_count: outcomeCount,
        feedback_positive: feedbackPos,
        feedback_negative: feedbackNeg,
        feedback_ratio: Math.round(feedbackRatio * 100),
        score: learningScore,
      },
      weights: WEIGHTS,
      overall: overall,
    },
  };
}

/** Detect what changed vs previous summary and produce a reason */
function detectChanges(
  previous: any | null,
  newAction: string | null,
  newIssue: string | null,
  newConfidence: number,
): { change_reason: string | null; change_details: Record<string, any> } {
  if (!previous) {
    return { change_reason: 'Initial intelligence summary generated', change_details: { type: 'initial' } };
  }

  const details: Record<string, any> = {};
  const reasons: string[] = [];

  const prevAction = previous.recommended_next_action?.action || null;
  if (prevAction && newAction && prevAction !== newAction) {
    reasons.push(`Recommended action changed from "${prevAction}" to "${newAction}"`);
    details.action_change = { from: prevAction, to: newAction };
  }

  const prevIssue = previous.most_important_issue || null;
  if (prevIssue && newIssue && prevIssue !== newIssue) {
    reasons.push('Priority issue updated');
    details.issue_change = { from: prevIssue?.slice(0, 120), to: newIssue?.slice(0, 120) };
  }

  const prevConf = previous.confidence_score || 0;
  const confDelta = newConfidence - prevConf;
  if (Math.abs(confDelta) >= 5) {
    reasons.push(`Confidence ${confDelta > 0 ? 'increased' : 'decreased'} by ${Math.abs(confDelta)} pts`);
    details.confidence_change = { from: prevConf, to: newConfidence, delta: confDelta };
  }

  if (reasons.length === 0) {
    reasons.push('Periodic refresh — no significant changes');
    details.type = 'refresh';
  }

  return { change_reason: reasons.join('; '), change_details: details };
}

// ── Valid trigger events ──
const VALID_TRIGGERS = new Set([
  'estimate_uploaded',
  'photo_analyzed',
  'document_analyzed',
  'argument_extracted',
  'strategy_simulated',
  'feedback_received',
  'outcome_recorded',
  'payment_received',
  'status_changed',
  'deadline_updated',
  'manual',
  'war_room_opened',
]);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const body = await req.json();
    const { claimId, triggerEvent, triggerMetadata } = body;
    if (!claimId) throw new Error('claimId required');

    // Validate trigger event if provided
    const trigger = triggerEvent && VALID_TRIGGERS.has(triggerEvent) ? triggerEvent : 'manual';

    // ── Gather ALL intelligence layers in parallel ──
    const [
      claimRes, estimateRes, photoRes, strategyRes,
      argumentRes, outcomeRes, feedbackRes, deadlinesRes, rebuttalsRes,
      previousRes,
    ] = await Promise.all([
      supabase.from('claims').select('*').eq('id', claimId).single(),
      supabase.from('claim_estimate_analysis').select('*').eq('claim_id', claimId).order('created_at', { ascending: false }).limit(3),
      supabase.from('claim_photo_findings').select('*').eq('claim_id', claimId),
      supabase.from('claim_strategy_simulations').select('*').eq('claim_id', claimId).order('score', { ascending: false }),
      supabase.from('claim_argument_map').select('*').eq('claim_id', claimId),
      supabase.from('claim_outcome_learning').select('*').limit(20),
      supabase.from('darwin_feedback_events').select('*').eq('claim_id', claimId).order('created_at', { ascending: false }).limit(50),
      supabase.from('claim_carrier_deadlines').select('*').eq('claim_id', claimId),
      supabase.from('carrier_argument_rebuttals').select('*').eq('claim_id', claimId),
      // Get the latest existing summary for change detection
      supabase.from('claim_intelligence_summary').select('*').eq('claim_id', claimId).order('version', { ascending: false }).limit(1).maybeSingle(),
    ]);

    const claim = claimRes.data;
    const carrier = claim?.insurance_company || 'Unknown';
    const estimates = estimateRes.data || [];
    const photos = photoRes.data || [];
    const strategies = strategyRes.data || [];
    const arguments_ = argumentRes.data || [];
    const outcomes = outcomeRes.data || [];
    const feedback = feedbackRes.data || [];
    const deadlines = deadlinesRes.data || [];
    const rebuttals = rebuttalsRes.data || [];
    const previousSummary = previousRes.data;

    // Cross-claim and carrier profile
    const [carrierOutcomesRes, carrierProfileRes] = await Promise.all([
      supabase.from('claim_outcome_learning').select('*').ilike('carrier', `%${carrier}%`).limit(10),
      supabase.from('carrier_behavior_profiles').select('*').ilike('carrier_name', `%${carrier}%`).limit(1),
    ]);
    const carrierOutcomes = carrierOutcomesRes.data || [];
    const carrierProfile = carrierProfileRes.data?.[0] || null;

    // ── Step 1: Deterministic pre-scoring ──
    const scored = computePreScores({
      estimates, photos, strategies, arguments_, rebuttals, carrierOutcomes, feedback, deadlines, claim,
    });

    // ── Pre-compute metrics for AI prompt context ──
    const strongPhotoEvidence = photos.filter((p: any) => p.evidence_strength === 'strong');
    const photoByType: Record<string, number> = {};
    photos.forEach((p: any) => { photoByType[p.finding_type] = (photoByType[p.finding_type] || 0) + 1; });
    const overdueDeadlines = deadlines.filter((d: any) => d.days_overdue && d.days_overdue > 0);
    const badFaithFlags = deadlines.filter((d: any) => d.bad_faith_potential);
    const topStrategy = strategies.find((s: any) => s.is_recommended) || strategies[0];
    const weakArguments = arguments_.filter((a: any) => (a.strength_score || 0) < 40);
    const contradictions = arguments_.filter((a: any) => a.contradictions && Array.isArray(a.contradictions) && a.contradictions.length > 0);

    // ── Build intelligence context for AI ──
    const intelligenceContext = {
      claim: {
        id: claim?.id, claim_number: claim?.claim_number, status: claim?.status,
        loss_type: claim?.loss_type, carrier, loss_date: claim?.loss_date,
        pa_estimate: claim?.pa_estimate_amount, carrier_estimate: claim?.carrier_estimate_amount,
        settlement: claim?.settlement_amount,
      },
      deterministic_scores: scored.pre_scores,
      estimate_intelligence: {
        analyses_count: estimates.length,
        latest_gap: estimates[0]?.total_gap_amount || null,
        missing_items: estimates[0]?.missing_items_count || 0,
        underpaid_items: estimates[0]?.underpaid_items_count || 0,
        supplement_recommendations: estimates[0]?.supplement_recommendations || [],
      },
      photo_intelligence: {
        total_findings: photos.length,
        strong_evidence_count: strongPhotoEvidence.length,
        findings_by_type: photoByType,
        top_findings: strongPhotoEvidence.slice(0, 5).map((p: any) => ({
          type: p.finding_type, description: p.description, purpose: p.claim_purpose,
        })),
      },
      strategy_intelligence: {
        simulations_count: strategies.length,
        recommended: topStrategy ? {
          type: topStrategy.strategy_type, score: topStrategy.score,
          action: topStrategy.recommended_action,
          recovery_delta: topStrategy.predicted_recovery_delta,
          timeline_days: topStrategy.predicted_timeline_days,
          risk: topStrategy.risk_level,
          missing_evidence: topStrategy.required_missing_evidence,
        } : null,
        all_scores: strategies.slice(0, 6).map((s: any) => ({
          type: s.strategy_type, score: s.score, risk: s.risk_level,
        })),
      },
      argument_intelligence: {
        total_arguments: arguments_.length,
        weak_arguments: weakArguments.length,
        contradictions_found: contradictions.length,
        weakest: weakArguments.slice(0, 3).map((a: any) => ({
          text: a.argument_text?.slice(0, 200), score: a.strength_score, gaps: a.evidence_gaps,
        })),
        contradiction_details: contradictions.slice(0, 3).map((a: any) => ({
          text: a.argument_text?.slice(0, 200), contradictions: a.contradictions,
        })),
        rebuttals_count: rebuttals.length,
      },
      deadline_intelligence: {
        total: deadlines.length, overdue: overdueDeadlines.length,
        bad_faith_flags: badFaithFlags.length,
        next_deadline: deadlines[0] ? {
          type: deadlines[0].deadline_type, date: deadlines[0].deadline_date,
          overdue: deadlines[0].days_overdue,
        } : null,
      },
      cross_claim_learning: {
        carrier_outcomes: carrierOutcomes.slice(0, 5).map((o: any) => ({
          outcome: o.outcome, recovery_delta: o.recovery_delta,
          winning_args: o.winning_arguments, turning_point: o.key_turning_point,
        })),
        carrier_profile: carrierProfile ? {
          supplement_approval_rate: carrierProfile.supplement_approval_rate,
          first_offer_ratio: carrierProfile.first_offer_vs_final_ratio,
          recommended_approach: carrierProfile.recommended_approach,
          denial_reasons: carrierProfile.typical_denial_reasons,
        } : null,
      },
      previous_summary: previousSummary ? {
        most_important_issue: previousSummary.most_important_issue,
        recommended_action: previousSummary.recommended_next_action?.action,
        confidence_score: previousSummary.confidence_score,
        version: previousSummary.version,
      } : null,
    };

    // ── Step 2: AI synthesis using pre-scores as anchoring context ──
    const systemPrompt = `You are the Darwin Intelligence Orchestrator — a synthesis engine that reads ALL intelligence layers for a claim and produces ONE ranked intelligence summary.

DETERMINISTIC PRE-SCORES (already computed — use these as anchoring constraints):
${JSON.stringify(scored.pre_scores, null, 2)}

INTELLIGENCE CONTEXT:
${JSON.stringify(intelligenceContext, null, 2).slice(0, 11000)}

PREVIOUS SUMMARY (if any):
${previousSummary ? `Version ${previousSummary.version}: "${previousSummary.most_important_issue}"` : 'None — this is the first summary.'}

Produce a JSON object with EXACTLY these fields:

{
  "most_important_issue": "Single sentence — #1 priority issue right now",
  "strongest_evidence": [
    {"type": "photo|estimate|document|deadline|rebuttal", "description": "...", "strength": "strong|moderate|weak", "how_to_use": "..."}
  ],
  "largest_recovery_opportunity": {
    "description": "...",
    "estimated_delta": 0,
    "strategy_required": "supplement|reinspection|appraisal|doi_complaint|litigation_referral|demand_letter",
    "evidence_needed": ["..."],
    "confidence_pct": 0
  },
  "carrier_weakest_argument": {
    "argument_summary": "...",
    "weakness_type": "contradiction|lack_of_evidence|procedural_error|bad_faith|misapplied_exclusion",
    "exploit_strategy": "...",
    "supporting_evidence": ["..."]
  },
  "recommended_next_action": {
    "action": "...",
    "priority": "critical|high|medium|low",
    "expected_impact": "...",
    "timeline_days": 0,
    "dependencies": ["..."]
  },
  "missing_evidence": [
    {"item": "...", "impact_if_obtained": "...", "difficulty": "easy|moderate|hard", "priority": "critical|high|medium|low"}
  ],
  "confidence_score": <MUST match the deterministic overall score: ${scored.overall_confidence}>,
  "confidence_factors": {
    "evidence_completeness": ${scored.evidence_confidence},
    "financial_strength": ${scored.financial_confidence},
    "strategy_alignment": ${scored.strategy_confidence},
    "rebuttal_readiness": ${scored.rebuttal_confidence},
    "learning_support": ${scored.learning_confidence},
    "overall_rationale": "..."
  }
}

RULES:
- confidence_score MUST equal ${scored.overall_confidence} (the deterministic pre-score). Do NOT override it.
- confidence_factors sub-scores are provided above. You MUST use them exactly. Only add overall_rationale.
- strongest_evidence: Max 5 items, ranked by usefulness
- missing_evidence: Max 5 items, ranked by impact
- All recommendations must cite specific intelligence from the context, never generic advice
- If contradictions exist in carrier arguments, that MUST be the carrier_weakest_argument
- If overdue deadlines or bad faith flags exist, those MUST factor into most_important_issue
- If this is not the first summary, explain what changed and why in overall_rationale

Return ONLY valid JSON.`;

    // ── Claims Knowledge Engine enrichment ──
    let knowledgePrefix = '';
    try {
      const bundle = await getClaimsContextBundle({
        claimId,
        userQuery: 'intelligence summary synthesis',
        taskType: 'copilot_reasoning',
        supabase,
      });
      knowledgePrefix = formatContextBundle(bundle);
      if (knowledgePrefix) {
        console.log(`[Orchestrator] Knowledge Engine: dispute=${bundle.disputeType}, knowledge=${bundle.retrievalMeta.knowledgeCount}, lessons=${bundle.retrievalMeta.lessonsCount}`);
      }
    } catch (e) {
      console.error('[Orchestrator] Knowledge Engine error (non-fatal):', e);
    }

    // ── Universal Dismantler intelligence ──
    let dismantlerPrefix = '';
    try {
      const { data: dismantlerResults } = await supabase
        .from('claim_document_dismantlers')
        .select('document_type, report_summary, main_position, strongest_rebuttal_points, contradictions, unsupported_assumptions, coverage_weaknesses, draft_rebuttal_language')
        .eq('claim_id', claimId)
        .order('created_at', { ascending: false })
        .limit(2);

      if (dismantlerResults && dismantlerResults.length > 0) {
        dismantlerPrefix = dismantlerResults.map((d: any) => formatDismantlerForPrompt({
          documentType: d.document_type,
          reportSummary: d.report_summary || '',
          mainPosition: d.main_position || '',
          nonCoveredTheories: [],
          limitations: [],
          unsupportedAssumptions: d.unsupported_assumptions || [],
          contradictions: d.contradictions || [],
          omissions: [],
          repairabilityOverreach: [],
          coverageWeaknesses: d.coverage_weaknesses || [],
          strongestRebuttalPoints: d.strongest_rebuttal_points || [],
          evidenceToGatherNext: [],
          draftRebuttalLanguage: d.draft_rebuttal_language || '',
          meta: { chunkCount: 0, successfulChunks: 0, failedChunks: 0, model: '', cached: false, usedSearch: false },
        })).join('\n\n');
        console.log(`[Orchestrator] Dismantler intelligence injected: ${dismantlerResults.length} analyses`);
      }
    } catch (e) {
      console.error('[Orchestrator] Dismantler context error (non-fatal):', e);
    }

    const aiResult = await generate({
      task: 'copilot_reasoning',
      system: (knowledgePrefix ? knowledgePrefix + '\n\n' : '') + (dismantlerPrefix ? dismantlerPrefix + '\n\n' : '') + systemPrompt,
      user: 'Synthesize all intelligence layers and produce the ranked intelligence summary.',
      claimId,
      forceStrong: true,
      searchMode: 'off',
      jsonMode: true,
      claimDataType: 'intelligence_summary',
    });

    console.log(`[darwin-intelligence-orchestrator] model=${aiResult.model}, usedSearch=${aiResult.usedSearch}, cached=${aiResult.cached}`);

    const rawContent = aiResult.text;

    let summary: any = {};
    try {
      const cleaned = rawContent.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) summary = JSON.parse(jsonMatch[0]);
    } catch { summary = {}; }

    // ── Step 3: Change detection ──
    const { change_reason, change_details } = detectChanges(
      previousSummary,
      summary.recommended_next_action?.action || null,
      summary.most_important_issue || null,
      scored.overall_confidence,
    );

    const nextVersion = (previousSummary?.version || 0) + 1;

    // ── Step 4: Persist versioned summary ──
    const insertData = {
      claim_id: claimId,
      version: nextVersion,
      previous_summary_id: previousSummary?.id || null,
      most_important_issue: summary.most_important_issue || null,
      strongest_evidence: summary.strongest_evidence || [],
      largest_recovery_opportunity: summary.largest_recovery_opportunity || {},
      carrier_weakest_argument: summary.carrier_weakest_argument || {},
      recommended_next_action: summary.recommended_next_action || {},
      missing_evidence: summary.missing_evidence || [],
      confidence_score: scored.overall_confidence,
      confidence_factors: {
        evidence_completeness: scored.evidence_confidence,
        financial_strength: scored.financial_confidence,
        strategy_alignment: scored.strategy_confidence,
        rebuttal_readiness: scored.rebuttal_confidence,
        learning_support: scored.learning_confidence,
        overall_rationale: summary.confidence_factors?.overall_rationale || '',
      },
      evidence_confidence: scored.evidence_confidence,
      financial_confidence: scored.financial_confidence,
      strategy_confidence: scored.strategy_confidence,
      rebuttal_confidence: scored.rebuttal_confidence,
      learning_confidence: scored.learning_confidence,
      pre_scores: scored.pre_scores,
      change_reason,
      change_details,
      trigger_event: trigger,
      trigger_metadata: triggerMetadata || {},
      intelligence_sources: {
        estimates: estimates.length,
        photos: photos.length,
        strategies: strategies.length,
        arguments: arguments_.length,
        rebuttals: rebuttals.length,
        outcomes: carrierOutcomes.length,
        feedback: feedback.length,
        deadlines: deadlines.length,
      },
      raw_summary: rawContent.slice(0, 10000),
      updated_at: new Date().toISOString(),
    };

    await supabase.from('claim_intelligence_summary').insert(insertData);

    return new Response(JSON.stringify({
      success: true,
      version: nextVersion,
      change_reason,
      confidence: {
        overall: scored.overall_confidence,
        evidence: scored.evidence_confidence,
        financial: scored.financial_confidence,
        strategy: scored.strategy_confidence,
        rebuttal: scored.rebuttal_confidence,
        learning: scored.learning_confidence,
      },
      summary,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('darwin-intelligence-orchestrator error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
