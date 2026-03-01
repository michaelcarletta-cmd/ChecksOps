import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Evidence weights
const WEIGHTS = {
  receipt: 60,
  warranty: 50,
  serial_decode: 45,
  model_release: 20,
  user_confirmed: 15,
  visual_only: 10,
};

// Category lifecycle priors (average useful life in years)
const CATEGORY_LIFECYCLE: Record<string, { avg: number; min: number; max: number }> = {
  Electronics: { avg: 4, min: 1, max: 8 },
  Furniture: { avg: 10, min: 3, max: 25 },
  Appliances: { avg: 10, min: 5, max: 20 },
  Clothing: { avg: 3, min: 1, max: 7 },
  Kitchenware: { avg: 8, min: 3, max: 15 },
  Decor: { avg: 8, min: 2, max: 20 },
  Bedding: { avg: 5, min: 2, max: 10 },
  Tools: { avg: 12, min: 5, max: 30 },
  Sports: { avg: 5, min: 2, max: 12 },
  Toys: { avg: 3, min: 1, max: 8 },
  Other: { avg: 5, min: 1, max: 15 },
};

// Categories likely to have labels/serials
const LABEL_CATEGORIES = new Set([
  "Electronics", "Appliances", "Tools", "HVAC", "Plumbing", "Water Heater",
]);

interface EvidenceEntry {
  type: string;
  weight: number;
  date?: string;
  source?: string;
  snippet?: string;
  file_id?: string;
  brand?: string;
  serial?: string;
  model?: string;
  rule_used?: string;
  release_year?: number;
}

interface ResolveResult {
  purchase_date_best: string | null;
  purchase_date_low: string | null;
  purchase_date_high: string | null;
  age_years_best: number;
  age_confidence_score: number;
  evidence_json: EvidenceEntry[];
  needs_age_review: boolean;
}

async function callAI(
  apiKey: string,
  messages: Array<{ role: string; content: any }>,
  tools?: any[],
  toolChoice?: any
) {
  const body: any = { model: "google/gemini-2.5-flash", messages };
  if (tools) {
    body.tools = tools;
    body.tool_choice = toolChoice;
  }

  const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`AI gateway error ${resp.status}: ${text}`);
  }
  return resp.json();
}

// Try to decode serial number for manufacture date
function trySerialDecode(brand: string | null, serial: string | null): { mfgDate: string | null; rule: string } | null {
  if (!serial || !brand) return null;
  const b = brand.toLowerCase();
  const s = serial.trim();

  // Whirlpool/Maytag/KitchenAid: Year letter + week pattern
  if (["whirlpool", "maytag", "kitchenaid", "amana"].includes(b)) {
    // Format: YWwwwwwww where Y is year letter
    const yearLetters: Record<string, number> = {
      C: 2002, D: 2003, E: 2004, F: 2005, G: 2006, H: 2007, J: 2008,
      K: 2009, L: 2010, M: 2011, N: 2012, P: 2013, R: 2014, S: 2015,
      T: 2016, U: 2017, W: 2018, X: 2019, Y: 2020, A: 2021, B: 2022,
    };
    const firstChar = s.charAt(0).toUpperCase();
    if (yearLetters[firstChar]) {
      const weekStr = s.substring(1, 3);
      const week = parseInt(weekStr);
      if (week >= 1 && week <= 52) {
        const year = yearLetters[firstChar];
        // Approximate month from week
        const month = Math.min(12, Math.ceil(week / 4.33));
        return { mfgDate: `${year}-${String(month).padStart(2, "0")}-01`, rule: "whirlpool_serial_decode" };
      }
    }
  }

  // GE: Two-letter date code
  if (["ge", "general electric", "hotpoint"].includes(b)) {
    const monthLetters = "ABCDEFGHJKLM";
    const yearLetters = "ABCDEFGHJKLMNPRSTUVWXYZ";
    if (s.length >= 2) {
      const m = monthLetters.indexOf(s.charAt(0).toUpperCase());
      const y = yearLetters.indexOf(s.charAt(1).toUpperCase());
      if (m >= 0 && y >= 0) {
        const year = 2000 + y;
        if (year <= new Date().getFullYear()) {
          return { mfgDate: `${year}-${String(m + 1).padStart(2, "0")}-01`, rule: "ge_serial_decode" };
        }
      }
    }
  }

  // Samsung: Year digit in 5th position
  if (b === "samsung") {
    if (s.length >= 5) {
      const digitChar = s.charAt(4);
      const digit = parseInt(digitChar);
      if (!isNaN(digit)) {
        // Cycle repeats every 10 years; assume 2010s-2020s
        const currentDecade = Math.floor(new Date().getFullYear() / 10) * 10;
        let year = currentDecade + digit;
        if (year > new Date().getFullYear()) year -= 10;
        return { mfgDate: `${year}-06-01`, rule: "samsung_serial_decode" };
      }
    }
  }

  // LG: Year digit in 3rd position
  if (b === "lg") {
    if (s.length >= 4) {
      const digit = parseInt(s.charAt(2));
      if (!isNaN(digit)) {
        const currentDecade = Math.floor(new Date().getFullYear() / 10) * 10;
        let year = currentDecade + digit;
        if (year > new Date().getFullYear()) year -= 10;
        const monthCode = s.charAt(3).toUpperCase();
        const monthLetters = "ABCDEFGHJKLM";
        const month = monthLetters.indexOf(monthCode);
        return {
          mfgDate: `${year}-${String((month >= 0 ? month : 5) + 1).padStart(2, "0")}-01`,
          rule: "lg_serial_decode",
        };
      }
    }
  }

  return null;
}

