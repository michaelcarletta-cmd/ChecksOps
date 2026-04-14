import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface DetectedItem {
  label: string;
  confidence: number;
  bounding_box: { x: number; y: number; w: number; h: number };
  estimated_category: string;
}

interface NormalizedItem extends DetectedItem {
  category: string;
  brand: string | null;
  model: string | null;
  brand_confidence: number;
  model_confidence: number;
  attributes: Record<string, string>;
  condition_estimate: string;
}

interface PricedItem extends NormalizedItem {
  rcv: number;
  acv: number;
  pricing_confidence: number;
  pricing_source: string;
  pricing_rationale: string;
  comparable_url: string | null;
  depreciation_rate: number;
  age_years: number;
  needs_review: boolean;
}

const DETECTION_THRESHOLD = 0.6;
const BRAND_MODEL_THRESHOLD = 0.7;
const PRICING_THRESHOLD = 0.7;

const DEFAULT_DEPRECIATION: Record<string, number> = {
  Electronics: 0.15,
  Furniture: 0.05,
  Appliances: 0.10,
  Clothing: 0.25,
  Other: 0.10,
};

async function callAI(
  _apiKey: string,
  model: string,
  messages: Array<{ role: string; content: any }>,
  tools?: any[],
  toolChoice?: any
) {
  const { callWithTools, callVision } = await import("../_shared/ai/openaiClient.ts");
  const { MODEL_VISION } = await import("../_shared/ai/modelRouter.ts");

  // Map Lovable model names to OpenAI model names
  const modelMap: Record<string, string> = {
    "google/gemini-2.5-flash": "gpt-4o-mini",
    "google/gemini-2.5-pro": "gpt-4o",
  };
  const resolvedModel = modelMap[model] || MODEL_VISION;

  if (tools && tools.length > 0) {
    const result = await callWithTools({
      model: resolvedModel,
      messages,
      tools,
      toolChoice,
      temperature: 0.3,
      maxTokens: 4000,
    });
    // Return in original format for backward compat
    return {
      choices: [{
        message: {
          content: result.text,
          tool_calls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
        },
      }],
    };
  } else {
    const result = await callVision({
      model: resolvedModel,
      messages,
      temperature: 0.3,
      maxTokens: 4000,
    });
    return {
      choices: [{
        message: { content: result.text },
      }],
    };
  }
}

// Stage 1: Object Detection
async function detectObjects(apiKey: string, photoUrl: string): Promise<DetectedItem[]> {
  const detectTool = {
    type: "function",
    function: {
      name: "report_detected_items",
      description: "Report all personal property items detected in the room photo",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "Specific item name (e.g., '55-inch flat screen TV', 'leather recliner sofa')" },
                confidence: { type: "number", description: "Detection confidence 0-1" },
                bounding_box: {
                  type: "object",
                  properties: {
                    x: { type: "number", description: "Left edge as percentage 0-100" },
                    y: { type: "number", description: "Top edge as percentage 0-100" },
                    w: { type: "number", description: "Width as percentage 0-100" },
                    h: { type: "number", description: "Height as percentage 0-100" },
                  },
                  required: ["x", "y", "w", "h"],
                },
                estimated_category: {
                  type: "string",
                  enum: ["Electronics", "Furniture", "Appliances", "Clothing", "Kitchenware", "Decor", "Bedding", "Tools", "Sports", "Toys", "Other"],
                },
              },
              required: ["label", "confidence", "bounding_box", "estimated_category"],
            },
          },
        },
        required: ["items"],
      },
    },
  };

  const result = await callAI(
    apiKey,
    "google/gemini-2.5-flash",
    [
      {
        role: "system",
        content: `You are a property claims inventory specialist. Analyze the room photo and identify every personal property item visible. Be thorough—look for items on shelves, walls, floors, tables, countertops. Include electronics, furniture, appliances, decor, clothing, kitchenware, bedding, tools, toys, and sports equipment. For each item, provide a specific descriptive label (not generic), your confidence level, approximate bounding box location in the image (as percentages), and category. Only report items you can clearly see—do not guess at items hidden behind others.`,
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Identify all personal property items in this room photo for an insurance contents claim inventory." },
          { type: "image_url", image_url: { url: photoUrl } },
        ],
      },
    ],
    [detectTool],
    { type: "function", function: { name: "report_detected_items" } }
  );

  const toolCall = result.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) return [];

  try {
    const parsed = JSON.parse(toolCall.function.arguments);
    return parsed.items || [];
  } catch {
    console.error("Failed to parse detection results");
    return [];
  }
}

