import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { callVision, MODEL_VISION } from "../_shared/ai/generate.ts";
import { generate } from "../_shared/ai/generate.ts";
import { extractPdfNative, isNativeExtractionUsable } from "../_shared/pdfNativeExtract.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface ExtractedEstimate {
  estimate_type: string | null;
  dwelling: {
    rcv: number;
    recoverable_depreciation: number;
    non_recoverable_depreciation: number;
    deductible: number;
  };
  other_structures: {
    rcv: number;
    recoverable_depreciation: number;
    non_recoverable_depreciation: number;
    deductible: number;
  };
  contents: {
    rcv: number;
    recoverable_depreciation: number;
    non_recoverable_depreciation: number;
  };
  pwi: {
    rcv: number;
    recoverable_depreciation: number;
    non_recoverable_depreciation: number;
    deductible: number;
  };
  line_items: Array<{
    description: string;
    quantity: number;
    unit: string;
    unit_cost: number;
    total: number;
    category: string;
  }>;
  totals: {
    gross_total: number;
    total_depreciation: number;
    net_total: number;
  };
  quality_review?: {
    questionable_count: number;
    questionable_line_items: QuestionableLineItem[];
  };
  estimate_record?: {
    id: string;
    version: number;
    persisted_line_items: number;
  } | null;
  review_prompt?: string;
  raw_text?: string;
}

interface QuestionableLineItem {
  index: number;
  line_item_id?: string;
  description: string;
  quantity: number;
  unit: string;
  unit_cost: number;
  total: number;
  category: string;
  reasons: string[];
  suggested_fixes: string[];
}

interface EstimateExecutionStep {
  key: string;
  label: string;
  status: "started" | "completed" | "error";
  detail?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
}

const toMoneyNumber = (value: unknown, fallback = 0): number => {
  const raw = typeof value === "number" ? value : Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(raw)) return fallback;
  return Math.round(raw * 100) / 100;
};

const toQuantityNumber = (value: unknown, fallback = 1): number => {
  const raw = typeof value === "number" ? value : Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.round(raw * 1000) / 1000;
};

function normalizeLineItems(
  rawLineItems: unknown,
): Array<{
  description: string;
  quantity: number;
  unit: string;
  unit_cost: number;
  total: number;
  category: string;
}> {
  if (!Array.isArray(rawLineItems)) return [];
  return rawLineItems
    .map((item: any) => {
      const description = String(item?.description || "").trim();
      const quantity = toQuantityNumber(item?.quantity, 1);
      const unit = String(item?.unit || "EA").trim().toUpperCase() || "EA";
      const unitCost = toMoneyNumber(item?.unit_cost, 0);
      let total = toMoneyNumber(item?.total, 0);
      if (total <= 0 && quantity > 0 && unitCost > 0) {
        total = Math.round(quantity * unitCost * 100) / 100;
      }
      return {
        description,
        quantity,
        unit,
        unit_cost: unitCost,
        total,
        category: String(item?.category || "General").trim() || "General",
      };
    })
    .filter((item) => item.description.length > 0);
}

