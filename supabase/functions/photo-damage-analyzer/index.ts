import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const PASS1_SYSTEM_PROMPT = `You are a property damage photo inspector.

TASK: Create a PHOTO-BY-PHOTO damage inventory.
You MUST return one entry for EACH photo_id provided.

RULES:
- For each photo: list 2–8 distinct damaged items visible in that photo (unless unusable).
- Do NOT summarize across photos. Do NOT merge items across different photos.
- Use inferred_area (room/elevation) from caption or visual cues.
- For each item: include item, damage, action (replace/repair/clean_restore/investigate), why, severity, trade_category_code (Xactimate category only), and repair_method.
- repair_method: a concise description of HOW to perform the repair or replacement (e.g. "Remove damaged section, install new 5/8\" drywall, tape, mud, texture to match, prime and paint 2 coats" or "Sand, prime, apply 2 coats exterior latex paint" or "Remove and replace with matching laminate flooring, including underlayment"). Be specific about materials, techniques, and steps.
- Only use investigate if the damage/material truly cannot be seen; if investigate, include a specific missing_photo_request.
- No pricing. No quantities. No Xactimate selector codes.

CRITICAL LANGUAGE RESTRICTIONS:
- NEVER use the words "deterioration", "deteriorated", "rot", "rotted", "rotting", or "decay" in any output.
- You may use "weathering" or "weathered" ONLY when discussing depreciation amounts or age-related value reduction. Never use weathering to describe damage causation or to minimize the scope of repairs needed.
- Focus on describing damage in terms of the loss event (e.g. impact damage, wind damage, water intrusion, displacement, cracking, missing materials).

Return ONLY valid JSON matching the schema.`;

const PASS2_SYSTEM_PROMPT = `You are a property damage claim specialist producing a final scope summary.

You will receive a raw photo-by-photo damage inventory. Your job:
1. Group items by inferred_area.
2. Deduplicate: if the same item + action + damage appears in multiple photos in the same area, merge into one entry and collect all photo_ids as evidence.
3. For each unique item, produce:
   - item, material, damage, action, why, severity, trade_category_code, repair_method, evidence_photo_ids[]
   - repair_method: consolidate/refine the repair methods from the raw inventory into a single best description of how to perform this repair or replacement.
4. Produce an Xactimate add-item plan:
   - For each area, list category_code (CAT only) + selector_hint (search phrase, NOT full selector codes)
   - Link each to the damage item it covers
5. If water damage is present, include remediation + removal + rebuild recommendations.

RULES:
- No pricing. No quantities.
- Do NOT guess Xactimate selector codes.
- NEVER use the words "deterioration", "deteriorated", "rot", "rotted", "rotting", or "decay" in any output.
- You may use "weathering" or "weathered" ONLY when discussing depreciation amounts or age-related value reduction. Never use weathering to describe damage causation.
- Return ONLY valid JSON matching the schema.`;

const pass1ToolSchema = {
  type: "function",
  function: {
    name: "report_photo_inventory",
    description: "Report per-photo damage inventory",
    parameters: {
      type: "object",
      properties: {
        photos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              photo_id: { type: "string" },
              inferred_area: { type: "string" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    item: { type: "string" },
                    material: { type: "string" },
                    damage: { type: "string" },
                    action: { type: "string", enum: ["replace", "repair", "clean_restore", "investigate"] },
                    why: { type: "string" },
                    severity: { type: "string", enum: ["minor", "moderate", "severe"] },
                    trade_category_code: { type: "string" },
                    repair_method: { type: "string", description: "Concise step-by-step description of how to perform the repair or replacement" },
                    confidence: { type: "number" },
                  },
                  required: ["item", "damage", "action", "why", "severity", "trade_category_code", "repair_method", "confidence"],
                },
              },
              missing_photo_request: { type: "string" },
            },
            required: ["photo_id", "inferred_area", "items"],
          },
        },
        notes: { type: "array", items: { type: "string" } },
      },
      required: ["photos"],
    },
  },
};