async function resolveAge(
  apiKey: string,
  item: any,
  claimFiles: any[],
  lossDate: string | null
): Promise<ResolveResult> {
  const now = new Date();
  const evidence: EvidenceEntry[] = [];
  let bestDate: Date | null = null;
  let lowDate: Date | null = null;
  let highDate: Date | null = null;
  let totalWeight = 0;

  // --- Tier A: Receipt / purchase date ---
  if (item.original_purchase_date) {
    const d = new Date(item.original_purchase_date);
    bestDate = d;
    lowDate = d;
    highDate = d;
    evidence.push({
      type: "user_entered",
      weight: WEIGHTS.user_confirmed,
      date: item.original_purchase_date,
      source: "User entered purchase date",
    });
    totalWeight += WEIGHTS.user_confirmed;
  }

  // Check for receipt file
  if (item.receipt_file_path) {
    // We have a receipt on file — assume its date matches purchase date
    evidence.push({
      type: "receipt",
      weight: WEIGHTS.receipt,
      source: "Receipt on file",
      snippet: item.receipt_file_path,
    });
    totalWeight += WEIGHTS.receipt;
  }

  // --- Tier A: Serial decode ---
  const serialResult = trySerialDecode(item.manufacturer, item.serial_number);
  if (serialResult) {
    const mfgDate = new Date(serialResult.mfgDate);
    // Purchase typically 0–12 months after manufacture
    const purchaseLow = new Date(mfgDate);
    const purchaseHigh = new Date(mfgDate);
    purchaseHigh.setMonth(purchaseHigh.getMonth() + 12);
    const purchaseBest = new Date(mfgDate);
    purchaseBest.setMonth(purchaseBest.getMonth() + 3); // typical 3mo lag

    if (!bestDate || totalWeight < WEIGHTS.serial_decode) {
      bestDate = purchaseBest;
      lowDate = purchaseLow;
      highDate = purchaseHigh;
    }

    evidence.push({
      type: "serial_decode",
      weight: WEIGHTS.serial_decode,
      date: serialResult.mfgDate,
      brand: item.manufacturer,
      serial: item.serial_number,
      rule_used: serialResult.rule,
      source: `Manufacture date decoded from serial: ${serialResult.mfgDate}`,
    });
    totalWeight += WEIGHTS.serial_decode;
  }

  // --- Tier B: Model release year (use AI) ---
  if (item.manufacturer && item.model_number && totalWeight < 60) {
    try {
      const modelTool = {
        type: "function",
        function: {
          name: "report_model_info",
          description: "Report the known release year range for a product model",
          parameters: {
            type: "object",
            properties: {
              release_year: { type: "integer", description: "Year the model was first released/sold" },
              discontinued_year: { type: "integer", description: "Year the model was discontinued, null if still sold" },
              confidence: { type: "number", description: "0-1 confidence in these dates" },
            },
            required: ["release_year", "confidence"],
          },
        },
      };

      const result = await callAI(
        apiKey,
        [
          {
            role: "system",
            content: "You are a product database. Given a brand and model number, report the year range it was available for sale. Only report if you are reasonably confident. If unknown, set confidence to 0.",
          },
          {
            role: "user",
            content: `Brand: ${item.manufacturer}\nModel: ${item.model_number}\nWhat years was this model sold?`,
          },
        ],
        [modelTool],
        { type: "function", function: { name: "report_model_info" } }
      );

      const tc = result.choices?.[0]?.message?.tool_calls?.[0];
      if (tc) {
        const info = JSON.parse(tc.function.arguments);
        if (info.confidence > 0.3 && info.release_year) {
          const relYear = info.release_year;
          const discYear = info.discontinued_year || relYear + 5;
          const modelLow = new Date(`${relYear}-01-01`);
          const modelHigh = new Date(`${discYear}-12-31`);
          const modelBest = new Date(`${Math.round((relYear + Math.min(discYear, relYear + 3)) / 2)}-06-01`);

          if (!bestDate) {
            bestDate = modelBest;
            lowDate = modelLow;
            highDate = modelHigh;
          } else {
            // Narrow existing range
            if (lowDate && modelLow > lowDate) lowDate = modelLow;
            if (highDate && modelHigh < highDate) highDate = modelHigh;
          }

          evidence.push({
            type: "model_release",
            weight: WEIGHTS.model_release,
            model: item.model_number,
            brand: item.manufacturer,
            release_year: relYear,
            source: `Model released ~${relYear}${info.discontinued_year ? `, discontinued ~${info.discontinued_year}` : ""}`,
          });
          totalWeight += Math.round(WEIGHTS.model_release * info.confidence);
        }
      }
    } catch (e) {
      console.error("Model lookup failed:", e);
    }
  }

  // --- Tier C: Category lifecycle priors ---
  const cat = item.category || "Other";
  const lifecycle = CATEGORY_LIFECYCLE[cat] || CATEGORY_LIFECYCLE.Other;

  if (!bestDate) {
    // Fall back to condition-based estimate
    const conditionAge: Record<string, number> = { new: 0.5, good: 2, fair: 5, poor: 8 };
    const estAge = conditionAge[item.condition_before_loss] || lifecycle.avg;
    const refDate = lossDate ? new Date(lossDate) : now;
    bestDate = new Date(refDate);
    bestDate.setFullYear(bestDate.getFullYear() - Math.round(estAge));
    lowDate = new Date(refDate);
    lowDate.setFullYear(lowDate.getFullYear() - lifecycle.max);
    highDate = new Date(refDate);
    highDate.setFullYear(highDate.getFullYear() - lifecycle.min);

    evidence.push({
      type: "category_prior",
      weight: WEIGHTS.visual_only,
      source: `Category lifecycle estimate (${cat}: avg ${lifecycle.avg} yrs) + condition: ${item.condition_before_loss || "unknown"}`,
    });
    totalWeight += WEIGHTS.visual_only;
  }

  // Clamp confidence to 100
  const confidence = Math.min(100, totalWeight);

  // Calculate age
  const refDate = lossDate ? new Date(lossDate) : now;
  const ageYears = Math.max(0, (refDate.getTime() - bestDate.getTime()) / (365.25 * 24 * 3600 * 1000));

  const needsReview = confidence < 60 && LABEL_CATEGORIES.has(cat);

  return {
    purchase_date_best: bestDate.toISOString().split("T")[0],
    purchase_date_low: lowDate ? lowDate.toISOString().split("T")[0] : null,
    purchase_date_high: highDate ? highDate.toISOString().split("T")[0] : null,
    age_years_best: Math.round(ageYears * 10) / 10,
    age_confidence_score: confidence,
    evidence_json: evidence,
    needs_age_review: needsReview,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { item_ids, claim_id } = await req.json();
    if (!claim_id) {
      return new Response(JSON.stringify({ error: "claim_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch claim for loss_date
    const { data: claim } = await supabase
      .from("claims")
      .select("loss_date")
      .eq("id", claim_id)
      .single();

    const lossDate = claim?.loss_date || null;

    // Fetch items to resolve
    let query = supabase
      .from("claim_home_inventory")
      .select("*")
      .eq("claim_id", claim_id);

    if (item_ids?.length) {
      query = query.in("id", item_ids);
    }

    const { data: items, error: itemsErr } = await query;
    if (itemsErr || !items?.length) {
      return new Response(JSON.stringify({ error: "No items found", detail: itemsErr }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch claim files for receipt matching (future use)
    const { data: claimFiles } = await supabase
      .from("claim_files")
      .select("id, file_name, file_path, category, extracted_text")
      .eq("claim_id", claim_id);

    const results: any[] = [];

    for (const item of items) {
      console.log(`Resolving age for: ${item.item_name}`);
      const result = await resolveAge(LOVABLE_API_KEY, item, claimFiles || [], lossDate);

      // Update the item in the database
      const { error: updateErr } = await supabase
        .from("claim_home_inventory")
        .update({
          purchase_date_best: result.purchase_date_best,
          purchase_date_low: result.purchase_date_low,
          purchase_date_high: result.purchase_date_high,
          age_years: result.age_years_best,
          age_confidence_score: result.age_confidence_score,
          evidence_json: result.evidence_json,
          needs_age_review: result.needs_age_review,
        } as any)
        .eq("id", item.id);

      if (updateErr) {
        console.error(`Failed to update item ${item.id}:`, updateErr);
      }

      results.push({
        item_id: item.id,
        item_name: item.item_name,
        ...result,
      });
    }

    return new Response(
      JSON.stringify({ resolved: results.length, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Resolve age error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
