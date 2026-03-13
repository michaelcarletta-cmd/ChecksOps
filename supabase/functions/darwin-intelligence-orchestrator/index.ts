import { createClient } from "npm:@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY not configured');

    const { claimId } = await req.json();
    if (!claimId) throw new Error('claimId required');

    // Gather ALL intelligence layers in parallel
    const [
      claimRes,
      estimateRes,
      photoRes,
      strategyRes,
      argumentRes,
      outcomeRes,
      feedbackRes,
      deadlinesRes,
      rebuttalsRes,
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
    ]);

    const claim = claimRes.data;
    const carrier = claim?.insurance_company || 'Unknown';

    // Cross-claim outcomes for this carrier
    const { data: carrierOutcomes } = await supabase
      .from('claim_outcome_learning')
      .select('*')
      .ilike('carrier', `%${carrier}%`)
      .limit(10);

    // Carrier behavior profile
    const { data: carrierProfile } = await supabase
      .from('carrier_behavior_profiles')
      .select('*')
      .ilike('carrier_name', `%${carrier}%`)
      .limit(1);

    // Build intelligence context
    const estimates = estimateRes.data || [];
    const photos = photoRes.data || [];
    const strategies = strategyRes.data || [];
    const arguments_ = argumentRes.data || [];
    const outcomes = outcomeRes.data || [];
    const feedback = feedbackRes.data || [];
    const deadlines = deadlinesRes.data || [];
    const rebuttals = rebuttalsRes.data || [];

    // Pre-compute metrics for the AI
    const strongPhotoEvidence = photos.filter((p: any) => p.evidence_strength === 'strong');
    const photoByType: Record<string, number> = {};
    photos.forEach((p: any) => { photoByType[p.finding_type] = (photoByType[p.finding_type] || 0) + 1; });

    const overdueDeadlines = deadlines.filter((d: any) => d.days_overdue && d.days_overdue > 0);
    const badFaithFlags = deadlines.filter((d: any) => d.bad_faith_potential);

    const topStrategy = strategies.find((s: any) => s.is_recommended) || strategies[0];

    const estimateGap = estimates[0]?.total_gap_amount || null;
    const missingItems = estimates[0]?.missing_items_count || 0;
    const underpaidItems = estimates[0]?.underpaid_items_count || 0;

    const weakArguments = arguments_.filter((a: any) => (a.strength_score || 0) < 40);
    const contradictions = arguments_.filter((a: any) => a.contradictions && Array.isArray(a.contradictions) && a.contradictions.length > 0);

    const feedbackPositive = feedback.filter((f: any) => f.feedback_type === 'thumbs_up').length;
    const feedbackNegative = feedback.filter((f: any) => f.feedback_type === 'thumbs_down').length;

    const intelligenceContext = {
      claim: {
        id: claim?.id,
        claim_number: claim?.claim_number,
        status: claim?.status,
        loss_type: claim?.loss_type,
        carrier,
        loss_date: claim?.loss_date,
        pa_estimate: claim?.pa_estimate_amount,
        carrier_estimate: claim?.carrier_estimate_amount,
        settlement: claim?.settlement_amount,
      },
      estimate_intelligence: {
        analyses_count: estimates.length,
        latest_gap: estimateGap,
        missing_items: missingItems,
        underpaid_items: underpaidItems,
        supplement_recommendations: estimates[0]?.supplement_recommendations || [],
      },
      photo_intelligence: {
        total_findings: photos.length,
        strong_evidence_count: strongPhotoEvidence.length,
        findings_by_type: photoByType,
        top_findings: strongPhotoEvidence.slice(0, 5).map((p: any) => ({
          type: p.finding_type,
          description: p.description,
          purpose: p.claim_purpose,
        })),
      },
      strategy_intelligence: {
        simulations_count: strategies.length,
        recommended: topStrategy ? {
          type: topStrategy.strategy_type,
          score: topStrategy.score,
          action: topStrategy.recommended_action,
          recovery_delta: topStrategy.predicted_recovery_delta,
          timeline_days: topStrategy.predicted_timeline_days,
          risk: topStrategy.risk_level,
          missing_evidence: topStrategy.required_missing_evidence,
        } : null,
        all_scores: strategies.slice(0, 6).map((s: any) => ({
          type: s.strategy_type,
          score: s.score,
          risk: s.risk_level,
        })),
      },
      argument_intelligence: {
        total_arguments: arguments_.length,
        weak_arguments: weakArguments.length,
        contradictions_found: contradictions.length,
        weakest: weakArguments.slice(0, 3).map((a: any) => ({
          text: a.argument_text?.slice(0, 200),
          score: a.strength_score,
          gaps: a.evidence_gaps,
        })),
        contradiction_details: contradictions.slice(0, 3).map((a: any) => ({
          text: a.argument_text?.slice(0, 200),
          contradictions: a.contradictions,
        })),
        rebuttals_count: rebuttals.length,
      },
      deadline_intelligence: {
        total: deadlines.length,
        overdue: overdueDeadlines.length,
        bad_faith_flags: badFaithFlags.length,
        next_deadline: deadlines[0] ? {
          type: deadlines[0].deadline_type,
          date: deadlines[0].deadline_date,
          overdue: deadlines[0].days_overdue,
        } : null,
      },
      cross_claim_learning: {
        carrier_outcomes: (carrierOutcomes || []).slice(0, 5).map((o: any) => ({
          outcome: o.outcome,
          recovery_delta: o.recovery_delta,
          winning_args: o.winning_arguments,
          turning_point: o.key_turning_point,
        })),
        carrier_profile: carrierProfile?.[0] ? {
          supplement_approval_rate: carrierProfile[0].supplement_approval_rate,
          first_offer_ratio: carrierProfile[0].first_offer_vs_final_ratio,
          recommended_approach: carrierProfile[0].recommended_approach,
          denial_reasons: carrierProfile[0].typical_denial_reasons,
        } : null,
      },
      feedback_history: {
        positive: feedbackPositive,
        negative: feedbackNegative,
        total: feedback.length,
      },
    };

    const systemPrompt = `You are the Darwin Intelligence Orchestrator — a synthesis engine that reads ALL intelligence layers for a claim and produces ONE ranked intelligence summary.

INTELLIGENCE CONTEXT:
${JSON.stringify(intelligenceContext, null, 2).slice(0, 12000)}

Analyze ALL intelligence layers and produce a JSON object with EXACTLY these fields:

{
  "most_important_issue": "Single sentence describing the #1 priority issue right now",
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
  "confidence_score": 0,
  "confidence_factors": {
    "evidence_completeness": 0,
    "similar_claim_support": 0,
    "feedback_quality": 0,
    "strategy_alignment": 0,
    "overall_rationale": "..."
  }
}

RULES:
- strongest_evidence: Max 5 items, ranked by usefulness
- missing_evidence: Max 5 items, ranked by impact
- confidence_score: 0-100, weighted: evidence_completeness (40%), similar_claim_support (25%), feedback_quality (15%), strategy_alignment (20%)
- All recommendations must cite specific intelligence from the context, never generic advice
- If contradictions exist in carrier arguments, that MUST be the carrier_weakest_argument
- If overdue deadlines or bad faith flags exist, those MUST factor into most_important_issue

Return ONLY valid JSON.`;

    const aiResp = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Synthesize all intelligence layers and produce the ranked intelligence summary.' },
        ],
      }),
    });

    if (!aiResp.ok) throw new Error(`AI gateway error ${aiResp.status}`);

    const aiData = await aiResp.json();
    const rawContent = aiData.choices?.[0]?.message?.content || '';

    let summary: any = {};
    try {
      const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) summary = JSON.parse(jsonMatch[0]);
    } catch { summary = {}; }

    // Upsert the intelligence summary
    const upsertData = {
      claim_id: claimId,
      most_important_issue: summary.most_important_issue || null,
      strongest_evidence: summary.strongest_evidence || [],
      largest_recovery_opportunity: summary.largest_recovery_opportunity || {},
      carrier_weakest_argument: summary.carrier_weakest_argument || {},
      recommended_next_action: summary.recommended_next_action || {},
      missing_evidence: summary.missing_evidence || [],
      confidence_score: summary.confidence_score || 0,
      confidence_factors: summary.confidence_factors || {},
      intelligence_sources: {
        estimates: estimates.length,
        photos: photos.length,
        strategies: strategies.length,
        arguments: arguments_.length,
        rebuttals: rebuttals.length,
        outcomes: (carrierOutcomes || []).length,
        feedback: feedback.length,
        deadlines: deadlines.length,
      },
      raw_summary: rawContent.slice(0, 10000),
      updated_at: new Date().toISOString(),
    };

    // Try update first, insert if not exists
    const { data: existing } = await supabase
      .from('claim_intelligence_summary')
      .select('id')
      .eq('claim_id', claimId)
      .maybeSingle();

    if (existing) {
      await supabase.from('claim_intelligence_summary').update(upsertData).eq('claim_id', claimId);
    } else {
      await supabase.from('claim_intelligence_summary').insert(upsertData);
    }

    return new Response(JSON.stringify({ success: true, summary }), {
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
