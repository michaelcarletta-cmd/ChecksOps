import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

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
    // AI routing handled by shared layer (no API key needed here)

    const { action, claimId, outcomeData, queryParams } = await req.json();

    if (action === 'record_outcome') {
      // Record a claim outcome for learning
      if (!claimId) throw new Error('claimId required');

      const { data: claim } = await supabase.from('claims').select('*').eq('id', claimId).single();
      
      // Gather strategy data from this claim
      const { data: args } = await supabase.from('claim_argument_map').select('argument_type, rebuttal_strategies, rebuttal_confidence').eq('claim_id', claimId);
      const { data: strategies } = await supabase.from('claim_strategy_simulations').select('strategy_type, score, is_recommended').eq('claim_id', claimId);
      const { data: feedback } = await supabase.from('darwin_feedback_events').select('output_type, feedback_type, actual_outcome').eq('claim_id', claimId);

      const winningArgs = (args || [])
        .filter((a: any) => (a.rebuttal_confidence || 0) > 60)
        .map((a: any) => ({
          argument_type: a.argument_type,
          summary: a.rebuttal_strategies?.[0]?.strategy || '',
          evidence_used: a.rebuttal_strategies?.[0]?.citations || [],
        }));

      const strategySequence = (strategies || []).map((s: any, i: number) => ({
        step: i + 1,
        action: s.strategy_type,
        result: s.is_recommended ? 'recommended' : 'alternative',
        days_elapsed: null,
      }));

      await supabase.from('claim_outcome_learning').insert({
        claim_id: claimId,
        carrier: claim?.insurance_company || null,
        state_code: claim?.state || null,
        loss_type: claim?.damage_type || null,
        denial_rationale: outcomeData?.denial_rationale || null,
        outcome: outcomeData?.outcome || 'unknown',
        resolution_timeline_days: outcomeData?.resolution_timeline_days || null,
        initial_carrier_offer: outcomeData?.initial_carrier_offer || null,
        final_settlement: outcomeData?.final_settlement || null,
        recovery_delta: outcomeData?.recovery_delta || null,
        winning_arguments: winningArgs,
        evidence_patterns: outcomeData?.evidence_patterns || [],
        strategy_sequence: strategySequence,
        key_turning_point: outcomeData?.key_turning_point || null,
        lessons_learned: outcomeData?.lessons_learned || null,
        reusable_language: outcomeData?.reusable_language || [],
        tags: outcomeData?.tags || [],
      });

      return new Response(JSON.stringify({ success: true, action: 'outcome_recorded' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'query_similar') {
      // Find similar past outcomes for strategy recommendations
      const { carrier, loss_type, state_code, denial_rationale } = queryParams || {};

      let query = supabase.from('claim_outcome_learning').select('*');
      if (carrier) query = query.ilike('carrier', `%${carrier}%`);
      if (loss_type) query = query.ilike('loss_type', `%${loss_type}%`);
      if (state_code) query = query.eq('state_code', state_code);
      
      const { data: outcomes } = await query.order('created_at', { ascending: false }).limit(20);

      // Summarize patterns
      const totalOutcomes = (outcomes || []).length;
      const wins = (outcomes || []).filter((o: any) => o.outcome === 'won' || o.outcome === 'settled').length;
      const avgRecovery = totalOutcomes > 0
        ? (outcomes || []).reduce((sum: number, o: any) => sum + (o.recovery_delta || 0), 0) / totalOutcomes
        : 0;

      return new Response(JSON.stringify({
        success: true,
        summary: {
          total_similar: totalOutcomes,
          win_rate: totalOutcomes > 0 ? (wins / totalOutcomes * 100).toFixed(1) : 0,
          avg_recovery_delta: avgRecovery,
          outcomes: outcomes || [],
        },
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'record_feedback') {
      // Record feedback on a Darwin output
      const { outputType, outputId, feedbackType, feedbackDetail, actualOutcome, actualRecoveryDelta, userId } = outcomeData || {};

      await supabase.from('darwin_feedback_events').insert({
        claim_id: claimId || null,
        output_type: outputType || 'unknown',
        output_id: outputId || null,
        feedback_type: feedbackType || 'thumbs_up',
        feedback_detail: feedbackDetail || null,
        actual_outcome: actualOutcome || null,
        actual_recovery_delta: actualRecoveryDelta || null,
        user_id: userId || null,
      });

      return new Response(JSON.stringify({ success: true, action: 'feedback_recorded' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    throw new Error('Invalid action. Use: record_outcome, query_similar, record_feedback');
  } catch (err: any) {
    console.error('darwin-cross-claim-learning error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
