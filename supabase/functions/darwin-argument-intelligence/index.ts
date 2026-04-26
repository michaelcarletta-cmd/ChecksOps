import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { generate, callVision, MODEL_CHEAP, MODEL_STRONG } from "../_shared/ai/generate.ts";

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

    const { claimId, documentText, sourceFileId, sourceFileName } = await req.json();
    if (!claimId || !documentText) throw new Error('claimId and documentText required');

    console.log(`[darwin-argument-intelligence] claimId=${claimId}, model=${MODEL_CHEAP}`);

    const { data: claim } = await supabase.from('claims').select('*').eq('id', claimId).single();

    // Get knowledge base for citations
    const { data: knowledgeChunks } = await supabase
      .from('ai_knowledge_chunks')
      .select('id, content')
      .limit(20);

    const kbContext = (knowledgeChunks || []).map((c: any) => `[KB-${c.id.slice(0,8)}]: ${c.content.slice(0, 300)}`).join('\n');

    // Get existing photo findings for evidence linking
    const { data: photoFindings } = await supabase
      .from('claim_photo_findings')
      .select('finding_type, damage_description, evidence_strength, carrier_contradiction')
      .eq('claim_id', claimId)
      .limit(20);

    const systemPrompt = `You are Darwin Argument Intelligence — an expert at extracting, classifying, and dismantling carrier arguments from insurance documents.

CLAIM: ${claim?.claim_number || claimId}
CARRIER: ${claim?.insurance_company || 'Unknown'}
LOSS TYPE: ${claim?.damage_type || 'Unknown'}
STATE: ${claim?.state || 'Unknown'}

PHOTO EVIDENCE ON FILE:
${(photoFindings || []).map((f: any) => `- ${f.finding_type}: ${f.damage_description} (${f.evidence_strength})`).join('\n') || 'None analyzed yet'}

KNOWLEDGE BASE (for citations):
${kbContext.slice(0, 4000)}

TASK: Extract EVERY distinct carrier argument from the document below. For each:
1. Classify the argument type
2. Identify contradictions with other evidence on file
3. Identify evidence gaps that would strengthen our position
4. Generate ranked rebuttal strategies with draft language
5. Link to knowledge base citations where applicable

ARGUMENT TYPES: coverage_denial, scope_reduction, causation_dispute, pricing_dispute, exclusion, maintenance_defense, engineering_opinion, procedural

OUTPUT (JSON array):
[{
  "argument_text": "",
  "argument_type": "",
  "argument_category": "policy|technical|procedural|factual",
  "carrier_position_summary": "",
  "contradictions": [{"with_doc": "", "with_statement": "", "explanation": ""}],
  "evidence_gaps": [{"what_missing": "", "why_needed": "", "where_to_find": ""}],
  "rebuttal_strategies": [{"rank": 1, "strategy": "", "draft_language": "", "citations": [], "strength": 0}],
  "supporting_citations": [{"source": "", "text": "", "relevance": ""}],
  "knowledge_base_refs": [{"chunk_id": "", "content_preview": "", "relevance": ""}],
  "strength_score": 0,
  "rebuttal_confidence": 0
}]

Return ONLY valid JSON array.`;

    const result = await generate({
      task: "rebuttal",
      system: systemPrompt,
      user: `Extract and analyze all carrier arguments from this document:\n\n${documentText.slice(0, 20000)}`,
      claimId,
      searchMode: "off",
    });

    console.log(`[darwin-argument-intelligence] model=${result.model}, usedSearch=${result.usedSearch}, cached=${result.cached}`);

    const rawContent = result.text;
    
    let arguments_found: any[] = [];
    try {
      const jsonMatch = rawContent.match(/\[[\s\S]*\]/);
      if (jsonMatch) arguments_found = JSON.parse(jsonMatch[0]);
    } catch { arguments_found = []; }

    // Store each argument
    const inserts = arguments_found.map((a: any) => ({
      claim_id: claimId,
      source_file_id: sourceFileId || null,
      source_file_name: sourceFileName || null,
      argument_text: a.argument_text || '',
      argument_type: a.argument_type || 'other',
      argument_category: a.argument_category || null,
      carrier_position_summary: a.carrier_position_summary || null,
      contradictions: a.contradictions || [],
      evidence_gaps: a.evidence_gaps || [],
      rebuttal_strategies: a.rebuttal_strategies || [],
      supporting_citations: a.supporting_citations || [],
      knowledge_base_refs: a.knowledge_base_refs || [],
      strength_score: a.strength_score || null,
      rebuttal_confidence: a.rebuttal_confidence || null,
    }));

    if (inserts.length > 0) {
      await supabase.from('claim_argument_map').insert(inserts);
    }

    return new Response(JSON.stringify({ success: true, arguments_count: arguments_found.length, arguments: arguments_found }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('darwin-argument-intelligence error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
