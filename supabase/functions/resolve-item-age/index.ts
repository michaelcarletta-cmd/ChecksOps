import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callWithTools, callVision } from "../_shared/ai/generate.ts";
import { MODEL_VISION } from "../_shared/ai/modelRouter.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const WEIGHTS = {
  receipt: 60,
  warranty: 50,
  serial_decode: 45,
  document_match: 35,
  model_release: 20,
  user_confirmed: 15,
  visual_only: 10,
};

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

interface DocumentMatch {
  file_id: string;
  file_name: string;
  purchase_date: string | null;
  serial_number: string | null;
  model_number: string | null;
  vendor: string | null;
  amount: number | null;
  match_type: string;
  snippet: string;
}

function trySerialDecode(brand: string | null, serial: string | null): { mfgDate: string | null; rule: string } | null {
  if (!serial || !brand) return null;
  const b = brand.toLowerCase();
  const s = serial.trim();

  if (["whirlpool", "maytag", "kitchenaid", "amana"].includes(b)) {
    const yearLetters: Record<string, number> = {
      C: 2002, D: 2003, E: 2004, F: 2005, G: 2006, H: 2007, J: 2008,
      K: 2009, L: 2010, M: 2011, N: 2012, P: 2013, R: 2014, S: 2015,
      T: 2016, U: 2017, W: 2018, X: 2019, Y: 2020, A: 2021, B: 2022,
    };
    const firstChar = s.charAt(0).toUpperCase();
    if (yearLetters[firstChar]) {
      const week = parseInt(s.substring(1, 3));
      if (week >= 1 && week <= 52) {
        const year = yearLetters[firstChar];
        const month = Math.min(12, Math.ceil(week / 4.33));
        return { mfgDate: `${year}-${String(month).padStart(2, "0")}-01`, rule: "whirlpool_serial_decode" };
      }
    }
  }

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

  if (b === "samsung" && s.length >= 5) {
    const digit = parseInt(s.charAt(4));
    if (!isNaN(digit)) {
      const currentDecade = Math.floor(new Date().getFullYear() / 10) * 10;
      let year = currentDecade + digit;
      if (year > new Date().getFullYear()) year -= 10;
      return { mfgDate: `${year}-06-01`, rule: "samsung_serial_decode" };
    }
  }

  if (b === "lg" && s.length >= 4) {
    const digit = parseInt(s.charAt(2));
    if (!isNaN(digit)) {
      const currentDecade = Math.floor(new Date().getFullYear() / 10) * 10;
      let year = currentDecade + digit;
      if (year > new Date().getFullYear()) year -= 10;
      const monthLetters = "ABCDEFGHJKLM";
      const month = monthLetters.indexOf(s.charAt(3).toUpperCase());
      return {
        mfgDate: `${year}-${String((month >= 0 ? month : 5) + 1).padStart(2, "0")}-01`,
        rule: "lg_serial_decode",
      };
    }
  }

  return null;
}

