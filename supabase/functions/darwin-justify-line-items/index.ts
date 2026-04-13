import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ALLOWED_STATES = ["NJ", "PA", "SC"];

interface LineItem {
  description: string;
  quantity?: number;
  unit?: string;
  code?: string;
  trade?: string;
}

interface RequestBody {
  claimId: string;
  lineItems: LineItem[];
  stateCode: string;
  manufacturer?: string;
  lossType?: string;
  viewMode?: "internal" | "carrier";
}

// ── Data Retrieval ──────────────────────────────────────────────

async function queryKnowledgeBase(
  supabase: any,
  searchTerms: string[],
  categories: string[]
): Promise<{ source: string; content: string; category: string; score: number }[]> {
  const results: any[] = [];

  for (const term of searchTerms.slice(0, 5)) {
    const { data } = await supabase
      .from("ai_knowledge_chunks")
      .select("content, metadata, document_id")
      .textSearch("content", term.split(/\s+/).join(" & "), { type: "plain" })
      .limit(3);

    if (data?.length) {
      // Get document info for these chunks
      const docIds = [...new Set(data.map((d: any) => d.document_id))];
      const { data: docs } = await supabase
        .from("ai_knowledge_documents")
        .select("id, file_name, category")
        .in("id", docIds);

      const docMap = new Map((docs || []).map((d: any) => [d.id, d]));

      for (const chunk of data) {
        const doc = docMap.get(chunk.document_id);
        if (doc && (categories.length === 0 || categories.includes(doc.category))) {
          results.push({
            source: doc.file_name,
            content: chunk.content.slice(0, 500),
            category: doc.category,
            score: 0.8,
          });
        }
      }
    }
  }

  // Deduplicate by content similarity
  const seen = new Set<string>();
  return results.filter((r) => {
    const key = r.content.slice(0, 100);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);
}

async function queryBuildingCodes(
  supabase: any,
  normalizedItems: string[],
  stateCode: string
): Promise<{ section: string; title: string; source: string; content: string; state: string }[]> {
  if (!ALLOWED_STATES.includes(stateCode.toUpperCase())) return [];

  // Build keyword list from item names
  const keywords = normalizedItems.flatMap((item) =>
    item.toLowerCase().split(/[\s\/&]+/).filter((w) => w.length > 2)
  );

  const { data } = await supabase
    .from("building_code_citations")
    .select("section_number, section_title, code_source, content, state_adoptions, keywords")
    .contains("state_adoptions", [stateCode.toUpperCase()])
    .limit(50);

  if (!data?.length) return [];

  // Score and rank by keyword relevance
  const scored = data.map((row: any) => {
    const rowKeywords = (row.keywords || []).map((k: string) => k.toLowerCase());
    const contentLower = row.content.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (rowKeywords.includes(kw)) score += 3;
      if (contentLower.includes(kw)) score += 1;
    }
    return { ...row, score };
  });

  return scored
    .filter((s: any) => s.score > 0)
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, 10)
    .map((r: any) => ({
      section: r.section_number,
      title: r.section_title || "",
      source: r.code_source,
      content: r.content.slice(0, 600),
      state: stateCode.toUpperCase(),
    }));
}

async function queryManufacturerSpecs(
  supabase: any,
  searchTerms: string[],
  manufacturer?: string
): Promise<{ source: string; content: string; category: string }[]> {
  const results: any[] = [];

  for (const term of searchTerms.slice(0, 3)) {
    let query = supabase
      .from("ai_knowledge_chunks")
      .select("content, document_id")
      .textSearch("content", term.split(/\s+/).join(" & "), { type: "plain" })
      .limit(3);

    const { data } = await query;
    if (!data?.length) continue;

    const docIds = [...new Set(data.map((d: any) => d.document_id))];
    const { data: docs } = await supabase
      .from("ai_knowledge_documents")
      .select("id, file_name, category")
      .in("id", docIds)
      .eq("category", "manufacturer-specs");

    const docMap = new Map((docs || []).map((d: any) => [d.id, d]));

    for (const chunk of data) {
      const doc = docMap.get(chunk.document_id);
      if (doc) {
        results.push({
          source: doc.file_name,
          content: chunk.content.slice(0, 500),
          category: "manufacturer-specs",
        });
      }
    }
  }

  const seen = new Set<string>();
  return results.filter((r) => {
    const key = r.content.slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
}

// ── AI Call ──────────────────────────────────────────────────────

async function callAI(systemPrompt: string, userPrompt: string): Promise<string> {
  const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LOVABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
    }),
  });

  if (!resp.ok) {
    const status = resp.status;
    if (status === 429) throw new Error("RATE_LIMIT");
    if (status === 402) throw new Error("CREDITS_EXHAUSTED");
    throw new Error(`AI gateway error: ${status}`);
  }

  const json = await resp.json();
  return json.choices?.[0]?.message?.content || "";
}

