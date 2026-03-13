import { createClient } from "npm:@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

type CopilotMode = 'operational' | 'rebuttal' | 'estimate' | 'war_room' | 'training';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY not configured');

    const { claimId, mode, userQuestion } = await req.json();
    if (!claimId) throw new Error('claimId required');

    const copilotMode: CopilotMode = mode || 'operational';

    // Gather full claim intelligence in parallel
    const [
      claimRes, filesRes, estimateRes, photoRes, strategyRes, argsRes, 
      rebuttalsRes, deadlinesRes, outcomesRes, knowledgeRes, intelSummaryRes
    ] = await Promise.all([
      supabase.from('claims').select('*').eq('id', claimId).single(),
      supabase.from('claim_files').select('id, file_name, document_type, folder_key, created_at').eq('claim_id', claimId),
      supabase.from('claim_estimate_analysis').select('*').eq('claim_id', claimId).order('created_at', { ascending: false }).limit(1),
      supabase.from('claim_photo_findings').select('*').eq('claim_id', claimId),
      supabase.from('claim_strategy_simulations').select('*').eq('claim_id', claimId).order('score', { ascending: false }),
      supabase.from('claim_argument_map').select('*').eq('claim_id', claimId),
      supabase.from('carrier_argument_rebuttals').select('*').eq('claim_id', claimId),
      supabase.from('claim_carrier_deadlines').select('*').eq('claim_id', claimId),
      supabase.from('claim_outcome_learning').select('*').ilike('carrier', `%${''}`).limit(10),
      supabase.from('ai_knowledge_chunks').select('content').limit(15),
      supabase.from('claim_intelligence_summary').select('*').eq('claim_id', claimId).maybeSingle(),
    ]);

    const claim = claimRes.data;
    const carrier = claim?.insurance_company || 'Unknown';

    // Get carrier-specific outcomes
    const { data: carrierOutcomes } = await supabase
      .from('claim_outcome_learning')
      .select('outcome, recovery_delta, winning_arguments, key_turning_point')
      .ilike('carrier', `%${carrier}%`)
      .limit(10);

    const claimIntel = {
      claim,
      files: (filesRes.data || []).length,
      estimate_analysis: estimateRes.data?.[0] || null,
      photo_findings: {
        total: (photoRes.data || []).length,
        by_type: {} as Record<string, number>,
        strong_evidence: (photoRes.data || []).filter((f: any) => f.evidence_strength === 'strong').length,
      },
      strategy_simulations: (strategyRes.data || []).slice(0, 3),
      carrier_arguments: (argsRes.data || []).length,
      rebuttals: (rebuttalsRes.data || []).length,
      deadlines: deadlinesRes.data || [],
      carrier_outcomes: carrierOutcomes || [],
    };

    // Count photo findings by type
    (photoRes.data || []).forEach((f: any) => {
      claimIntel.photo_findings.by_type[f.finding_type] = (claimIntel.photo_findings.by_type[f.finding_type] || 0) + 1;
    });

    const trainingKb = (knowledgeRes.data || []).map((c: any) => c.content).join('\n---\n').slice(0, 4000);

    const modeInstructions: Record<CopilotMode, string> = {
      operational: `Focus on claim operations: status, next steps, pending tasks, deadlines, missing documentation.`,
      rebuttal: `Focus on carrier arguments, contradictions, evidence gaps, and rebuttal strategies. Reference specific carrier positions and counter them.`,
      estimate: `Focus on estimate gaps, supplement opportunities, pricing disparities, code upgrades, and O&P analysis.`,
      war_room: `Focus on strategic options: which strategy scores highest, predicted outcomes, risk levels, and recommended next moves based on cross-claim learning.`,
      training: `Reference training materials and knowledge base to educate the user on best practices, techniques, and approaches relevant to this claim scenario.`,
    };

    const systemPrompt = `You are Darwin Copilot — an embedded intelligence assistant for public adjusters.

MODE: ${copilotMode.toUpperCase()}
${modeInstructions[copilotMode]}

CLAIM INTELLIGENCE:
${JSON.stringify(claimIntel, null, 2).slice(0, 10000)}

TRAINING KNOWLEDGE:
${trainingKb}

EVERY response MUST answer these 5 questions:
1. **What matters most right now?** — The single highest-priority item
2. **What is missing?** — Evidence, documents, or analysis gaps
3. **What should happen next?** — Specific actionable next step
4. **What is the carrier's weak point?** — Exploitable weakness in their position
5. **What action or letter does Darwin recommend NOW?** — Concrete deliverable

Be direct, strategic, and cite specific evidence from the claim intelligence. Never use generic advice.
Format with clear headers and bullet points.`;

    // Support streaming
    const aiResp = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userQuestion || `Give me the full Darwin Copilot briefing for this claim in ${copilotMode} mode.` },
        ],
        stream: true,
      }),
    });

    if (!aiResp.ok) {
      if (aiResp.status === 429) {
        return new Response(JSON.stringify({ error: 'Rate limit exceeded, please try again shortly.' }), {
          status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (aiResp.status === 402) {
        return new Response(JSON.stringify({ error: 'Credits required. Add funds in Settings → Workspace → Usage.' }), {
          status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`AI gateway error ${aiResp.status}`);
    }

    return new Response(aiResp.body, {
      headers: { ...corsHeaders, 'Content-Type': 'text/event-stream' },
    });
  } catch (err: any) {
    console.error('darwin-copilot error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
