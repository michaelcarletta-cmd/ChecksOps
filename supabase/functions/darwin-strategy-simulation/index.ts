import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { callOpenAIText } from "../_shared/ai-router.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const STRATEGY_TYPES = ['supplement', 'reinspection', 'appraisal', 'doi_complaint', 'litigation_referral', 'demand_letter'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    // AI routing handled by _shared/ai-router.ts

    const { claimId } = await req.json();
    if (!claimId) throw new Error('claimId required');

    // Gather all claim intelligence
    const [claimRes, filesRes, estimateRes, argsRes, rebuttalsRes, timelinesRes, outcomesRes, deadlinesRes] = await Promise.all([
      supabase.from('claims').select('*').eq('id', claimId).single(),
      supabase.from('claim_files').select('id, file_name, document_type, folder_key').eq('claim_id', claimId),
      supabase.from('claim_estimate_analysis').select('*').eq('claim_id', claimId).order('created_at', { ascending: false }).limit(1),
      supabase.from('claim_argument_map').select('*').eq('claim_id', claimId),
      supabase.from('carrier_argument_rebuttals').select('*').eq('claim_id', claimId),
      supabase.from('claim_timeline_events').select('*').eq('claim_id', claimId).order('occurred_at', { ascending: true }),
      supabase.from('claim_outcome_learning').select('*').eq('carrier', '').limit(20), // cross-claim
      supabase.from('claim_carrier_deadlines').select('*').eq('claim_id', claimId),
    ]);

    const claim = claimRes.data;
    const carrier = claim?.insurance_company || 'Unknown';

    // Get cross-claim outcomes for this carrier
    const { data: carrierOutcomes } = await supabase
      .from('claim_outcome_learning')
      .select('*')
      .ilike('carrier', `%${carrier}%`)
      .limit(15);

    // Get carrier behavior profile
    const { data: carrierProfile } = await supabase
      .from('carrier_behavior_profiles')
      .select('*')
      .ilike('carrier_name', `%${carrier}%`)
      .limit(1);

    const claimFacts = {
      claim: claim,
      files_count: (filesRes.data || []).length,
      file_types: [...new Set((filesRes.data || []).map((f: any) => f.document_type).filter(Boolean))],
      estimate_analysis: estimateRes.data?.[0] || null,
      carrier_arguments: (argsRes.data || []).length,
      rebuttals: (rebuttalsRes.data || []).length,
      timeline_events: (timelinesRes.data || []).length,
      deadlines: deadlinesRes.data || [],
      carrier_profile: carrierProfile?.[0] || null,
      cross_claim_outcomes: (carrierOutcomes || []).slice(0, 5),
    };

    const systemPrompt = `You are Darwin War Room Strategy Engine — a decision-scoring system for insurance claim strategy.

CLAIM FACTS:
${JSON.stringify(claimFacts, null, 2).slice(0, 8000)}

Score EACH of these possible next moves: ${STRATEGY_TYPES.join(', ')}

For EACH strategy, evaluate:
1. Likelihood of success given current evidence completeness
2. Predicted recovery delta (additional $ expected)
3. Predicted timeline in days
4. What evidence is still missing to execute this strategy
5. Risk level (low/medium/high)
6. Clear rationale citing specific claim facts

OUTPUT (JSON array — one object per strategy):
[{
  "strategy_type": "",
  "score": 0,
  "recommended_action": "",
  "predicted_recovery_delta": 0,
  "predicted_timeline_days": 0,
  "required_missing_evidence": [""],
  "rationale": "",
  "evidence_completeness_pct": 0,
  "carrier_behavior_factors": {},
  "cross_claim_support": {},
  "risk_level": "low|medium|high",
  "is_recommended": false
}]

Mark the BEST strategy as is_recommended: true. Return ONLY valid JSON array.`;

    const aiResult = await callOpenAIText({
      system: systemPrompt,
      user: 'Score all strategy options and return the ranked results.',
      reasoningEffort: 'high',
      temperature: 0.2,
      maxOutputTokens: 3500,
    });

    const rawContent = aiResult.text || '';
    
    let strategies: any[] = [];
    try {
      const jsonMatch = rawContent.match(/\[[\s\S]*\]/);
      if (jsonMatch) strategies = JSON.parse(jsonMatch[0]);
    } catch { strategies = []; }

    // Clear old simulations and store new ones
    await supabase.from('claim_strategy_simulations').delete().eq('claim_id', claimId);

    const inserts = strategies.map((s: any) => ({
      claim_id: claimId,
      strategy_type: s.strategy_type || 'unknown',
      score: s.score || 0,
      recommended_action: s.recommended_action || '',
      predicted_recovery_delta: s.predicted_recovery_delta || null,
      predicted_timeline_days: s.predicted_timeline_days || null,
      required_missing_evidence: s.required_missing_evidence || [],
      rationale: s.rationale || '',
      claim_facts_snapshot: claimFacts,
      evidence_completeness_pct: s.evidence_completeness_pct || null,
      carrier_behavior_factors: s.carrier_behavior_factors || {},
      cross_claim_support: s.cross_claim_support || {},
      risk_level: s.risk_level || null,
      is_recommended: s.is_recommended || false,
    }));

    if (inserts.length > 0) {
      await supabase.from('claim_strategy_simulations').insert(inserts);
    }

    return new Response(JSON.stringify({ success: true, strategies }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('darwin-strategy-simulation error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