// ── Main Handler ────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body: RequestBody = await req.json();
    const { claimId, lineItems, stateCode, manufacturer, lossType, viewMode = "internal" } = body;

    if (!claimId || !lineItems?.length) {
      return new Response(
        JSON.stringify({ ok: false, error: "Missing claimId or lineItems" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const effectiveState = ALLOWED_STATES.includes(stateCode?.toUpperCase()) ? stateCode.toUpperCase() : "";

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Build search terms from line items
    const searchTerms = lineItems.map((li) => li.description || li.code || "").filter(Boolean);
    const uniqueTerms = [...new Set(searchTerms)];

    // Parallel data retrieval
    const [kbChunks, codeCitations, mfrSpecs] = await Promise.all([
      queryKnowledgeBase(supabase, uniqueTerms, ["building-codes", "training-materials", "other"]),
      effectiveState ? queryBuildingCodes(supabase, uniqueTerms, effectiveState) : Promise.resolve([]),
      queryManufacturerSpecs(supabase, uniqueTerms, manufacturer),
    ]);

    console.log(`Retrieved: ${kbChunks.length} KB chunks, ${codeCitations.length} code citations, ${mfrSpecs.length} mfr specs`);

    // Build context sections
    const kbContext = kbChunks.length
      ? kbChunks.map((c, i) => `[KB Chunk #${i + 1} - ${c.source} (${c.category})]:\n${c.content}`).join("\n\n")
      : "No relevant knowledge base entries found.";

    const codeContext = codeCitations.length
      ? codeCitations.map((c, i) => `[${c.state} Code - ${c.source} §${c.section}${c.title ? ` "${c.title}"` : ""}]:\n${c.content}`).join("\n\n")
      : effectiveState
        ? `No specific building code citations found for ${effectiveState}.`
        : "State not in supported list (NJ, PA, SC). Building code lookup skipped.";

    const mfrContext = mfrSpecs.length
      ? mfrSpecs.map((m, i) => `[Manufacturer Spec #${i + 1} - ${m.source}]:\n${m.content}`).join("\n\n")
      : "No manufacturer-specific documentation found in knowledge base.";

    // Build the AI prompt
    const systemPrompt = `You are a line item justification engine for a public adjuster firm. Your job is to generate precise, source-backed justifications for insurance estimate line items.

RULES:
1. Every assertion MUST cite a specific source using these formats:
   - Knowledge base: [KB Chunk #N]
   - Building code: [${effectiveState || "State"} Code - SOURCE §SECTION]
   - Manufacturer spec: [Manufacturer Spec #N]
2. If no relevant source exists for a claim, state "Insufficient data - no source found for this assertion" instead of fabricating.
3. NEVER fabricate code section numbers, manufacturer requirements, or policy language.
4. Building codes are ONLY available for: NJ, PA, SC. Current state: ${effectiveState || "Not in supported states"}.
5. Use function-first reasoning: explain WHAT the component does in the building system, WHY it's required, and WHAT breaks if omitted.
6. For carrier-facing text: Use a strict 5-sentence format (function, authority, code compliance, policy tie-in, consequence of omission). No markdown, no bullets - clean prose only.

OUTPUT FORMAT: Return a JSON array. Each element must have:
{
  "normalizedItem": "string - canonical item name",
  "trade": "string - roofing/siding/interior/gutters/windows/general",
  "system": "string - functional system name (e.g., water shedding system)",
  "whyRequired": "string - function-first explanation",
  "manufacturer": {
    "text": "string - manufacturer requirement with source citation",
    "functionText": "string - what this component does functionally",
    "failureRisk": "string - consequence of omission",
    "confidence": "direct|inferred|needs_evidence",
    "sourceName": "string|null - source document name"
  },
  "code": {
    "text": "string - code requirement with citation",
    "confidence": "direct|inferred|needs_evidence",
    "reference": "string - specific code section",
    "sourceName": "string|null"
  },
  "policy": {
    "text": "string - policy support statement",
    "confidence": "direct|inferred|needs_evidence"
  },
  "missingEvidence": ["string array - what evidence is still needed"],
  "confidenceScore": number (0-100),
  "confidenceLabel": "High|Medium|Low",
  "supportStrength": "direct|inferred|needs_evidence",
  "inlineNote": "string - brief note for inline display",
  "carrierFacingText": "string - formal 5-sentence carrier-ready paragraph",
  "sources": [{"type": "kb|code|manufacturer", "label": "string - display label", "content": "string - relevant excerpt"}]
}`;

    const userPrompt = `Justify the following ${lineItems.length} line items for claim in ${effectiveState || "unknown"} state.
${manufacturer ? `Manufacturer: ${manufacturer}` : ""}
${lossType ? `Loss type: ${lossType}` : ""}
View mode: ${viewMode}

LINE ITEMS:
${lineItems.map((li, i) => `${i + 1}. ${li.description}${li.quantity ? ` (${li.quantity} ${li.unit || "EA"})` : ""}${li.code ? ` [Code: ${li.code}]` : ""}`).join("\n")}

KNOWLEDGE BASE CONTEXT:
${kbContext}

BUILDING CODE CITATIONS (${effectiveState || "N/A"}):
${codeContext}

MANUFACTURER SPECIFICATIONS:
${mfrContext}

Return ONLY a valid JSON array with one entry per line item. No markdown fences.`;

    const aiResponse = await callAI(systemPrompt, userPrompt);

    // Parse AI response
    let justifications: any[];
    try {
      // Strip markdown fences if present
      const cleaned = aiResponse.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      justifications = JSON.parse(cleaned);
      if (!Array.isArray(justifications)) {
        justifications = [justifications];
      }
    } catch (parseErr) {
      console.error("Failed to parse AI response:", aiResponse.slice(0, 500));
      return new Response(
        JSON.stringify({ ok: false, error: "AI returned unparseable response. Please retry." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Persist justifications
    for (const r of justifications) {
      await supabase.from("claim_line_item_justifications").upsert({
        claim_id: claimId,
        normalized_item: r.normalizedItem,
        manufacturer_support: r.manufacturer,
        code_support: r.code,
        policy_support: r.policy,
        support_strength: r.supportStrength,
        confidence_score: r.confidenceScore,
        missing_evidence_json: r.missingEvidence,
        carrier_facing_text: r.carrierFacingText,
        inline_note: r.inlineNote,
        output_mode: viewMode,
      }).eq("claim_id", claimId).eq("normalized_item", r.normalizedItem);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        justifications,
        metadata: {
          kbChunksUsed: kbChunks.length,
          codeCitationsUsed: codeCitations.length,
          mfrSpecsUsed: mfrSpecs.length,
          stateCode: effectiveState || null,
          stateSupported: !!effectiveState,
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Justification error:", err);

    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message === "RATE_LIMIT" ? 429 : message === "CREDITS_EXHAUSTED" ? 402 : 200;

    return new Response(
      JSON.stringify({
        ok: false,
        error:
          message === "RATE_LIMIT"
            ? "Rate limit exceeded. Please wait a moment and try again."
            : message === "CREDITS_EXHAUSTED"
            ? "AI credits exhausted. Please add funds in Settings > Workspace > Usage."
            : `Justification failed: ${message}`,
      }),
      { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
