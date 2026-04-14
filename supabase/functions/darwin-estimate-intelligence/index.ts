import { createClient } from "npm:@supabase/supabase-js@2.39.3";
import { generate } from "../_shared/ai/generate.ts";

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

    const { claimId, carrierEstimateText, contractorEstimateText, carrierFileId, contractorFileId } = await req.json();
    if (!claimId) throw new Error('claimId required');

    // Gather claim context
    const { data: claim } = await supabase.from('claims').select('*').eq('id', claimId).single();
    const { data: knowledgeChunks } = await supabase
      .from('ai_knowledge_chunks')
      .select('content')
      .limit(10);

    const trainingContext = (knowledgeChunks || []).map((c: any) => c.content).join('\n---\n');

    const systemPrompt = `You are Darwin Estimate Intelligence Engine — a forensic estimate analyst for a public adjusting firm.

TRAINING KNOWLEDGE:
${trainingContext.slice(0, 4000)}

CLAIM CONTEXT:
- Claim: ${claim?.claim_number || claimId}
- Carrier: ${claim?.insurance_company || 'Unknown'}
- Loss Type: ${claim?.damage_type || 'Unknown'}
- State: ${claim?.state || 'Unknown'}

ANALYSIS REQUIREMENTS:
1. SCOPE GAPS: Line items present in contractor estimate but missing from carrier estimate
2. QUANTITY GAPS: Same item, different quantities — cite measurement basis
3. PRICING GAPS: Below-market labor rates, material pricing, unit cost differences
4. CODE UPGRADE GAPS: Required code upgrades carrier omitted (cite specific codes)
5. O&P GAPS: Missing overhead & profit, trade coordination needs
6. SUPPLEMENT RECOMMENDATIONS: Prioritized list of items to supplement with dollar impact
7. REBUTTAL NARRATIVE: Carrier-ready language explaining each gap with citations

OUTPUT FORMAT (JSON):
{
  "carrier_total": number,
  "contractor_total": number,
  "recommended_total": number,
  "difference": number,
  "scope_gaps": [{"item": "", "category": "", "amount": null, "evidence": ""}],
  "quantity_gaps": [{"item": "", "carrier_qty": 0, "correct_qty": 0, "basis": ""}],
  "pricing_gaps": [{"item": "", "carrier_rate": 0, "market_rate": 0, "source": ""}],
  "code_upgrade_gaps": [{"code_ref": "", "requirement": "", "missing_from": "carrier"}],
  "op_gaps": [{"trade": "", "basis": "", "amount": null}],
  "supplement_recommendations": [{"priority": 1, "item": "", "amount": null, "justification": ""}],
  "rebuttal_narrative": "",
  "confidence_score": 0
}`;

    const userPrompt = `Analyze these two estimates and produce the structured comparison:

CARRIER ESTIMATE:
${(carrierEstimateText || 'Not provided').slice(0, 15000)}

CONTRACTOR/FREEDOM ESTIMATE:
${(contractorEstimateText || 'Not provided').slice(0, 15000)}

Return ONLY valid JSON matching the required format.`;

    const aiResult = await generate({
      task: 'estimate_analysis',
      system: systemPrompt,
      user: userPrompt,
      claimId,
      searchMode: 'off',
      jsonMode: true,
    });

    console.log(`[darwin-estimate-intelligence] model=${aiResult.model}, usedSearch=${aiResult.usedSearch}, cached=${aiResult.cached}`);

    const rawContent = aiResult.text;
    
    // Parse JSON from response
    let parsed: any = {};
    try {
      const cleaned = rawContent.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch { parsed = { rebuttal_narrative: rawContent }; }

    // Store in claim_estimate_analysis
    await supabase.from('claim_estimate_analysis').insert({
      claim_id: claimId,
      analysis_type: 'comparison',
      carrier_estimate_file_id: carrierFileId || null,
      contractor_estimate_file_id: contractorFileId || null,
      carrier_total: parsed.carrier_total || null,
      contractor_total: parsed.contractor_total || null,
      darwin_recommended_total: parsed.recommended_total || null,
      difference_amount: parsed.difference || null,
      scope_gaps: parsed.scope_gaps || [],
      quantity_gaps: parsed.quantity_gaps || [],
      pricing_gaps: parsed.pricing_gaps || [],
      code_upgrade_gaps: parsed.code_upgrade_gaps || [],
      op_gaps: parsed.op_gaps || [],
      supplement_recommendations: parsed.supplement_recommendations || [],
      rebuttal_narrative: parsed.rebuttal_narrative || null,
      structured_findings: parsed,
      confidence_score: parsed.confidence_score || null,
    });

    return new Response(JSON.stringify({ success: true, analysis: parsed }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('darwin-estimate-intelligence error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