async function mineDocumentsForItem(
  item: any,
  claimFiles: any[]
): Promise<DocumentMatch[]> {
  if (!claimFiles.length) return [];

  const relevantFiles = claimFiles.filter(f => {
    const cls = f.document_classification || "";
    const name = (f.file_name || "").toLowerCase();
    return (
      cls === "invoice" || cls === "receipt" || cls === "correspondence" ||
      name.includes("receipt") || name.includes("invoice") || name.includes("order") ||
      name.includes("purchase") || name.includes("confirmation") || name.includes("warranty") ||
      (f.extracted_text && f.extracted_text.length > 100)
    );
  });

  if (!relevantFiles.length) return [];

  const searchTerms: string[] = [item.item_name];
  if (item.manufacturer) searchTerms.push(item.manufacturer);
  if (item.model_number) searchTerms.push(item.model_number);
  if (item.serial_number) searchTerms.push(item.serial_number);
  if (item.category) searchTerms.push(item.category);

  const matches: DocumentMatch[] = [];

  for (const file of relevantFiles) {
    const text = file.extracted_text || "";
    if (!text) continue;

    const textLower = text.toLowerCase();
    const hasMatch = searchTerms.some(term => term && textLower.includes(term.toLowerCase()));
    if (!hasMatch) continue;

    try {
      const extractTool = {
        type: "function" as const,
        function: {
          name: "report_purchase_info",
          description: "Extract purchase information for a specific item from document text",
          parameters: {
            type: "object",
            properties: {
              found: { type: "boolean", description: "Whether this document contains purchase info for the item" },
              purchase_date: { type: "string", description: "Purchase date in YYYY-MM-DD format, null if not found" },
              serial_number: { type: "string", description: "Serial number if found" },
              model_number: { type: "string", description: "Model number if found" },
              vendor: { type: "string", description: "Vendor/store name if found" },
              amount: { type: "number", description: "Purchase amount if found" },
              match_confidence: { type: "number", description: "0-1 confidence" },
              relevant_snippet: { type: "string", description: "1-2 sentence excerpt" },
            },
            required: ["found", "match_confidence"],
          },
        },
      };

      const truncatedText = text.substring(0, 8000);

      const result = await callWithTools({
        model: MODEL_VISION,
        messages: [
          {
            role: "system",
            content: `You are a forensic document analyst for insurance claims. Given a document's text and an inventory item, determine if the document contains purchase information for that specific item. Be strict about matching.`,
          },
          {
            role: "user",
            content: `ITEM TO FIND:\n- Name: ${item.item_name}\n- Brand: ${item.manufacturer || "unknown"}\n- Model: ${item.model_number || "unknown"}\n- Category: ${item.category || "unknown"}\n\nDOCUMENT TEXT (from "${file.file_name}"):\n${truncatedText}`,
          },
        ],
        tools: [extractTool],
        toolChoice: { type: "function", function: { name: "report_purchase_info" } },
      });

      const tc = result.toolCalls?.[0];
      if (tc) {
        const info = JSON.parse(tc.arguments);
        if (info.found && info.match_confidence > 0.5) {
          matches.push({
            file_id: file.id,
            file_name: file.file_name,
            purchase_date: info.purchase_date || null,
            serial_number: info.serial_number || null,
            model_number: info.model_number || null,
            vendor: info.vendor || null,
            amount: info.amount || null,
            match_type: info.purchase_date ? "purchase_date" : "item_reference",
            snippet: info.relevant_snippet || "",
          });
        }
      }
    } catch (e) {
      console.error(`Document mining failed for file ${file.id}:`, e);
    }
  }

  return matches;
}

