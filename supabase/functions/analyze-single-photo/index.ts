import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { callVision } from "../_shared/ai/generate.ts";
import { MODEL_VISION } from "../_shared/ai/modelRouter.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// System prompt for Darwin's photo analysis - FORENSIC SKEPTIC MODE
const ANALYSIS_SYSTEM_PROMPT = `You are Darwin, an expert AI forensic analyst specializing in property damage assessment for insurance claims. You work for a PUBLIC ADJUSTER representing the POLICYHOLDER, not the insurance company.

YOUR MISSION: Find and document ALL damage that supports the claim. Be thorough, skeptical of "good condition" assessments, and look for what carriers try to minimize or miss.

CRITICAL ANALYSIS RULES:
1. ASSUME DAMAGE EXISTS - Look harder. If a photo was taken for a claim, there's likely damage to find.
2. ANY REPAIR ATTEMPT = POOR OR FAILED CONDITION - Flex Seal, roof cement, caulk, tape, patches, tarps, or any DIY fixes indicate underlying damage severe enough to require repair.
3. MISSING MATERIALS = FAILED CONDITION - Missing shingles, siding, fascia, or any absent components is automatic "failed" rating.
4. BE CONSERVATIVE WITH "GOOD" RATINGS - Only rate as "good" if you see zero damage indicators.
5. GRANULE LOSS = DAMAGE - Any visible granule loss, bare spots, or exposed fiberglass is hail/storm damage.

MATERIAL IDENTIFICATION:
- Roofing: architectural shingles, 3-tab shingles, metal panels, tile, flat/modified bitumen, wood shake
- Siding: vinyl, aluminum, wood, fiber cement (Hardie), stucco, brick
- Interior: drywall, plaster, wood paneling, ceiling tiles

DAMAGE TYPES TO DETECT (look for ALL):
- MISSING MATERIALS: Gaps where shingles/siding should be (CRITICAL - often missed)
- REPAIR ATTEMPTS: Flex Seal, roof cement, caulk, patches, tarps, tape (indicates prior damage)
- Hail damage: bruising, dimples, granule loss, dents, craters, soft spots
- Wind damage: lifted/creased/torn/missing shingles, exposed underlayment, displaced materials
- Water damage: staining, warping, swelling, mold, water lines
- Storm damage: debris impact, punctures, structural displacement
- Age-related wear: curling, cracking, blistering, moss/algae, oxidation, rust

CONDITION RATINGS (BE CONSERVATIVE):
- Excellent: Factory-new appearance, zero wear or damage (RARE in claim photos)
- Good: Minor wear only, absolutely NO damage indicators (USE SPARINGLY)
- Fair: Some wear or very minor damage, functional but showing age
- Poor: Visible damage, repairs needed, any DIY fix attempts
- Failed: Missing materials, beyond repair, active leaks, structural compromise

IMPORTANT: If you see Flex Seal, patches, missing shingles, or any repair attempt, the condition is AT MINIMUM "poor" and likely "failed". These are not cosmetic - they indicate functional failure.

CRITICAL LANGUAGE RESTRICTIONS:
- NEVER use the words "deterioration", "deteriorated", "rot", "rotted", "rotting", or "decay" in any output.
- You may use "weathering" or "weathered" ONLY when discussing depreciation amounts or age-related value reduction. Never use weathering to describe damage causation or to minimize the scope of repairs needed.
- Describe age-related conditions using terms like "wear", "aging", "age-related wear" instead.

Provide your analysis in a structured JSON format.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { photoId, claimId } = await req.json();

    if (!photoId) {
      return new Response(
        JSON.stringify({ error: "Photo ID is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Fetch the photo record
    const { data: photo, error: photoError } = await supabase
      .from("claim_photos")
      .select("*")
      .eq("id", photoId)
      .single();

    if (photoError || !photo) {
      return new Response(
        JSON.stringify({ error: "Photo not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get the signed URL for the photo
    const { data: signedUrlData } = await supabase.storage
      .from("claim-files")
      .createSignedUrl(photo.file_path, 3600);

    if (!signedUrlData?.signedUrl) {
      return new Response(
        JSON.stringify({ error: "Could not access photo file" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch claim context if available
    let claimContext = "";
    let lossType = "";
    let lossDescription = "";
    if (claimId) {
      const { data: claim } = await supabase
        .from("claims")
        .select("loss_type_id, loss_description, policyholder_address, loss_types(name)")
        .eq("id", claimId)
        .single();

      if (claim) {
        lossType = (claim.loss_types as any)?.name || 'Unknown';
        lossDescription = claim.loss_description || 'Not provided';
        claimContext = `