const ESTIMATE_SYSTEM_PROMPT = `You are a construction cost estimator for insurance property claims.

TASK: Given a deduped damage inventory (items with repair methods) and the property location, produce a detailed cost estimate with material and labor costs.

RULES:
- Use regional pricing appropriate for the property location (state/city).
- For each item provide: unit (SF, LF, EA, SQ, etc.), quantity estimate based on typical residential sizes if not specified, material_cost_per_unit, labor_cost_per_unit, and total.
- Include O&P (Overhead & Profit) at 20% as a separate line item at the end.
- Include a tax line item at the local tax rate for materials only.
- Be realistic with quantities - use standard residential dimensions when exact measurements aren't available.
- Group items by area, matching the input structure.
- Include a brief note on any assumptions made about quantities.
- NEVER use the words "deterioration", "deteriorated", "rot", "rotted", "rotting", or "decay" in any output.
- You may use "weathering" or "weathered" ONLY when discussing depreciation amounts.
- Return ONLY valid JSON matching the schema.`;

const estimateToolSchema = {
  type: "function",
  function: {
    name: "report_cost_estimate",
    description: "Report detailed cost estimate with material and labor breakdown",
    parameters: {
      type: "object",
      properties: {
        location_used: { type: "string", description: "The location used for regional pricing" },
        price_date: { type: "string", description: "Date basis for pricing (e.g. Q1 2025)" },
        line_items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              area: { type: "string" },
              item: { type: "string" },
              action: { type: "string" },
              repair_method: { type: "string" },
              unit: { type: "string" },
              quantity: { type: "number" },
              material_cost_per_unit: { type: "number" },
              labor_cost_per_unit: { type: "number" },
              total: { type: "number" },
            },
            required: ["area", "item", "action", "unit", "quantity", "material_cost_per_unit", "labor_cost_per_unit", "total"],
          },
        },
        subtotal_materials: { type: "number" },
        subtotal_labor: { type: "number" },
        tax_rate: { type: "number" },
        tax_amount: { type: "number" },
        overhead_and_profit_pct: { type: "number" },
        overhead_and_profit_amount: { type: "number" },
        grand_total: { type: "number" },
        assumptions: { type: "array", items: { type: "string" } },
      },
      required: ["line_items", "subtotal_materials", "subtotal_labor", "tax_amount", "overhead_and_profit_amount", "grand_total"],
    },
  },
};

const pass2ToolSchema = {
  type: "function",
  function: {
    name: "report_grouped_analysis",
    description: "Report deduplicated grouped damage analysis and Xactimate plan",
    parameters: {
      type: "object",
      properties: {
        damage_findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              area: { type: "string" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    item: { type: "string" },
                    material: { type: "string" },
                    damage: { type: "string" },
                    action: { type: "string", enum: ["replace", "repair", "clean_restore", "investigate"] },
                    why: { type: "string" },
                    severity: { type: "string", enum: ["minor", "moderate", "severe"] },
                    trade_category_code: { type: "string" },
                    confidence: { type: "number" },
                    repair_method: { type: "string", description: "Step-by-step description of how to perform the repair or replacement" },
                    evidence_photo_ids: { type: "array", items: { type: "string" } },
                  },
                  required: ["item", "damage", "action", "why", "repair_method", "evidence_photo_ids"],
                },
              },
            },
            required: ["area", "items"],
          },
        },
        xactimate_plan: {
          type: "array",
          items: {
            type: "object",
            properties: {
              area: { type: "string" },
              trade_groups: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    category_code: { type: "string" },
                    items: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          selector_hint: { type: "string" },
                          reason: { type: "string" },
                          linked_replace_item: { type: "string" },
                        },
                        required: ["selector_hint", "reason", "linked_replace_item"],
                      },
                    },
                  },
                  required: ["category_code", "items"],
                },
              },
            },
            required: ["area", "trade_groups"],
          },
        },
        notes: { type: "array", items: { type: "string" } },
        questions: { type: "array", items: { type: "string" } },
      },
      required: ["damage_findings", "xactimate_plan"],
    },
  },
};