// Stage 2: Normalization
async function normalizeItems(
  apiKey: string,
  items: DetectedItem[],
  photoUrl: string
): Promise<NormalizedItem[]> {
  const normTool = {
    type: "function",
    function: {
      name: "report_normalized_items",
      description: "Return normalized claim-grade item records",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                original_label: { type: "string" },
                category: { type: "string" },
                brand: { type: "string", description: "Brand if identifiable, null otherwise" },
                model: { type: "string", description: "Model if identifiable, null otherwise" },
                brand_confidence: { type: "number", description: "0-1 confidence in brand identification" },
                model_confidence: { type: "number", description: "0-1 confidence in model identification" },
                attributes: {
                  type: "object",
                  description: "Key-value pairs: color, size, material, etc.",
                },
                condition_estimate: {
                  type: "string",
                  enum: ["new", "good", "fair", "poor"],
                },
              },
              required: ["original_label", "category", "brand_confidence", "model_confidence", "attributes", "condition_estimate"],
            },
          },
        },
        required: ["items"],
      },
    },
  };

  const itemList = items.map((i) => `- ${i.label} (category: ${i.estimated_category})`).join("\n");

  const result = await callAI(
    apiKey,
    "google/gemini-2.5-flash",
    [
      {
        role: "system",
        content: `You are an insurance contents claim specialist. For each detected item, normalize it into a claim-grade record. Identify the brand and model ONLY if you can see identifying marks, logos, or distinctive design in the photo. If you cannot determine brand/model, set them to null and confidence to 0. Estimate the visible condition (new/good/fair/poor). Extract attributes like color, material, approximate size.`,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Normalize these detected items into claim-grade records:\n${itemList}\n\nRefer to the photo for brand/model identification and condition assessment.`,
          },
          { type: "image_url", image_url: { url: photoUrl } },
        ],
      },
    ],
    [normTool],
    { type: "function", function: { name: "report_normalized_items" } }
  );

  const toolCall = result.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) return items.map((i) => ({ ...i, category: i.estimated_category, brand: null, model: null, brand_confidence: 0, model_confidence: 0, attributes: {}, condition_estimate: "good" }));

  try {
    const parsed = JSON.parse(toolCall.function.arguments);
    return (parsed.items || []).map((norm: any, idx: number) => {
      const original = items[idx] || items[0];
      return {
        ...original,
        label: norm.original_label || original.label,
        category: norm.category || original.estimated_category,
        brand: norm.brand || null,
        model: norm.model || null,
        brand_confidence: norm.brand_confidence || 0,
        model_confidence: norm.model_confidence || 0,
        attributes: norm.attributes || {},
        condition_estimate: norm.condition_estimate || "good",
      };
    });
  } catch {
    return items.map((i) => ({ ...i, category: i.estimated_category, brand: null, model: null, brand_confidence: 0, model_confidence: 0, attributes: {}, condition_estimate: "good" }));
  }
}

// Stage 3: Pricing
async function priceItems(apiKey: string, items: NormalizedItem[]): Promise<PricedItem[]> {
  const priceTool = {
    type: "function",
    function: {
      name: "report_priced_items",
      description: "Return pricing for each item",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                original_label: { type: "string" },
                rcv: { type: "number", description: "Replacement Cost Value in USD" },
                pricing_confidence: { type: "number", description: "0-1 confidence in price accuracy" },
                pricing_source: { type: "string", description: "e.g., 'Amazon retail match', 'Home Depot comparable', 'industry average'" },
                pricing_rationale: { type: "string", description: "1-2 sentence explanation of how price was determined" },
                comparable_url: { type: "string", description: "URL to comparable product if known, null otherwise" },
                age_years_estimate: { type: "number", description: "Estimated age in years based on condition" },
              },
              required: ["original_label", "rcv", "pricing_confidence", "pricing_source", "pricing_rationale"],
            },
          },
        },
        required: ["items"],
      },
    },
  };

  const itemDescriptions = items
    .map((i) => {
      const brandStr = i.brand ? ` (${i.brand}${i.model ? " " + i.model : ""})` : "";
      const attrStr = Object.entries(i.attributes || {})
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      return `- ${i.label}${brandStr} | Category: ${i.category} | Condition: ${i.condition_estimate}${attrStr ? " | " + attrStr : ""}`;
    })
    .join("\n");

  const result = await callAI(
    apiKey,
    "google/gemini-2.5-pro",
    [
      {
        role: "system",
        content: `You are a claims-grade contents pricing specialist. For each item, determine the current retail Replacement Cost Value (RCV)—what it would cost to buy an equivalent new item today. Use your knowledge of current retail prices from major retailers (Amazon, Walmart, Home Depot, Best Buy, etc.). Prefer XactContents-style pricing when possible. Be specific about your source and rationale. Estimate age based on condition. If you cannot determine a confident price, use industry averages and note lower confidence.`,
      },
      {
        role: "user",
        content: `Price these personal property items for an insurance contents claim. Provide current retail replacement costs:\n\n${itemDescriptions}`,
      },
    ],
    [priceTool],
    { type: "function", function: { name: "report_priced_items" } }
  );

  const toolCall = result.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) {
    return items.map((i) => ({
      ...i,
      rcv: 0,
      acv: 0,
      pricing_confidence: 0,
      pricing_source: "unavailable",
      pricing_rationale: "Pricing could not be determined",
      comparable_url: null,
      depreciation_rate: DEFAULT_DEPRECIATION[i.category] || 0.1,
      age_years: 3,
      needs_review: true,
    }));
  }

  try {
    const parsed = JSON.parse(toolCall.function.arguments);
    return (parsed.items || []).map((priced: any, idx: number) => {
      const original = items[idx] || items[0];
      const depRate = DEFAULT_DEPRECIATION[original.category] || 0.1;
      const ageYears = priced.age_years_estimate || 3;
      const rcv = priced.rcv || 0;
      const acv = Math.max(rcv * (1 - depRate * ageYears), rcv * 0.1); // Floor at 10% of RCV

      const needsReview =
        original.confidence < DETECTION_THRESHOLD ||
        original.brand_confidence < BRAND_MODEL_THRESHOLD ||
        original.model_confidence < BRAND_MODEL_THRESHOLD ||
        (priced.pricing_confidence || 0) < PRICING_THRESHOLD;

      return {
        ...original,
        rcv,
        acv: Math.round(acv * 100) / 100,
        pricing_confidence: priced.pricing_confidence || 0,
        pricing_source: priced.pricing_source || "industry average",
        pricing_rationale: priced.pricing_rationale || "",
        comparable_url: priced.comparable_url || null,
        depreciation_rate: depRate,
        age_years: ageYears,
        needs_review: needsReview,
      };
    });
  } catch {
    return items.map((i) => ({
      ...i,
      rcv: 0,
      acv: 0,
      pricing_confidence: 0,
      pricing_source: "unavailable",
      pricing_rationale: "Pricing parse error",
      comparable_url: null,
      depreciation_rate: DEFAULT_DEPRECIATION[i.category] || 0.1,
      age_years: 3,
      needs_review: true,
    }));
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { claim_id, photo_ids, scan_run_id } = await req.json();
    if (!claim_id || !photo_ids?.length) {
      return new Response(JSON.stringify({ error: "claim_id and photo_ids required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Update scan run status
    if (scan_run_id) {
      await supabase
        .from("inventory_scan_runs")
        .update({ status: "processing" })
        .eq("id", scan_run_id);
    }

    // Fetch photo URLs
    const { data: photos, error: photoErr } = await supabase
      .from("claim_photos")
      .select("id, file_path, file_name, category")
      .in("id", photo_ids);

    if (photoErr || !photos?.length) {
      throw new Error("Could not fetch photos");
    }

    const allPricedItems: PricedItem[] = [];

    for (const photo of photos) {
      // Get signed URL for the photo
      const { data: signedData } = await supabase.storage
        .from("claim-files")
        .createSignedUrl(photo.file_path, 600);

      if (!signedData?.signedUrl) {
        console.error(`Could not get signed URL for ${photo.file_path}`);
        continue;
      }

      const photoUrl = signedData.signedUrl;

      // Stage 1: Detect
      console.log(`Stage 1: Detecting objects in ${photo.file_name}`);
      const detected = await detectObjects(LOVABLE_API_KEY, photoUrl);
      if (!detected.length) {
        console.log(`No items detected in ${photo.file_name}`);
        continue;
      }
      console.log(`Detected ${detected.length} items`);

      // Stage 2: Normalize
      console.log(`Stage 2: Normalizing ${detected.length} items`);
      const normalized = await normalizeItems("_unused", detected, photoUrl);

      // Stage 3: Price
      console.log(`Stage 3: Pricing ${normalized.length} items`);
      const priced = await priceItems("_unused", normalized);

      // Attach photo reference
      priced.forEach((item) => {
        (item as any).source_photo_id = photo.id;
        (item as any).source_photo_name = photo.file_name;
      });

      allPricedItems.push(...priced);
    }

    // Update scan run
    if (scan_run_id) {
      await supabase
        .from("inventory_scan_runs")
        .update({
          status: "complete",
          detected_count: allPricedItems.length,
          results: allPricedItems as any,
        })
        .eq("id", scan_run_id);
    }

    return new Response(
      JSON.stringify({ items: allPricedItems, total: allPricedItems.length }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Pipeline error:", error);

    // Try to update scan run on error
    try {
      const body = await req.clone().json().catch(() => ({}));
      if (body.scan_run_id) {
        const supabase = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
        );
        await supabase
          .from("inventory_scan_runs")
          .update({ status: "error", error_message: String(error) })
          .eq("id", body.scan_run_id);
      }
    } catch {}

    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