CRITICAL CLAIM CONTEXT - Use this to guide your analysis:
- REPORTED CAUSE OF LOSS: ${lossType}
- LOSS DESCRIPTION: ${lossDescription}
- Property Location: ${claim.policyholder_address || 'Unknown'}

Your analysis MUST evaluate whether the visible damage is CONSISTENT with the reported cause of loss (${lossType}).
Look specifically for damage patterns that would be caused by ${lossType}.
`;
      }
    }

    // Build the analysis prompt
    const analysisPrompt = `FORENSIC DAMAGE ANALYSIS - Evaluate damage in context of REPORTED CAUSE OF LOSS.

${claimContext}

Photo Details:
- Filename: ${photo.file_name}
- Category: ${photo.category || 'Not categorized'}
- User Description: ${photo.description || 'None provided'}

CRITICAL: Your analysis must answer: "Is this damage CONSISTENT with ${lossType || 'the reported peril'}?"

DAMAGE PATTERN CHECKLIST FOR ${(lossType || 'STORM').toUpperCase()}:
${lossType?.toLowerCase().includes('wind') ? `□ Directional damage patterns (all facing same direction)?
□ Lifted, creased, or missing shingles?
□ Exposed underlayment or decking?
□ Debris impact marks?` : ''}
${lossType?.toLowerCase().includes('hail') ? `□ Random/scattered impact pattern?
□ Circular bruising or dents?
□ Granule displacement in impact zones?
□ Soft spots when pressed?
□ Collateral damage on vents, gutters, AC units?` : ''}
${lossType?.toLowerCase().includes('water') || lossType?.toLowerCase().includes('flood') ? `□ Water staining patterns?
□ Warping, swelling, or buckling?
□ Mold or mildew presence?
□ High water marks or tide lines?` : ''}
${!lossType || (!lossType.toLowerCase().includes('wind') && !lossType.toLowerCase().includes('hail') && !lossType.toLowerCase().includes('water') && !lossType.toLowerCase().includes('flood')) ? `□ Damage patterns consistent with reported cause?
□ Fresh vs weathered damage indicators?
□ Localized vs widespread damage?` : ''}

CRITICAL CHECKLIST - Look carefully for:
□ MISSING MATERIALS - Any gaps where shingles, siding, or components should be?
□ REPAIR ATTEMPTS - Flex Seal, roof cement, caulk, tape, patches, tarps? (= POOR or FAILED condition)
□ GRANULE LOSS - Bare spots, exposed fiberglass, dark patches on shingles?
□ LIFTED/DISPLACED - Any materials out of position, curled, or unsealed?
□ WATER EVIDENCE - Stains, warping, discoloration, mold?
□ IMPACT MARKS - Dents, bruises, punctures, cracks?

RATING RULES:
- If you see Flex Seal, patches, or ANY repair attempt → condition is "poor" or "failed"
- If materials are MISSING → condition is "failed"
- Only use "good" if you see ZERO damage indicators

Respond with ONLY a valid JSON object in this exact format:
{
  "material_type": "specific material (e.g., 'architectural asphalt shingles', 'vinyl siding', 'painted drywall ceiling')",
  "condition_rating": "one of: excellent, good, fair, poor, failed",
  "condition_notes": "detailed explanation including ALL damage observed and why you chose this rating",
  "loss_type_consistency": "one of: consistent, inconsistent, inconclusive",
  "loss_type_consistency_notes": "explain WHY the damage is or is not consistent with ${lossType || 'the reported cause of loss'}",
  "detected_damages": [
    {
      "type": "damage type (e.g., 'missing shingles', 'repair attempt - flex seal', 'hail damage', 'wind damage')",
      "severity": "one of: minor, moderate, severe",
      "location": "where on the material",
      "notes": "specific forensic observations",
      "consistent_with_loss_type": true or false
    }
  ],
  "summary": "1-2 sentence claim-supporting summary emphasizing damage found AND whether it supports the ${lossType || 'reported'} loss claim"
}

