import { createClient } from "npm:@supabase/supabase-js@2.39.3";
import { callVision, MODEL_VISION } from "../_shared/ai/generate.ts";

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

    const { claimId, photoBase64, photoUrl, photoId, analysisContext } = await req.json();
    if (!claimId) throw new Error('claimId required');

    console.log(`[darwin-photo-intelligence] claimId=${claimId}, model=${MODEL_VISION}`);

    const { data: claim } = await supabase.from('claims').select('*').eq('id', claimId).single();

    // Get existing carrier arguments for contradiction detection
    const { data: carrierArgs } = await supabase
      .from('carrier_argument_rebuttals')
      .select('carrier_position, argument_type')
      .eq('claim_id', claimId)
      .limit(10);

    const carrierPositions = (carrierArgs || []).map((a: any) => `- ${a.argument_type}: ${a.carrier_position}`).join('\n');

    const systemPrompt = `You are Darwin Photo Intelligence — a forensic damage analyst for property insurance claims.

CLAIM: ${claim?.claim_number || claimId}
LOSS TYPE: ${claim?.damage_type || 'Unknown'}
CARRIER: ${claim?.insurance_company || 'Unknown'}

CARRIER POSITIONS TO CHECK AGAINST:
${carrierPositions || 'None detected yet'}

For each photo, extract ALL claim-useful findings across these categories:
1. CAUSATION: How does visible damage link to the reported cause of loss?
2. SCOPE: What does this damage require — repair, partial replacement, full replacement?
3. REPAIRABILITY: Can this be repaired to pre-loss condition or must it be replaced?
4. FULL REPLACEMENT SUPPORT: Does damage pattern support full system replacement (e.g., matching, uniformity)?
5. CODE TRIGGERS: Does visible damage trigger code upgrades (ventilation, ice/water shield, drip edge)?
6. CARRIER CONTRADICTIONS: Does this photo contradict any carrier denial position?

OUTPUT (JSON array):
[{
  "finding_type": "causation|scope|repairability|full_replacement|code_trigger|carrier_contradiction",
  "material_type": "",
  "damage_description": "",
  "severity": "minor|moderate|severe|critical",
  "area": "",
  "causation_link": "",
  "scope_relevance": "",
  "code_trigger_ref": "",
  "carrier_contradiction": "",
  "evidence_strength": "weak|moderate|strong",
  "confidence": 0.0
}]

Return ONLY valid JSON array. Multiple findings per photo are expected.`;

    const messages: any[] = [{ role: 'system', content: systemPrompt }];

    if (photoBase64) {
      // Resize for forensic mode (≤2048px, JPEG q88, detail=high) — cuts vision tokens
      // dramatically on phone photos without losing damage detail.
      const { optimizeForVision, buildOptimizedImagePart } = await import("../_shared/ai/imageOptimizer.ts");
      const optimized = await optimizeForVision(photoBase64, 'image/jpeg', 'forensic');
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: `Analyze this claim photo forensically. Context: ${analysisContext || 'Property damage claim photo'}` },
          buildOptimizedImagePart(optimized),
        ],
      });
    } else {
      messages.push({
        role: 'user',
        content: `Analyze claim photo context: ${analysisContext || 'No photo provided, analyze based on description'}. Photo URL: ${photoUrl || 'none'}`,
      });
    }

    const aiResult = await callVision({
      model: MODEL_VISION,
      messages,
    });

    console.log(`[darwin-photo-intelligence] model=${MODEL_VISION}, usedSearch=false, cached=false`);

    const rawContent = aiResult.text;
    
    let findings: any[] = [];
    try {
      const jsonMatch = rawContent.match(/\[[\s\S]*\]/);
      if (jsonMatch) findings = JSON.parse(jsonMatch[0]);
    } catch { findings = []; }

    // Store each finding
    const inserts = findings.map((f: any) => ({
      claim_id: claimId,
      photo_id: photoId || null,
      photo_url: photoUrl || null,
      finding_type: f.finding_type || 'scope',
      material_type: f.material_type || null,
      damage_description: f.damage_description || null,
      severity: f.severity || null,
      area: f.area || null,
      causation_link: f.causation_link || null,
      scope_relevance: f.scope_relevance || null,
      code_trigger_ref: f.code_trigger_ref || null,
      carrier_contradiction: f.carrier_contradiction || null,
      evidence_strength: f.evidence_strength || null,
      confidence: f.confidence || null,
      structured_data: f,
    }));

    if (inserts.length > 0) {
      await supabase.from('claim_photo_findings').insert(inserts);
    }

    return new Response(JSON.stringify({ success: true, findings_count: findings.length, findings }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('darwin-photo-intelligence error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