async function callAI(_apiKey: string, body: any, timeoutMs = 90000): Promise<any> {
  const { callWithTools, callVision } = await import("../_shared/ai/openaiClient.ts");
  const { MODEL_VISION } = await import("../_shared/ai/modelRouter.ts");

  // Map Lovable model names to OpenAI
  const modelMap: Record<string, string> = {
    "google/gemini-2.5-flash": "gpt-4o-mini",
    "google/gemini-2.5-pro": "gpt-4o",
  };
  const resolvedModel = modelMap[body.model] || MODEL_VISION;

  if (!body.max_tokens) body.max_tokens = 16384;

  console.log(`[photo-damage-analyzer] callAI: model=${resolvedModel}, max_tokens=${body.max_tokens}`);

  if (body.tools && body.tools.length > 0) {
    const result = await callWithTools({
      model: resolvedModel,
      messages: body.messages,
      tools: body.tools,
      toolChoice: body.tool_choice,
      temperature: body.temperature ?? 0.3,
      maxTokens: body.max_tokens,
    });
    return {
      choices: [{
        finish_reason: result.toolCalls.length > 0 ? "tool_calls" : "stop",
        message: {
          content: result.text,
          tool_calls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
        },
      }],
    };
  } else {
    const result = await callVision({
      model: resolvedModel,
      messages: body.messages,
      temperature: body.temperature ?? 0.3,
      maxTokens: body.max_tokens,
    });
    return {
      choices: [{
        finish_reason: "stop",
        message: { content: result.text },
      }],
    };
  }
}