Remember: This photo was taken for an insurance claim alleging ${lossType || 'property damage'}. Evaluate whether visible damage supports that claim.
Respond with ONLY the JSON object, no additional text.`;

    console.log(`[analyze-single-photo] Analyzing photo ${photoId}, model: ${MODEL_VISION}`);

    // Retry logic for rate limits
    const MAX_RETRIES = 3;
    let lastError: { status?: number; message: string } | null = null;
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const visionResult = await callVision({
          model: MODEL_VISION,
          messages: [
            { role: "system", content: ANALYSIS_SYSTEM_PROMPT },
            {
              role: "user",
              content: [
                { type: "text", text: analysisPrompt },
                { type: "image_url", image_url: { url: signedUrlData.signedUrl } }
              ]
            }
          ],
        });

        const content = visionResult.text;
        console.log(`[analyze-single-photo] AI responded, model: ${visionResult.model}`);

        // Parse the JSON response
        let analysis;
        try {
          let jsonStr = content.trim();
          if (jsonStr.startsWith("```json")) jsonStr = jsonStr.slice(7);
          if (jsonStr.startsWith("```")) jsonStr = jsonStr.slice(3);
          if (jsonStr.endsWith("```")) jsonStr = jsonStr.slice(0, -3);
          jsonStr = jsonStr.trim();
          analysis = JSON.parse(jsonStr);
        } catch (parseError) {
          console.error("Failed to parse AI response:", content);
          return new Response(
            JSON.stringify({ error: "Failed to parse AI analysis", rawResponse: content.substring(0, 500) }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Update the photo record with the analysis results
        const { error: updateError } = await supabase
          .from("claim_photos")
          .update({
            ai_material_type: analysis.material_type || null,
            ai_condition_rating: analysis.condition_rating || null,
            ai_condition_notes: analysis.condition_notes || null,
            ai_detected_damages: analysis.detected_damages || [],
            ai_analysis_summary: analysis.summary || null,
            ai_loss_type_consistency: analysis.loss_type_consistency || null,
            ai_loss_type_consistency_notes: analysis.loss_type_consistency_notes || null,
            ai_analyzed_at: new Date().toISOString(),
          })
          .eq("id", photoId);

        if (updateError) {
          console.error("Failed to update photo with analysis:", updateError);
          return new Response(
            JSON.stringify({ error: "Failed to save analysis results", details: updateError.message }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        console.log(`[analyze-single-photo] Photo ${photoId} analyzed successfully`);

        return new Response(
          JSON.stringify({
            success: true,
            analysis: {
              material_type: analysis.material_type,
              condition_rating: analysis.condition_rating,
              condition_notes: analysis.condition_notes,
              detected_damages: analysis.detected_damages,
              summary: analysis.summary,
              loss_type_consistency: analysis.loss_type_consistency,
              loss_type_consistency_notes: analysis.loss_type_consistency_notes,
              analyzed_at: new Date().toISOString(),
            }
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
        
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[analyze-single-photo] Attempt ${attempt}/${MAX_RETRIES} failed:`, errMsg);
        lastError = { message: errMsg };
        
        if (errMsg === "RATE_LIMIT") {
          if (attempt < MAX_RETRIES) {
            const waitTime = Math.pow(2, attempt) * 1000;
            console.log(`Rate limited, waiting ${waitTime}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            continue;
          }
          return new Response(
            JSON.stringify({ error: "Rate limit exceeded. Please try again later." }),
            { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        if (attempt < MAX_RETRIES) {
          const waitTime = 1000 * attempt;
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }
      }
    }
    
    return new Response(
      JSON.stringify({ error: "AI analysis failed after retries", details: lastError?.message || "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Error in analyze-single-photo:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