async function resolveAge(
  item: any,
  claimFiles: any[],
  lossDate: string | null,
  supabase: any
): Promise<ResolveResult> {
  const now = new Date();
  const evidence: EvidenceEntry[] = [];
  let bestDate: Date | null = null;
  let lowDate: Date | null = null;
  let highDate: Date | null = null;
  let totalWeight = 0;

  if (item.original_purchase_date) {
    const d = new Date(item.original_purchase_date);
    bestDate = d;
    lowDate = d;
    highDate = d;
    evidence.push({ type: "user_entered", weight: WEIGHTS.user_confirmed, date: item.original_purchase_date, source: "User entered purchase date" });
    totalWeight += WEIGHTS.user_confirmed;
  }

  if (item.receipt_file_path) {
    evidence.push({ type: "receipt", weight: WEIGHTS.receipt, source: "Receipt on file", snippet: item.receipt_file_path });
    totalWeight += WEIGHTS.receipt;
  }

  // Label photo analysis
  if (item.label_photo_path) {
    try {
      const { data: labelData } = await supabase.storage
        .from("claim-files")
        .createSignedUrl(item.label_photo_path, 300);

      if (labelData?.signedUrl) {
        const labelTool = {
          type: "function" as const,
          function: {
            name: "report_label_info",
            description: "Extract information from a product label/serial plate photo",
            parameters: {
              type: "object",
              properties: {
                serial_number: { type: "string" },
                model_number: { type: "string" },
                brand: { type: "string" },
                manufacture_date: { type: "string" },
                wattage_or_specs: { type: "string" },
                raw_text: { type: "string" },
              },
              required: ["raw_text"],
            },
          },
        };

        const labelResult = await callWithTools({
          model: MODEL_VISION,
          messages: [
            { role: "system", content: "You are an expert at reading product labels, serial plates, and rating plates. Extract all visible text, especially serial numbers, model numbers, manufacture dates, and brand names." },
            {
              role: "user",
              content: [
                { type: "text", text: `Read all text from this product label. The item is: ${item.item_name} (brand: ${item.manufacturer || "unknown"})` },
                { type: "image_url", image_url: { url: labelData.signedUrl } },
              ],
            },
          ],
          tools: [labelTool],
          toolChoice: { type: "function", function: { name: "report_label_info" } },
        });

        const tc = labelResult.toolCalls?.[0];
        if (tc) {
          const labelInfo = JSON.parse(tc.arguments);

          if (labelInfo.manufacture_date) {
            const mfgDate = new Date(labelInfo.manufacture_date + (labelInfo.manufacture_date.length <= 7 ? "-01" : ""));
            if (!isNaN(mfgDate.getTime())) {
              const purchaseBest = new Date(mfgDate);
              purchaseBest.setMonth(purchaseBest.getMonth() + 3);
              bestDate = purchaseBest;
              lowDate = mfgDate;
              highDate = new Date(mfgDate);
              highDate.setMonth(highDate.getMonth() + 12);

              evidence.push({ type: "label_photo", weight: WEIGHTS.serial_decode, date: labelInfo.manufacture_date, source: `Manufacture date read from label photo: ${labelInfo.manufacture_date}` });
              totalWeight += WEIGHTS.serial_decode;
            }
          }

          if (labelInfo.serial_number && !item.serial_number) {
            item.serial_number = labelInfo.serial_number;
            evidence.push({ type: "label_serial_ocr", weight: 5, serial: labelInfo.serial_number, source: `Serial extracted from label photo: ${labelInfo.serial_number}` });
          }

          if (labelInfo.model_number && !item.model_number) {
            item.model_number = labelInfo.model_number;
            evidence.push({ type: "label_model_ocr", weight: 5, model: labelInfo.model_number, source: `Model extracted from label photo: ${labelInfo.model_number}` });
          }

          if (labelInfo.brand && !item.manufacturer) {
            item.manufacturer = labelInfo.brand;
          }
        }
      }
    } catch (e) {
      console.error("Label photo analysis failed:", e);
    }
  }

  // Serial decode
  const serialResult = trySerialDecode(item.manufacturer, item.serial_number);
  if (serialResult) {
    const mfgDate = new Date(serialResult.mfgDate!);
    const purchaseLow = new Date(mfgDate);
    const purchaseHigh = new Date(mfgDate);
    purchaseHigh.setMonth(purchaseHigh.getMonth() + 12);
    const purchaseBest = new Date(mfgDate);
    purchaseBest.setMonth(purchaseBest.getMonth() + 3);

    if (!bestDate || totalWeight < WEIGHTS.serial_decode) {
      bestDate = purchaseBest;
      lowDate = purchaseLow;
      highDate = purchaseHigh;
    }

    evidence.push({ type: "serial_decode", weight: WEIGHTS.serial_decode, date: serialResult.mfgDate!, brand: item.manufacturer, serial: item.serial_number, rule_used: serialResult.rule, source: `Manufacture date decoded from serial: ${serialResult.mfgDate}` });
    totalWeight += WEIGHTS.serial_decode;
  }

  // Document mining
  const docMatches = await mineDocumentsForItem(item, claimFiles);
  for (const match of docMatches) {
    if (match.purchase_date) {
      const docDate = new Date(match.purchase_date);
      if (!isNaN(docDate.getTime()) && docDate <= now) {
        const weight = match.match_type === "purchase_date" ? WEIGHTS.receipt : WEIGHTS.document_match;
        if (!bestDate || weight > totalWeight) {
          bestDate = docDate;
          lowDate = docDate;
          highDate = docDate;
        }
        evidence.push({ type: "document_match", weight, date: match.purchase_date, file_id: match.file_id, source: `Purchase date found in "${match.file_name}"${match.vendor ? ` from ${match.vendor}` : ""}`, snippet: match.snippet });
        totalWeight += weight;
      }
    }

    if (match.serial_number && !item.serial_number) {
      evidence.push({ type: "document_serial", weight: 5, serial: match.serial_number, file_id: match.file_id, source: `Serial number found in "${match.file_name}": ${match.serial_number}` });
      const docSerialResult = trySerialDecode(item.manufacturer, match.serial_number);
      if (docSerialResult && !bestDate) {
        const mfgDate = new Date(docSerialResult.mfgDate!);
        bestDate = new Date(mfgDate);
        bestDate.setMonth(bestDate.getMonth() + 3);
        lowDate = mfgDate;
        highDate = new Date(mfgDate);
        highDate.setMonth(highDate.getMonth() + 12);
        evidence.push({ type: "serial_decode", weight: WEIGHTS.serial_decode, date: docSerialResult.mfgDate!, rule_used: docSerialResult.rule, source: `Serial from doc decoded: mfg ${docSerialResult.mfgDate}` });
        totalWeight += WEIGHTS.serial_decode;
      }
    }

    if (match.model_number && !item.model_number) {
      evidence.push({ type: "document_model", weight: 5, model: match.model_number, file_id: match.file_id, source: `Model number found in "${match.file_name}": ${match.model_number}` });
    }
  }

  // Model release year lookup
  const modelNum = item.model_number || docMatches.find(m => m.model_number)?.model_number;
  if (item.manufacturer && modelNum && totalWeight < 60) {
    try {
      const modelTool = {
        type: "function" as const,
        function: {
          name: "report_model_info",
          description: "Report the known release year range for a product model",
          parameters: {
            type: "object",
            properties: {
              release_year: { type: "integer" },
              discontinued_year: { type: "integer" },
              confidence: { type: "number" },
            },
            required: ["release_year", "confidence"],
          },
        },
      };

      const result = await callWithTools({
        model: MODEL_VISION,
        messages: [
          { role: "system", content: "You are a product database. Given a brand and model number, report the year range it was available for sale. Only report if reasonably confident." },
          { role: "user", content: `Brand: ${item.manufacturer}\nModel: ${modelNum}\nWhat years was this model sold?` },
        ],
        tools: [modelTool],
        toolChoice: { type: "function", function: { name: "report_model_info" } },
      });

      const tc = result.toolCalls?.[0];
      if (tc) {
        const info = JSON.parse(tc.arguments);
        if (info.confidence > 0.3 && info.release_year && info.release_year >= 1900 && info.release_year <= new Date().getFullYear() + 1) {
          const relYear = info.release_year;
          const discYear = Math.min(info.discontinued_year || relYear + 5, new Date().getFullYear() + 1);
          const modelLow = new Date(`${relYear}-01-01`);
          const modelHigh = new Date(`${discYear}-12-31`);
          const modelBest = new Date(`${Math.round((relYear + Math.min(discYear, relYear + 3)) / 2)}-06-01`);

          if (!bestDate) {
            bestDate = modelBest;
            lowDate = modelLow;
            highDate = modelHigh;
          } else {
            if (lowDate && modelLow > lowDate) lowDate = modelLow;
            if (highDate && modelHigh < highDate) highDate = modelHigh;
          }

          evidence.push({ type: "model_release", weight: WEIGHTS.model_release, model: modelNum, brand: item.manufacturer, release_year: relYear, source: `Model released ~${relYear}${info.discontinued_year ? `, discontinued ~${info.discontinued_year}` : ""}` });
          totalWeight += Math.round(WEIGHTS.model_release * info.confidence);
        }
      }
    } catch (e) {
      console.error("Model lookup failed:", e);
    }
  }

  // Category lifecycle priors
  const cat = item.category || "Other";
  const lifecycle = CATEGORY_LIFECYCLE[cat] || CATEGORY_LIFECYCLE.Other;

  if (!bestDate) {
    const conditionAge: Record<string, number> = { new: 0.5, good: 2, fair: 5, poor: 8 };
    const estAge = conditionAge[item.condition_before_loss] || lifecycle.avg;
    const refDate = lossDate ? new Date(lossDate) : now;
    bestDate = new Date(refDate);
    bestDate.setFullYear(bestDate.getFullYear() - Math.round(estAge));
    lowDate = new Date(refDate);
    lowDate.setFullYear(lowDate.getFullYear() - lifecycle.max);
    highDate = new Date(refDate);
    highDate.setFullYear(highDate.getFullYear() - lifecycle.min);

    evidence.push({ type: "category_prior", weight: WEIGHTS.visual_only, source: `Category lifecycle estimate (${cat}: avg ${lifecycle.avg} yrs) + condition: ${item.condition_before_loss || "unknown"}` });
    totalWeight += WEIGHTS.visual_only;
  }

  const confidence = Math.min(100, totalWeight);
  const refDate = lossDate ? new Date(lossDate) : now;

  const MIN_YEAR = 1900;
  const MAX_YEAR = now.getFullYear() + 1;
  const clampDate = (d: Date | null): Date | null => {
    if (!d || isNaN(d.getTime())) return null;
    const y = d.getFullYear();
    if (y < MIN_YEAR || y > MAX_YEAR) return null;
    return d;
  };

  bestDate = clampDate(bestDate) || refDate;
  lowDate = clampDate(lowDate);
  highDate = clampDate(highDate);

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

    const { data: claim } = await supabase
      .from("claims")
      .select("loss_date")
      .eq("id", claim_id)
      .single();

    const lossDate = claim?.loss_date || null;

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

    const { data: claimFiles } = await supabase
      .from("claim_files")
      .select("id, file_name, file_path, category, extracted_text, document_classification")
      .eq("claim_id", claim_id);

    const results: any[] = [];

    for (const item of items) {
      try {
        console.log(`Resolving age for: ${item.item_name}`);
        const result = await resolveAge(item, claimFiles || [], lossDate, supabase);

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

        results.push({ item_id: item.id, item_name: item.item_name, ...result });
      } catch (itemErr) {
        console.error(`Error resolving item ${item.id} (${item.item_name}):`, itemErr);
        results.push({ item_id: item.id, item_name: item.item_name, error: String(itemErr) });
      }
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
