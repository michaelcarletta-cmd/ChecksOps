import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { generate, callVision } from "../_shared/ai/generate.ts";
import { MODEL_CHEAP, MODEL_STRONG, MODEL_VISION } from "../_shared/ai/modelRouter.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function callAI(systemPrompt: string, userPrompt: string, useStrong = false) {
  const result = await generate({
    task: "extraction",
    system: systemPrompt,
    user: userPrompt,
    searchMode: "off",
    model: useStrong ? MODEL_STRONG : MODEL_CHEAP,
    maxTokens: 16000,
  });
  console.log(`[claim-context-pipeline] AI call: model=${result.model}, cached=${result.cached}`);
  return result.text;
}

async function callAIVision(systemPrompt: string, contentParts: any[]) {
  const result = await callVision({
    model: MODEL_VISION,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: contentParts },
    ],
  });
  return result.text;
}

function parseJSON(text: string) {
  // Try raw parse first
  try { return JSON.parse(text); } catch {}
  // Strip markdown fences
  let clean = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "");
  // Find first { or [
  const objMatch = clean.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (objMatch) return JSON.parse(objMatch[1]);
  throw new Error("No JSON found in AI response");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    // Shared AI layer handles API keys internally

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body = await req.json();
    const { action, pipelineId, claimContext, measurementPdfBase64, measurementPdfName } = body;

    // ── STAGE 2A: Parse measurement report ──
    if (action === "parse_measurement") {
      const systemPrompt = `You are an expert construction measurement report parser. Extract ALL measurements from the PDF into a normalized JSON object.

Return ONLY this JSON (no other text):
{
  "source": "eagleview"|"hover"|"symbility"|"other",
  "sections": {
    "roof": { "total_squares": 0, "planes": [], "pitch": "", "ridges_lf": 0, "hips_lf": 0, "valleys_lf": 0, "drip_edge_lf": 0, "eaves_lf": 0, "rakes_lf": 0, "starter_lf": 0, "step_flashing_lf": 0, "headwall_flashing_lf": 0, "vents": 0, "pipe_boots": 0 },
    "gutters": { "eave_length_lf": 0, "gutter_lf": 0, "downspout_count": 0, "downspout_lf": 0 },
    "siding": { "wall_sf": 0, "elevations": [], "trim_lf": 0 },
    "interior": { "rooms": [], "ceiling_sf": 0, "wall_sf": 0, "openings_count": 0 },
    "openings": { "windows": 0, "doors": 0, "garage_doors": 0 },
    "notes": "any other info"
  }
}
Use 0 or [] for missing data. Never omit a section.`;

      const content = measurementPdfBase64
        ? [
            { type: "text", text: `Parse this measurement report (${measurementPdfName || "report.pdf"}). Extract every measurement.` },
            { type: "image_url", image_url: { url: `data:application/pdf;base64,${measurementPdfBase64}` } },
          ]
        : [{ type: "text", text: "No PDF provided." }];

      const raw = await callAI(apiKey, systemPrompt, JSON.stringify(content), "google/gemini-2.5-flash");
      const parsed = parseJSON(raw);

      return new Response(JSON.stringify({ success: true, measurement_report: parsed }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── STAGE 2B: Extract photo findings ──
    if (action === "extract_photo_findings") {
      const { photos, description, loss_cause } = claimContext;

      const systemPrompt = `You extract structured damage findings from property photos for insurance claims.
For each photo, identify damage and return a JSON array of findings.

Return ONLY a JSON array:
[
  {
    "area": "Kitchen ceiling",
    "scope": "interior"|"roof"|"siding"|"gutters"|"other",
    "material": "drywall"|null,
    "damage": "water stain with active drip",
    "severity": "minor"|"moderate"|"severe",
    "recommended_action": "repair"|"replace"|"detach_reset"|"clean"|"inspect",
    "confidence": 0.85
  }
]

Reported loss cause: ${loss_cause || "unknown"}
Description: ${description || "none"}
Number of photos to analyze: ${photos?.length || 0}

IMPORTANT:
- Each photo should produce 1-3 findings
- scope must match damage location (ceiling/wall/floor = interior, shingles = roof, etc.)
- Be specific about area names
- confidence 0.0-1.0`;

      // Build photo context from existing AI analyses + descriptions
      let photoInfo = "";
      if (photos && photos.length > 0) {
        // Fetch photo analysis data from DB
        const photoIds = photos.map((p: any) => p.id);
        const { data: photoData } = await supabase
          .from("claim_photos")
          .select("id, file_name, category, description, ai_material_type, ai_detected_damages, ai_condition_rating, ai_analysis_summary")
          .in("id", photoIds);

        if (photoData) {
          photoInfo = photoData.map((p: any) => {
            let info = `Photo: ${p.file_name} [${p.category || "general"}]`;
            if (p.description) info += `\n  Description: ${p.description}`;
            if (p.ai_material_type) info += `\n  Material: ${p.ai_material_type}`;
            if (p.ai_condition_rating) info += `\n  Condition: ${p.ai_condition_rating}`;
            if (p.ai_analysis_summary) info += `\n  Analysis: ${p.ai_analysis_summary}`;
            if (p.ai_detected_damages && Array.isArray(p.ai_detected_damages)) {
              info += `\n  Damages: ${JSON.stringify(p.ai_detected_damages)}`;
            }
            return info;
          }).join("\n\n");
        }
      }

      const raw = await callAI(apiKey, systemPrompt, photoInfo || "No photo data available. Return empty array [].");
      const findings = parseJSON(raw);

      return new Response(JSON.stringify({ success: true, photo_findings: Array.isArray(findings) ? findings : [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── STAGE 3: Scope classify & route ──
    if (action === "classify_scope") {
      const ctx = claimContext;
      
      // Pre-check: if description explicitly says interior, bias accordingly
      const descLower = (ctx.description || "").toLowerCase();
      const photoScopes = (ctx.photo_findings || []).map((f: any) => f.scope);
      const hasRoofPhotos = photoScopes.includes("roof");
      const hasInteriorPhotos = photoScopes.includes("interior");
      const hasMeasuredRoof = ctx.measurement_report?.sections?.roof?.total_squares > 0;
      
      const systemPrompt = `You are a scope classifier for insurance claims. Analyze the claim context and determine which repair scopes apply.

Return ONLY this JSON:
{
  "primary_scopes": ["interior","roof","siding","gutters"],
  "confidence": { "interior": 0.9, "roof": 0.1, "siding": 0.0, "gutters": 0.2 },
  "missing_info": ["No interior measurements available"]
}

Rules:
- confidence is 0.0-1.0 per scope
- primary_scopes = scopes with confidence >= 0.5
- If nothing >= 0.5, set primary_scopes to ["general"]
- missing_info lists what data would improve the estimate
- Analyze description, photo_findings, and measurement_report.sections

CRITICAL CLASSIFICATION RULES:
- Do NOT assign roof confidence >= 0.5 unless there is EXPLICIT evidence of roof damage (roof photos showing damage, description mentioning roof damage, or hail/wind damage to roof)
- Having a roof measurement report alone does NOT mean roof is damaged — measurement reports are often included by default
- Interior water damage (ceiling stains, pipe bursts, appliance leaks) does NOT imply roof damage unless explicitly stated
- If description says "interior", "water damage inside", "pipe burst", "appliance leak", etc., roof confidence should be < 0.2
- If photo_findings only contain interior scope items, roof confidence should be < 0.2
- Be CONSERVATIVE: only include a scope if there is direct evidence of damage in that scope`;

      const userPrompt = `Claim context:
Description: ${ctx.description || "none"}
Loss cause: ${ctx.loss_cause || "unknown"}
Photo findings (${ctx.photo_findings?.length || 0}): ${JSON.stringify(ctx.photo_findings || [])}
Photo scopes found: ${JSON.stringify([...new Set(photoScopes)])}
Has roof photos with damage: ${hasRoofPhotos}
Has interior photos with damage: ${hasInteriorPhotos}
Has measured roof data: ${hasMeasuredRoof}
Measurement sections available: ${JSON.stringify(Object.keys(ctx.measurement_report?.sections || {}).filter((k: string) => {
  const s = ctx.measurement_report?.sections?.[k];
  return s && typeof s === "object" && Object.keys(s).length > 0 && k !== "notes";
}))}`;

      const raw = await callAI(apiKey, systemPrompt, userPrompt);
      let classification = parseJSON(raw);
      
      // POST-PROCESSING GUARDRAIL: Force-correct scope confidence based on hard evidence
      if (classification.confidence) {
        // If no roof photos and no roof-related description, cap roof confidence
        const roofKeywords = ["roof", "shingle", "hail", "wind damage to roof", "missing shingles", "ridge", "flashing"];
        const descMentionsRoof = roofKeywords.some(kw => descLower.includes(kw));
        
        if (!hasRoofPhotos && !descMentionsRoof) {
          classification.confidence.roof = Math.min(classification.confidence.roof || 0, 0.2);
        }
        
        // Recalculate primary_scopes from corrected confidence
        classification.primary_scopes = Object.entries(classification.confidence)
          .filter(([_, conf]) => (conf as number) >= 0.5)
          .map(([scope]) => scope);
        
        if (classification.primary_scopes.length === 0) {
          classification.primary_scopes = ["general"];
        }
      }

      return new Response(JSON.stringify({ success: true, scope_classification: classification }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── STAGE 4: Generate estimate ──
    if (action === "generate_estimate") {
      const ctx = claimContext;

      // Guardrails
      const hasPhotos = ctx.photo_findings && ctx.photo_findings.length > 0;
      const hasDesc = ctx.description && ctx.description.trim().length > 0;
      const hasMeasurements = ctx.measurement_report?.sections && Object.keys(ctx.measurement_report.sections).some((k: string) => {
        const s = ctx.measurement_report.sections[k];
        return s && typeof s === "object" && Object.keys(s).length > 0 && k !== "notes";
      });

      if (!hasPhotos && !hasDesc && !hasMeasurements) {
        return new Response(JSON.stringify({
          success: false,
          error: "Insufficient information. Need at least one of: photo findings, claim description, or measurements.",
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const primaryScopes = ctx.scope_classification?.primary_scopes || ["general"];
      const scopeConfidence = ctx.scope_classification?.confidence || {};
      const overrides = ctx.user_overrides || { quality_grade: "standard", include_op: true, tax_rate: 0, price_list: null };

      // Build excluded scopes list for absolute clarity
      const allScopes = ["interior", "roof", "siding", "gutters", "structural", "exterior"];
      const excludedScopes = allScopes.filter(s => !primaryScopes.includes(s));

      const systemPrompt = `You are an expert Xactimate estimate generator for insurance claims. Generate line items per scope.

ABSOLUTE RULES — VIOLATION OF THESE IS A CRITICAL ERROR:
1. You may ONLY generate line items for these scopes: ${JSON.stringify(primaryScopes)}
2. You MUST NOT generate ANY line items for these scopes: ${JSON.stringify(excludedScopes)}
3. Specifically: ${!primaryScopes.includes("roof") ? "DO NOT INCLUDE ANY ROOF LINE ITEMS. NO SHINGLES, NO UNDERLAYMENT, NO RIDGE CAPS, NO ROOF-RELATED ITEMS AT ALL." : "Roof items are allowed."}
4. ${!primaryScopes.includes("interior") ? "DO NOT INCLUDE ANY INTERIOR LINE ITEMS." : "Interior items are allowed."}
5. ${!primaryScopes.includes("siding") ? "DO NOT INCLUDE ANY SIDING LINE ITEMS." : "Siding items are allowed."}
6. ${!primaryScopes.includes("gutters") ? "DO NOT INCLUDE ANY GUTTER LINE ITEMS." : "Gutter items are allowed."}

QUANTITY RULES:
7. For each line item:
   - If measurements exist for that scope → qty_basis = "measured", use actual measurements
   - If measurements missing → qty_basis = "allowance", estimate reasonable minimums from photo findings
   - Always include assumptions for allowance items
8. Quality grade: ${overrides.quality_grade}
9. Include O&P: ${overrides.include_op} (if true and 3+ trades, add 10% overhead + 10% profit line)
10. Tax rate: ${overrides.tax_rate}%

Return ONLY this JSON:
{
  "estimate": [
    {
      "scope": "interior",
      "items": [
        {
          "line_code": "DRYWL12" or null,
          "description": "Drywall 1/2\\" - hung, taped, floated",
          "unit": "SF",
          "qty": 64,
          "qty_basis": "allowance",
          "assumptions": "Assumes 1 room ceiling patch ~64 SF pending field measurement"
        }
      ]
    }
  ],
  "missing_info_to_finalize": ["Interior room dimensions needed for exact SF"],
  "questions_for_user": ["How many rooms were affected by water damage?"]
}`;

      const userPrompt = `FULL CLAIM CONTEXT (ONLY generate for scopes: ${JSON.stringify(primaryScopes)}):
${JSON.stringify(ctx, null, 2)}`;

      const raw = await callAI(apiKey, systemPrompt, userPrompt, "google/gemini-2.5-pro");
      const estimateResult = parseJSON(raw);

      // HARD GUARDRAIL: strip any scopes not in primary_scopes (LLM may hallucinate)
      if (estimateResult.estimate && Array.isArray(estimateResult.estimate)) {
        estimateResult.estimate = estimateResult.estimate.filter((s: any) =>
          primaryScopes.includes(s.scope)
        );
        
        if (estimateResult.estimate.length === 0 && !primaryScopes.includes("general")) {
          estimateResult.missing_info_to_finalize = estimateResult.missing_info_to_finalize || [];
          estimateResult.missing_info_to_finalize.push("No line items matched the identified scopes. More detail needed.");
        }
      }

      // Save to DB if pipelineId provided
      if (pipelineId) {
        await supabase
          .from("claim_context_pipelines")
          .update({
            claim_context: ctx,
            estimate_result: estimateResult,
            status: "complete",
            stage: "estimate",
          })
          .eq("id", pipelineId);
      }

      return new Response(JSON.stringify({ success: true, estimate_result: estimateResult }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── UNIFIED: build_full (runs all stages in one call) ──
    if (action === "build_full") {
      const { overrides, measurementPdfBase64: fullPdfBase64, measurementPdfName: fullPdfName } = body;
      const claimId = body.claimId;
      if (!claimId) throw new Error("claimId required");

      // 1. Load claim data
      const { data: claimData, error: claimErr } = await supabase
        .from("claims")
        .select("id, claim_number, loss_type, loss_description")
        .eq("id", claimId)
        .single();
      if (claimErr || !claimData) throw new Error("Claim not found");

      // 2. Load photos from claim_photos
      const { data: photosData } = await supabase
        .from("claim_photos")
        .select("id, file_name, file_path, category, description, ai_material_type, ai_detected_damages, ai_condition_rating, ai_analysis_summary")
        .eq("claim_id", claimId)
        .order("created_at", { ascending: false });
      const photos = photosData || [];

      // 3. Parse measurement report if PDF provided
      let parsedMeasurement = { source: null, raw_text: null, sections: { roof: {}, interior: {}, siding: {}, gutters: {}, openings: {}, notes: null } };
      let measurementRawText: string | null = null;

      if (fullPdfBase64) {
        // Extract structured measurements via AI
        const measSystemPrompt = `You are an expert construction measurement report parser. Extract ALL measurements from EVERY PAGE of the PDF into a normalized JSON object.

Return ONLY this JSON (no other text):
{
  "source": "eagleview"|"hover"|"symbility"|"other",
  "raw_text": "<FULL extracted text from ALL pages of the document>",
  "sections": {
    "roof": { "total_squares": 0, "planes": [], "pitch": "", "ridges_lf": 0, "hips_lf": 0, "valleys_lf": 0, "drip_edge_lf": 0, "eaves_lf": 0, "rakes_lf": 0, "starter_lf": 0, "step_flashing_lf": 0, "headwall_flashing_lf": 0, "vents": 0, "pipe_boots": 0 },
    "gutters": { "eave_length_lf": 0, "gutter_lf": 0, "downspout_count": 0, "downspout_lf": 0 },
    "siding": { "wall_sf": 0, "elevations": [], "trim_lf": 0 },
    "interior": { "rooms": [], "ceiling_sf": 0, "wall_sf": 0, "openings_count": 0 },
    "openings": { "windows": 0, "doors": 0, "garage_doors": 0 },
    "notes": "any other info"
  }
}
CRITICAL: The "raw_text" field MUST contain the COMPLETE text from ALL pages. Do NOT summarize or truncate.
Use 0 or [] for missing data. Never omit a section.`;

        const measContent = [
          { type: "text", text: `Parse this measurement report (${fullPdfName || "report.pdf"}). Extract every measurement from ALL pages. Include full raw text.` },
          { type: "image_url", image_url: { url: `data:application/pdf;base64,${fullPdfBase64}` } },
        ];

        const measRaw = await callAI(apiKey, measSystemPrompt, JSON.stringify(measContent), "google/gemini-2.5-flash");
        const measParsed = parseJSON(measRaw);
        parsedMeasurement = {
          source: measParsed.source || "other",
          raw_text: measParsed.raw_text || null,
          sections: {
            roof: measParsed.sections?.roof || {},
            interior: measParsed.sections?.interior || {},
            siding: measParsed.sections?.siding || {},
            gutters: measParsed.sections?.gutters || {},
            openings: measParsed.sections?.openings || {},
            notes: measParsed.sections?.notes || null,
          },
        };
        measurementRawText = measParsed.raw_text || null;
        console.log(`Measurement report parsed: source=${parsedMeasurement.source}, raw_text_length=${measurementRawText?.length || 0}`);
      }

      // 4. HARD RULE: Extract photo findings FIRST
      const description = claimData.loss_description || "";
      const loss_cause = claimData.loss_type || "unknown";

      const findingsSystemPrompt = `You extract structured damage findings from property photos for insurance claims.
For each photo, identify damage and return a JSON array of findings.

Return ONLY a JSON array:
[
  {
    "area": "Kitchen ceiling",
    "scope": "interior"|"roof"|"siding"|"gutters"|"other",
    "material": "drywall"|null,
    "damage": "water stain with active drip",
    "severity": "minor"|"moderate"|"severe",
    "recommended_action": "repair"|"replace"|"detach_reset"|"clean"|"inspect",
    "confidence": 0.85
  }
]

Reported loss cause: ${loss_cause}
Description: ${description}
Number of photos to analyze: ${photos.length}

IMPORTANT:
- Each photo should produce 1-3 findings
- scope must match damage location (ceiling/wall/floor = interior, shingles = roof, etc.)
- Be specific about area names
- confidence 0.0-1.0`;

      let photoInfo = "";
      if (photos.length > 0) {
        photoInfo = photos.map((p: any) => {
          let info = `Photo: ${p.file_name} [${p.category || "general"}]`;
          if (p.description) info += `\n  Description: ${p.description}`;
          if (p.ai_material_type) info += `\n  Material: ${p.ai_material_type}`;
          if (p.ai_condition_rating) info += `\n  Condition: ${p.ai_condition_rating}`;
          if (p.ai_analysis_summary) info += `\n  Analysis: ${p.ai_analysis_summary}`;
          if (p.ai_detected_damages && Array.isArray(p.ai_detected_damages)) {
            info += `\n  Damages: ${JSON.stringify(p.ai_detected_damages)}`;
          }
          return info;
        }).join("\n\n");
      }

      const findingsRaw = await callAI(apiKey, findingsSystemPrompt, photoInfo || `No photos available. Use description: "${description}". Return findings based on described damage.`);
      const photoFindings = Array.isArray(parseJSON(findingsRaw)) ? parseJSON(findingsRaw) : [];
      console.log(`Photo findings extracted: ${photoFindings.length}`);

      // 5. HARD RULE: Scope classification BEFORE estimate
      const descLower = description.toLowerCase();
      const photoScopes = photoFindings.map((f: any) => f.scope);
      const hasRoofPhotos = photoScopes.includes("roof");

      const classifySystemPrompt = `You are a scope classifier for insurance claims. Analyze the claim context and determine which repair scopes apply.

Return ONLY this JSON:
{
  "primary_scopes": ["interior","roof","siding","gutters"],
  "confidence": { "interior": 0.9, "roof": 0.1, "siding": 0.0, "gutters": 0.2, "other": 0.0 },
  "missing_info": ["No interior measurements available"]
}

Rules:
- confidence is 0.0-1.0 per scope
- primary_scopes = scopes with confidence >= 0.5
- If nothing >= 0.5, set primary_scopes to ["general"]
- Do NOT assign roof confidence >= 0.5 unless there is EXPLICIT evidence of roof damage
- Having a measurement report alone does NOT mean roof is damaged
- Interior water damage does NOT imply roof damage unless explicitly stated`;

      const classifyUserPrompt = `Description: ${description}
Loss cause: ${loss_cause}
Photo findings (${photoFindings.length}): ${JSON.stringify(photoFindings)}
Photo scopes found: ${JSON.stringify([...new Set(photoScopes)])}
Has roof photos with damage: ${hasRoofPhotos}
Measurement sections: ${JSON.stringify(Object.keys(parsedMeasurement.sections).filter(k => {
        const s = (parsedMeasurement.sections as any)[k];
        return s && typeof s === "object" && Object.keys(s).length > 0 && k !== "notes";
      }))}
${measurementRawText ? `\nMeasurement report text (first 5000 chars):\n${measurementRawText.substring(0, 5000)}` : ""}`;

      const classifyRaw = await callAI(apiKey, classifySystemPrompt, classifyUserPrompt);
      let scopeClassification = parseJSON(classifyRaw);

      // Post-processing guardrail
      if (scopeClassification.confidence) {
        const roofKeywords = ["roof", "shingle", "hail", "wind damage to roof", "missing shingles"];
        const descMentionsRoof = roofKeywords.some(kw => descLower.includes(kw));
        if (!hasRoofPhotos && !descMentionsRoof) {
          scopeClassification.confidence.roof = Math.min(scopeClassification.confidence.roof || 0, 0.2);
        }
        scopeClassification.primary_scopes = Object.entries(scopeClassification.confidence)
          .filter(([_, conf]) => (conf as number) >= 0.5)
          .map(([scope]) => scope);
        if (scopeClassification.primary_scopes.length === 0) {
          scopeClassification.primary_scopes = ["general"];
        }
      }
      console.log(`Scope classification: ${JSON.stringify(scopeClassification.primary_scopes)}`);

      // 6. Generate estimate (ONLY for classified scopes)
      const primaryScopes = scopeClassification.primary_scopes || ["general"];
      const allScopes = ["interior", "roof", "siding", "gutters", "structural", "exterior"];
      const excludedScopes = allScopes.filter((s: string) => !primaryScopes.includes(s));
      const userOverrides = overrides || { quality_grade: "standard", include_op: true, tax_rate: 0, price_list: null };

      const estimateSystemPrompt = `You are an expert Xactimate estimate generator for insurance claims. Generate line items per scope.

ABSOLUTE RULES:
1. You may ONLY generate line items for these scopes: ${JSON.stringify(primaryScopes)}
2. You MUST NOT generate ANY line items for these scopes: ${JSON.stringify(excludedScopes)}
3. ${!primaryScopes.includes("roof") ? "DO NOT INCLUDE ANY ROOF LINE ITEMS." : "Roof items are allowed."}

QUANTITY RULES:
- If measurements exist → qty_basis = "measured", use actual measurements
- If measurements missing → qty_basis = "allowance", estimate minimums from findings
- Always include assumptions for allowance items
- Parse the measurement report into structured quantities by section. Use structured quantities when available; otherwise use allowances.

Quality grade: ${userOverrides.quality_grade}
Include O&P: ${userOverrides.include_op} (if true and 3+ trades, add 10% overhead + 10% profit)
Tax rate: ${userOverrides.tax_rate}%

Return ONLY this JSON:
{
  "estimate": [
    {
      "scope": "interior",
      "items": [
        {
          "line_code": "DRYWL12" or null,
          "description": "Drywall 1/2\\" - hung, taped, floated",
          "unit": "SF",
          "qty": 64,
          "qty_basis": "allowance",
          "assumptions": "Assumes 1 room ceiling patch ~64 SF"
        }
      ]
    }
  ],
  "missing_info_to_finalize": ["Interior room dimensions needed"],
  "questions_for_user": ["How many rooms affected?"]
}`;

      const fullCtx = {
        description,
        loss_cause,
        photo_findings: photoFindings,
        scope_classification: scopeClassification,
        measurement_report: parsedMeasurement,
        user_overrides: userOverrides,
      };

      const estimateRaw = await callAI(apiKey, estimateSystemPrompt, `FULL CLAIM CONTEXT (ONLY generate for scopes: ${JSON.stringify(primaryScopes)}):\n${JSON.stringify(fullCtx, null, 2)}`, "google/gemini-2.5-pro");
      const estimateResult = parseJSON(estimateRaw);

      // HARD GUARDRAIL: strip scopes not in primary
      if (estimateResult.estimate && Array.isArray(estimateResult.estimate)) {
        estimateResult.estimate = estimateResult.estimate.filter((s: any) => primaryScopes.includes(s.scope));
      }

      // Save pipeline record
      const { data: pipeline } = await supabase
        .from("claim_context_pipelines")
        .insert([{
          claim_id: claimId,
          stage: "estimate",
          status: "complete",
          claim_context: fullCtx as any,
          estimate_result: estimateResult as any,
        }])
        .select("id")
        .single();

      return new Response(JSON.stringify({
        success: true,
        pipeline_id: pipeline?.id,
        scope_classification: scopeClassification,
        photo_findings: photoFindings,
        measurement_report: parsedMeasurement,
        estimate_result: estimateResult,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Pipeline error:", error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