function buildLineItemQualityReview(
  lineItems: Array<{
    description: string;
    quantity: number;
    unit: string;
    unit_cost: number;
    total: number;
    category: string;
  }>,
): { questionable_count: number; questionable_line_items: QuestionableLineItem[] } {
  const questionable = lineItems
    .map((item, index) => {
      const reasons: string[] = [];
      const suggestedFixes: string[] = [];
      if (!item.description || item.description.length < 5) {
        reasons.push("Line item description is too short or missing.");
        suggestedFixes.push("Verify description from estimate.");
      }
      if (!item.quantity || item.quantity <= 0) {
        reasons.push("Quantity is zero or missing.");
        suggestedFixes.push("Set a valid quantity.");
      }
      if (!item.unit || item.unit.length > 8) {
        reasons.push("Unit is missing or malformed.");
        suggestedFixes.push("Set a valid unit (EA, SF, LF, etc.).");
      }
      if (!Number.isFinite(item.total) || item.total <= 0) {
        reasons.push("Total amount is missing or zero.");
        suggestedFixes.push("Confirm total from estimate line.");
      }
      if (item.quantity > 0 && item.unit_cost > 0 && item.total > 0) {
        const expected = item.quantity * item.unit_cost;
        const delta = Math.abs(expected - item.total);
        if (delta > Math.max(2, expected * 0.2)) {
          reasons.push("Total does not align with quantity × unit cost.");
          suggestedFixes.push("Recalculate unit price or total.");
        }
      }
      if (!item.category || item.category.toLowerCase() === "general") {
        reasons.push("Category could not be confidently classified.");
        suggestedFixes.push("Confirm trade/category (Roofing, Interior, etc.).");
      }

      if (reasons.length === 0) return null;
      return {
        index,
        description: item.description,
        quantity: item.quantity,
        unit: item.unit,
        unit_cost: item.unit_cost,
        total: item.total,
        category: item.category,
        reasons,
        suggested_fixes: suggestedFixes,
      } as QuestionableLineItem;
    })
    .filter(Boolean) as QuestionableLineItem[];

  return {
    questionable_count: questionable.length,
    questionable_line_items: questionable,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const operationStartedAt = Date.now();
    const executionSteps: EstimateExecutionStep[] = [];
    const startStep = (key: string, label: string, detail?: string) => {
      const step: EstimateExecutionStep = {
        key,
        label,
        status: "started",
        detail,
        startedAt: new Date().toISOString(),
      };
      executionSteps.push(step);
      return step;
    };
    const endStep = (step: EstimateExecutionStep, status: EstimateExecutionStep["status"], detail?: string) => {
      const finished = Date.now();
      step.status = status;
      if (detail) step.detail = detail;
      step.finishedAt = new Date(finished).toISOString();
      step.durationMs = Math.max(0, finished - new Date(step.startedAt).getTime());
    };
    const persistenceWarnings: string[] = [];

    // AI routing handled by shared layer

    const requestStep = startStep("request", "Validate estimate upload request");
    const formData = await req.formData();
    const file = formData.get("file") as File;
    const claimId = formData.get("claimId") as string;

    if (!file) {
      throw new Error("No file provided");
    }
    endStep(requestStep, "completed", `file=${file.name}`);

    console.log(`Processing estimate file: ${file.name}, type: ${file.type}, size: ${file.size}`);

    // Check file size - limit to 8MB to prevent memory issues
    const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8MB
    if (file.size > MAX_FILE_SIZE) {
      throw new Error(`File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum size is 8MB.`);
    }

    const encodeStep = startStep("encode_document", "Prepare estimate document for AI extraction");
    // Convert file to base64 for AI processing - use chunked approach to avoid stack overflow
    const arrayBuffer = await file.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    
    // Process in chunks to avoid "Maximum call stack size exceeded"
    let base64 = '';
    const chunkSize = 32768; // 32KB chunks
    for (let i = 0; i < uint8Array.length; i += chunkSize) {
      const chunk = uint8Array.slice(i, i + chunkSize);
      base64 += String.fromCharCode.apply(null, Array.from(chunk));
    }
    base64 = btoa(base64);
    endStep(encodeStep, "completed", `bytes=${uint8Array.length}`);
    
    const mimeType = file.type || "application/pdf";

    // Use Lovable AI to extract data from the estimate
    const systemPrompt = `You are an expert insurance estimate parser. Your job is to extract financial data from insurance estimates (Xactimate, Symbility, contractor estimates, etc.).

Extract the following information and return it as a JSON object:

{
  "estimate_type": "xactimate" | "symbility" | "contractor" | "unknown",
  "dwelling": {
    "rcv": <number - Replacement Cost Value for dwelling/structure>,
    "recoverable_depreciation": <number - Recoverable depreciation amount>,
    "non_recoverable_depreciation": <number - Non-recoverable depreciation amount>,
    "deductible": <number - Deductible amount if shown>
  },
  "other_structures": {
    "rcv": <number>,
    "recoverable_depreciation": <number>,
    "non_recoverable_depreciation": <number>,
    "deductible": <number>
  },
  "contents": {
    "rcv": <number - Personal property/contents RCV>,
    "recoverable_depreciation": <number>,
    "non_recoverable_depreciation": <number>
  },
  "pwi": {
    "rcv": <number - Paid When Incurred / Ordinance and Law RCV - code upgrade costs paid when work is completed>,
    "recoverable_depreciation": <number>,
    "non_recoverable_depreciation": <number>,
    "deductible": <number>
  },
  "line_items": [
    {
      "description": "<string>",
      "quantity": <number>,
      "unit": "<string - SF, LF, EA, etc>",
      "unit_cost": <number>,
      "total": <number>,
      "category": "<string - Roofing, Siding, Interior, etc>"
    }
  ],
  "totals": {
    "gross_total": <number - Total RCV before deductions>,
    "total_depreciation": <number - All depreciation combined>,
    "net_total": <number - Net claim value>
  }
}

Important guidelines:
- All monetary values should be numbers (not strings)
- If a value is not found in the document, use 0
- Look for common estimate sections: Summary, Line Items, Depreciation Schedule
- For Xactimate estimates, look for "Replacement Cost Value", "Less Depreciation", "Actual Cash Value"
- PWI (Paid When Incurred) is also called "Ordinance and Law" - these are code upgrade costs paid when work is completed
- Look for sections labeled "O&L", "Ordinance & Law", "Ordinance and Law", "PWI", or "Paid When Incurred"
- Extract as many line items as possible with their categories
- The deductible is usually shown separately from depreciation
- Return ONLY the JSON object, no other text`;

    // ── NATIVE-FIRST EXTRACTION (pdf.js) ───────────────────────────────────
    // Most contractor/Xactimate/Symbility estimates are text PDFs. Try native
    // text extraction first ($0). Fall back to AI vision only if the PDF is
    // genuinely scanned/image-only (or it's not a PDF).
    let aiResult: { text: string; model?: string };
    let extractionMode: "native_pdfjs" | "ai_vision" = "ai_vision";

    if (mimeType === "application/pdf") {
      const nativeStep = startStep("native_extract", "Native PDF text extraction (pdf.js)");
      try {
        const native = await extractPdfNative(uint8Array, { fileName: file.name });
        if (isNativeExtractionUsable(native)) {
          endStep(nativeStep, "completed", `chars=${native.charCount}, status=${native.status}`);
          extractionMode = "native_pdfjs";
          console.log(`[extract-estimate] Using native pdf.js text (${native.charCount} chars) — skipping AI vision`);

          const textStep = startStep("ai_extract", "Extract estimate fields from native text (text-only model)");
          const textResult = await generate({
            task: "extraction",
            system: systemPrompt,
            user: `Extract estimate financial data from the following text.\n\nFILENAME: ${file.name}\n\n=== ESTIMATE TEXT ===\n${native.text.slice(0, 120000)}`,
            searchMode: "off",
          });
          aiResult = { text: textResult.text, model: textResult.model };
          endStep(textStep, "completed", `responseChars=${String(textResult.text).length}, model=${textResult.model}`);
        } else {
          endStep(nativeStep, "completed", `insufficient (status=${native.status}, chars=${native.charCount}) — falling back to vision`);
        }
      } catch (nativeErr) {
        endStep(nativeStep, "error", nativeErr instanceof Error ? nativeErr.message : String(nativeErr));
      }
    }

    if (extractionMode === "ai_vision") {
      const aiStep = startStep("ai_extract", "Extract estimate values and line items with AI vision");
      aiResult = await callVision({
        model: MODEL_VISION,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Please extract all financial data from this insurance estimate document. Focus on finding RCV, depreciation amounts, deductibles, and line items.`
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:${mimeType};base64,${base64}`
                }
              }
            ]
          }
        ],
      });
      endStep(aiStep, "completed", `responseChars=${String(aiResult.text).length}`);
    }

    console.log(`[extract-estimate] mode=${extractionMode}, model=${aiResult!.model ?? MODEL_VISION}`);

    const content = aiResult!.text;
    
    console.log("AI response received, parsing JSON...");

    // Parse the JSON from the AI response
    const parseStep = startStep("parse", "Parse AI extraction payload");
    let extractedData: ExtractedEstimate;
    try {
      // Strip markdown fences if present
      let cleaned = content.trim();
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
      
      // Find the outermost JSON object
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        extractedData = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      } else {
        throw new Error("No JSON found in response");
      }
    } catch (parseError) {
      console.error("JSON parse error:", parseError, "Content:", content.slice(0, 500));
      endStep(parseStep, "error", "Failed to parse JSON from model output");
      throw new Error("Failed to parse estimate data from AI response");
    }
    endStep(parseStep, "completed");

    extractedData.dwelling = {
      rcv: toMoneyNumber(extractedData.dwelling?.rcv, 0),
      recoverable_depreciation: toMoneyNumber(extractedData.dwelling?.recoverable_depreciation, 0),
      non_recoverable_depreciation: toMoneyNumber(extractedData.dwelling?.non_recoverable_depreciation, 0),
      deductible: toMoneyNumber(extractedData.dwelling?.deductible, 0),
    };
    extractedData.other_structures = {
      rcv: toMoneyNumber(extractedData.other_structures?.rcv, 0),
      recoverable_depreciation: toMoneyNumber(extractedData.other_structures?.recoverable_depreciation, 0),
      non_recoverable_depreciation: toMoneyNumber(extractedData.other_structures?.non_recoverable_depreciation, 0),
      deductible: toMoneyNumber(extractedData.other_structures?.deductible, 0),
    };
    extractedData.contents = {
      rcv: toMoneyNumber(extractedData.contents?.rcv, 0),
      recoverable_depreciation: toMoneyNumber(extractedData.contents?.recoverable_depreciation, 0),
      non_recoverable_depreciation: toMoneyNumber(extractedData.contents?.non_recoverable_depreciation, 0),
    };
    extractedData.pwi = {
      rcv: toMoneyNumber(extractedData.pwi?.rcv, 0),
      recoverable_depreciation: toMoneyNumber(extractedData.pwi?.recoverable_depreciation, 0),
      non_recoverable_depreciation: toMoneyNumber(extractedData.pwi?.non_recoverable_depreciation, 0),
      deductible: toMoneyNumber(extractedData.pwi?.deductible, 0),
    };
    extractedData.totals = {
      gross_total: toMoneyNumber(extractedData.totals?.gross_total, 0),
      total_depreciation: toMoneyNumber(extractedData.totals?.total_depreciation, 0),
      net_total: toMoneyNumber(extractedData.totals?.net_total, 0),
    };
    extractedData.line_items = normalizeLineItems(extractedData.line_items);
    extractedData.quality_review = buildLineItemQualityReview(extractedData.line_items);
    extractedData.review_prompt = extractedData.quality_review.questionable_count > 0
      ? `Review ${extractedData.quality_review.questionable_count} questionable line item(s) before finalizing.`
      : "No questionable line items detected.";

    console.log("Extracted estimate data:", JSON.stringify(extractedData, null, 2));

    let persistedEstimateRecord: ExtractedEstimate["estimate_record"] = null;

    // If claimId provided, update settlement and persist line items
    if (claimId) {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const supabase = createClient(supabaseUrl, supabaseKey);
      const settlementStep = startStep("persist_settlement", "Update claim settlement totals");

      // Check if settlement exists
      const { data: existingSettlement } = await supabase
        .from("claim_settlements")
        .select("id")
        .eq("claim_id", claimId)
        .maybeSingle();

      const settlementData = {
        replacement_cost_value: extractedData.dwelling?.rcv || 0,
        recoverable_depreciation: extractedData.dwelling?.recoverable_depreciation || 0,
        non_recoverable_depreciation: extractedData.dwelling?.non_recoverable_depreciation || 0,
        deductible: extractedData.dwelling?.deductible || 0,
        estimate_amount: extractedData.totals?.gross_total || 0,
        other_structures_rcv: extractedData.other_structures?.rcv || 0,
        other_structures_recoverable_depreciation: extractedData.other_structures?.recoverable_depreciation || 0,
        other_structures_non_recoverable_depreciation: extractedData.other_structures?.non_recoverable_depreciation || 0,
        other_structures_deductible: extractedData.other_structures?.deductible || 0,
        personal_property_rcv: extractedData.contents?.rcv || 0,
        personal_property_recoverable_depreciation: extractedData.contents?.recoverable_depreciation || 0,
        personal_property_non_recoverable_depreciation: extractedData.contents?.non_recoverable_depreciation || 0,
        pwi_rcv: extractedData.pwi?.rcv || 0,
        pwi_recoverable_depreciation: extractedData.pwi?.recoverable_depreciation || 0,
        pwi_non_recoverable_depreciation: extractedData.pwi?.non_recoverable_depreciation || 0,
        pwi_deductible: extractedData.pwi?.deductible || 0,
      };

      if (existingSettlement) {
        const { error: updateError } = await supabase
          .from("claim_settlements")
          .update(settlementData)
          .eq("id", existingSettlement.id);

        if (updateError) {
          console.error("Settlement update error:", updateError);
          endStep(settlementStep, "error", updateError.message);
          throw updateError;
        }
        console.log("Settlement updated successfully");
      } else {
        const { error: insertError } = await supabase
          .from("claim_settlements")
          .insert({
            ...settlementData,
            claim_id: claimId,
          });

        if (insertError) {
          console.error("Settlement insert error:", insertError);
          endStep(settlementStep, "error", insertError.message);
          throw insertError;
        }
        console.log("Settlement created successfully");
      }
      endStep(settlementStep, "completed");

      const estimateStep = startStep("persist_estimate_line_items", "Persist estimate + line items");
      try {
        const { data: latestEstimate } = await supabase
          .from("claim_estimates")
          .select("version")
          .eq("claim_id", claimId)
          .order("version", { ascending: false })
          .limit(1)
          .maybeSingle();

        const nextVersion = (latestEstimate?.version || 0) + 1;
        const { data: estimateRecord, error: estimateError } = await supabase
          .from("claim_estimates")
          .insert({
            claim_id: claimId,
            vendor: extractedData.estimate_type || "Uploaded Estimate",
            version: nextVersion,
            total_rcv: extractedData.totals?.gross_total || 0,
            total_acv: extractedData.totals?.net_total || 0,
            total_depr: extractedData.totals?.total_depreciation || 0,
            metadata_json: {
              source: "extract-estimate",
              uploaded_file_name: file.name,
              estimate_type: extractedData.estimate_type,
            },
          })
          .select("id, version")
          .single();

        if (estimateError) throw estimateError;

        let persistedLineItems = 0;
        if (Array.isArray(extractedData.line_items) && extractedData.line_items.length > 0) {
          const qualityReasonsByIndex = new Map<number, string[]>();
          for (const q of extractedData.quality_review?.questionable_line_items || []) {
            qualityReasonsByIndex.set(q.index, q.reasons);
          }

          const lineItemRows = extractedData.line_items.map((item, index) => ({
            estimate_id: estimateRecord.id,
            description: item.description,
            category: item.category || "General",
            quantity: item.quantity || 1,
            unit: item.unit || "EA",
            unit_price: item.unit_cost || 0,
            rcv: item.total || 0,
            acv: item.total || 0,
            depreciation: 0,
            metadata_json: {
              source_index: index,
              questionable_reasons: qualityReasonsByIndex.get(index) || [],
            },
          }));

          const { data: insertedLineItems, error: lineItemsError } = await supabase
            .from("estimate_line_items")
            .insert(lineItemRows)
            .select("id, metadata_json");
          if (lineItemsError) throw lineItemsError;
          persistedLineItems = insertedLineItems?.length || 0;

          const idByIndex = new Map<number, string>();
          for (const row of insertedLineItems || []) {
            const idx = Number((row as any)?.metadata_json?.source_index);
            if (Number.isFinite(idx)) {
              idByIndex.set(idx, row.id);
            }
          }
          if (extractedData.quality_review?.questionable_line_items) {
            extractedData.quality_review.questionable_line_items =
              extractedData.quality_review.questionable_line_items.map((item) => ({
                ...item,
                line_item_id: idByIndex.get(item.index),
              }));
          }
        }

        persistedEstimateRecord = {
          id: estimateRecord.id,
          version: estimateRecord.version,
          persisted_line_items: persistedLineItems,
        };
        extractedData.estimate_record = persistedEstimateRecord;
        endStep(estimateStep, "completed", `version=${estimateRecord.version}, lineItems=${persistedLineItems}`);
      } catch (estimatePersistError) {
        const message = estimatePersistError instanceof Error ? estimatePersistError.message : "Unknown estimate persistence error";
        persistenceWarnings.push(`Estimate line-item persistence warning: ${message}`);
        console.error("Estimate line-item persistence warning:", message);
        endStep(estimateStep, "error", message);
      }
    }

    const totalDurationMs = Date.now() - operationStartedAt;
    return new Response(
      JSON.stringify({
        success: true,
        data: extractedData,
        execution_steps: executionSteps,
        processing_metrics: {
          total_duration_ms: totalDurationMs,
          questionable_line_items: extractedData.quality_review?.questionable_count || 0,
          persisted_estimate_id: persistedEstimateRecord?.id || null,
          persisted_line_items: persistedEstimateRecord?.persisted_line_items || 0,
        },
        warnings: persistenceWarnings,
        message: claimId
          ? "Estimate extracted, accounting updated, and line-item intelligence generated"
          : "Estimate extracted successfully",
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Extract estimate error:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