async function callAIWithRetry(_apiKey: string, body: any, timeoutMs = 180000, maxRetries = 2): Promise<any> {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const requestBody = attempt > 0 && body.tool_choice 
        ? { ...body, tool_choice: "auto" } 
        : body;
      const aiData = await callAI("_unused", requestBody, timeoutMs);
      const result = extractToolResult(aiData);
      return result;
    } catch (e: any) {
      lastError = e;
      console.error(`AI attempt ${attempt + 1} failed:`, e.message || e);
      if (attempt < maxRetries) {
        const delay = 2000 * (attempt + 1);
        console.log(`Retrying in ${delay}ms (will relax tool_choice)...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

function extractToolResult(aiData: any): any {
  // Try tool_calls first
  const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
  if (toolCall?.function?.arguments) {
    try {
      return JSON.parse(toolCall.function.arguments);
    } catch (e) {
      console.error("Failed to parse tool_call arguments, length:", toolCall.function.arguments?.length, "first 500:", toolCall.function.arguments?.substring(0, 500));
    }
  }
  // Try content as JSON
  const content = aiData.choices?.[0]?.message?.content || "";
  if (content) {
    console.log("extractToolResult: no tool_calls, trying content. Length:", content.length, "first 200:", content.substring(0, 200));
    // Try extracting JSON object
    const jsonStart = content.indexOf("{");
    const jsonEnd = content.lastIndexOf("}");
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      try {
        return JSON.parse(content.slice(jsonStart, jsonEnd + 1));
      } catch (e) {
        console.error("Failed to parse content JSON, range:", jsonStart, "-", jsonEnd);
      }
    }
    // Try extracting JSON array
    const arrStart = content.indexOf("[");
    const arrEnd = content.lastIndexOf("]");
    if (arrStart >= 0 && arrEnd > arrStart) {
      try {
        return { items: JSON.parse(content.slice(arrStart, arrEnd + 1)) };
      } catch (e) {
        console.error("Failed to parse content array, range:", arrStart, "-", arrEnd);
      }
    }
  }
  // Log full structure for debugging
  const finishReason = aiData.choices?.[0]?.finish_reason;
  const refusal = aiData.choices?.[0]?.message?.refusal;
  console.error("extractToolResult FAILED. finish_reason:", finishReason, "refusal:", refusal, "has content:", !!content, "content length:", content?.length, "has tool_calls:", !!toolCall, "full message keys:", Object.keys(aiData.choices?.[0]?.message || {}));
  if (finishReason === "length") {
    throw new Error("AI response was truncated (too long). Try analyzing fewer items.");
  }
  throw new Error(`No parseable result in AI response (finish_reason: ${finishReason})`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // AI routing handled by _shared/ai layer (OPENAI_API_KEY required)

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body = await req.json();
    const { claimId, mode = "batch", photoIds, pass1Data, claimDescription, jobKey } = body;

    if (!claimId) throw new Error("claimId is required");

    // =================== MODE: BATCH (Pass 1 - one batch of photos) ===================
    if (mode === "batch") {
      if (!photoIds || !Array.isArray(photoIds) || photoIds.length === 0) {
        throw new Error("photoIds array is required for batch mode");
      }

      // Get claim info if not provided
      let desc = claimDescription;
      if (!desc) {
        const { data: claim } = await supabase
          .from("claims")
          .select("loss_description, loss_type, policyholder_address")
          .eq("id", claimId)
          .maybeSingle();
        desc = [
          claim?.loss_description || "No description",
          claim?.loss_type ? `Loss type: ${claim.loss_type}` : null,
          claim?.policyholder_address ? `Property: ${claim.policyholder_address}` : null,
        ].filter(Boolean).join("\n");
      }

      // Fetch photo records for this batch
      const { data: photos, error: photosError } = await supabase
        .from("claim_photos")
        .select("id, file_path, file_name, category, description, ai_analysis_summary, ai_material_type, ai_condition_rating")
        .in("id", photoIds);

      if (photosError) throw new Error("Failed to fetch photos");

      const batchContent: any[] = [];
      const batchCaptions: string[] = [];
      const batchPhotoIds: string[] = [];

      for (const photo of (photos || [])) {
        const caption = [
          photo.description || photo.category || "(no caption)",
          photo.ai_material_type ? `Material: ${photo.ai_material_type}` : null,
          photo.ai_condition_rating ? `Condition: ${photo.ai_condition_rating}` : null,
          photo.ai_analysis_summary ? `AI: ${photo.ai_analysis_summary}` : null,
        ].filter(Boolean).join(" | ");

        batchCaptions.push(`photo_id="${photo.id}": ${caption}`);
        batchPhotoIds.push(photo.id);

        try {
          const { data: signedData, error: signError } = await supabase.storage
            .from("claim-files")
            .createSignedUrl(photo.file_path, 600);

          if (!signError && signedData?.signedUrl) {
            batchContent.push({
              type: "image_url",
              image_url: { url: signedData.signedUrl },
            });
          }
        } catch (e) {
          console.error("Failed to create signed URL:", photo.id, e);
        }
      }

      // Also add placeholder for any photoIds not found in DB
      for (const pid of photoIds) {
        if (!batchPhotoIds.includes(pid)) {
          batchPhotoIds.push(pid);
          batchCaptions.push(`photo_id="${pid}": (photo not found in database)`);
        }
      }

      if (batchContent.length === 0) {
        // No images could be loaded, return placeholder entries
        const placeholderPhotos = batchPhotoIds.map(pid => ({
          photo_id: pid,
          inferred_area: "Unknown",
          items: [{ item: "Unable to access photo", damage: "N/A", action: "investigate", why: "Photo could not be loaded for analysis", severity: "minor", trade_category_code: "GEN", confidence: 0 }],
          missing_photo_request: "Re-upload or re-run analysis",
        }));
        return new Response(JSON.stringify({ photos: placeholderPhotos, notes: ["No images could be loaded for this batch"] }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const result = await callAIWithRetry("_unused", {
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: PASS1_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: `CLAIM: ${desc}\n\nPHOTO CAPTIONS (use photo_id in your response):\n${batchCaptions.join("\n")}\n\nYou MUST return one entry for each of these photo_ids: ${batchPhotoIds.join(", ")}` },
              ...batchContent,
            ],
          },
        ],
        tools: [pass1ToolSchema],
        tool_choice: { type: "function", function: { name: "report_photo_inventory" } },
      }, 180000, 2);


      // Fill in missing photo_ids
      const returnedIds = new Set((result.photos || []).map((p: any) => p.photo_id));
      for (const pid of batchPhotoIds) {
        if (!returnedIds.has(pid)) {
          if (!result.photos) result.photos = [];
          result.photos.push({
            photo_id: pid,
            inferred_area: "Unknown",
            items: [{ item: "Missing from batch output", damage: "N/A", action: "investigate", why: "Missing from batch output; rerun", severity: "minor", trade_category_code: "GEN", confidence: 0 }],
            missing_photo_request: "Rerun analysis",
          });
        }
      }

      // Save result to DB for polling fallback
      if (jobKey) {
        try {
          await supabase.from("claim_context_pipelines").insert({
            claim_id: claimId,
            stage: `pda_batch_${jobKey}`,
            status: "completed",
            claim_context: result,
          });
        } catch (e) {
          console.error("Failed to save batch result cache:", e);
        }
      }

      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // =================== MODE: DEDUPLICATE (Pass 2 - text only) ===================
    if (mode === "deduplicate") {
      if (!pass1Data) throw new Error("pass1Data is required for deduplicate mode");

      let desc = claimDescription;
      if (!desc) {
        const { data: claim } = await supabase
          .from("claims")
          .select("loss_description, loss_type, policyholder_address")
          .eq("id", claimId)
          .maybeSingle();
        desc = [
          claim?.loss_description || "No description",
          claim?.loss_type ? `Loss type: ${claim.loss_type}` : null,
          claim?.policyholder_address ? `Property: ${claim.policyholder_address}` : null,
        ].filter(Boolean).join("\n");
      }

      const pass1Summary = JSON.stringify(pass1Data, null, 1);
      const totalItems = (pass1Data.photos || []).reduce((s: number, p: any) => s + (p.items?.length || 0), 0);

      const result = await callAIWithRetry("_unused", {
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: PASS2_SYSTEM_PROMPT },
          {
            role: "user",
            content: `CLAIM: ${desc}\n\nRAW PHOTO-BY-PHOTO INVENTORY (${(pass1Data.photos || []).length} photos, ${totalItems} items):\n\n${pass1Summary}`,
          },
        ],
        tools: [pass2ToolSchema],
        tool_choice: { type: "function", function: { name: "report_grouped_analysis" } },
      }, 180000, 2);

      // Save result to DB for polling fallback
      if (jobKey) {
        try {
          await supabase.from("claim_context_pipelines").insert({
            claim_id: claimId,
            stage: `pda_dedup_${jobKey}`,
            status: "completed",
            claim_context: result,
          });
        } catch (e) {
          console.error("Failed to save dedup result cache:", e);
        }
      }

      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // =================== MODE: ESTIMATE (generate cost estimate from damage findings) ===================
    if (mode === "estimate") {
      const { damage_findings } = body;
      if (!damage_findings || !Array.isArray(damage_findings)) {
        throw new Error("damage_findings array is required for estimate mode");
      }

      // Get claim location
      const { data: claim } = await supabase
        .from("claims")
        .select("loss_description, loss_type, policyholder_address, policyholder_city, policyholder_state, policyholder_zip")
        .eq("id", claimId)
        .maybeSingle();

      const location = [
        claim?.policyholder_city,
        claim?.policyholder_state,
        claim?.policyholder_zip,
      ].filter(Boolean).join(", ") || claim?.policyholder_address || "Unknown US location";

      const desc = [
        claim?.loss_description || "No description",
        claim?.loss_type ? `Loss type: ${claim.loss_type}` : null,
      ].filter(Boolean).join("\n");

      const result = await callAIWithRetry("_unused", {
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: ESTIMATE_SYSTEM_PROMPT },
          {
            role: "user",
            content: `PROPERTY LOCATION: ${location}\n\nCLAIM: ${desc}\n\nDAMAGE INVENTORY TO ESTIMATE:\n${JSON.stringify(damage_findings, null, 1)}`,
          },
        ],
        tools: [estimateToolSchema],
        tool_choice: { type: "function", function: { name: "report_cost_estimate" } },
      }, 180000, 2);

      // Save result to DB for polling fallback
      if (jobKey) {
        try {
          await supabase.from("claim_context_pipelines").insert({
            claim_id: claimId,
            stage: `pda_estimate_${jobKey}`,
            status: "completed",
            claim_context: result,
          });
        } catch (e) {
          console.error("Failed to save estimate result cache:", e);
        }
      }

      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // =================== MODE: LIST (get photo IDs for a claim) ===================
    if (mode === "list") {
      const { data: photos, error: photosError } = await supabase
        .from("claim_photos")
        .select("id")
        .eq("claim_id", claimId)
        .order("created_at", { ascending: false });

      if (photosError) throw new Error("Failed to fetch photos");

      const { data: claim } = await supabase
        .from("claims")
        .select("loss_description, loss_type, policyholder_address")
        .eq("id", claimId)
        .maybeSingle();

      const desc = [
        claim?.loss_description || "No description",
        claim?.loss_type ? `Loss type: ${claim.loss_type}` : null,
        claim?.policyholder_address ? `Property: ${claim.policyholder_address}` : null,
      ].filter(Boolean).join("\n");

      return new Response(JSON.stringify({
        photoIds: (photos || []).map(p => p.id),
        claimDescription: desc,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unknown mode: ${mode}`);
  } catch (error: any) {
    console.error("photo-damage-analyzer error:", error);
    const status = error.status || 500;
    return new Response(
      JSON.stringify({ error: error.message || error instanceof Error ? error.message : "Unknown error" }),
      { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
