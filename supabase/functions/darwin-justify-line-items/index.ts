import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { generate } from "../_shared/ai/generate.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ALLOWED_STATES = ["NJ", "PA", "SC"];

// Known manufacturer names to extract from descriptions
const KNOWN_MANUFACTURERS = [
  "GAF", "Owens Corning", "CertainTeed", "Tamko", "Atlas", "Malarkey",
  "IKO", "James Hardie", "Boral", "Eagle", "Decra", "ARMA",
  "Pinnacle", "Duration", "Timberline", "Landmark", "Heritage",
];

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
  industryStandards?: string;
}

// ── Manufacturer Extraction ─────────────────────────────────────

function extractManufacturerFromText(text: string): string | null {
  const lower = text.toLowerCase();
  for (const mfr of KNOWN_MANUFACTURERS) {
    if (lower.includes(mfr.toLowerCase())) return mfr;
  }
  return null;
}

// Map line item descriptions to roofing component keywords for better search
const COMPONENT_SEARCH_MAP: Record<string, string[]> = {
  "starter": ["starter strip", "starter shingle", "starter course", "edge starter"],
  "shingle": ["shingle installation", "laminate shingle", "architectural shingle", "nailing pattern"],
  "ridge": ["ridge cap", "hip and ridge", "hip ridge", "ridge shingle"],
  "drip": ["drip edge", "eave metal", "rake metal"],
  "ice": ["ice barrier", "ice water shield", "ice dam", "ice and water"],
  "underlayment": ["underlayment", "synthetic felt", "roof felt", "secondary barrier"],
  "vent": ["ridge vent", "attic ventilation", "exhaust ventilation"],
  "flashing": ["step flashing", "pipe boot", "pipe flashing", "wall flashing", "valley flashing"],
  "valley": ["valley metal", "valley lining", "valley flashing"],
  "decking": ["roof decking", "sheathing", "plywood", "OSB", "roof deck"],
  "tear": ["tear off", "tear-off", "removal", "strip roof"],
  "gutter": ["gutter", "seamless gutter", "downspout"],
  "siding": ["vinyl siding", "fiber cement", "hardie", "exterior cladding"],
  "soffit": ["soffit", "eave soffit", "soffit ventilation"],
  "fascia": ["fascia", "fascia board", "rake board"],
  "drywall": ["drywall", "sheetrock", "gypsum board"],
  "paint": ["paint", "interior paint", "repaint", "coating"],
  "insulation": ["insulation", "batt insulation", "blown insulation", "thermal barrier"],
  "window": ["window", "window replacement", "glazing"],
  "permit": ["building permit", "permit"],
  "overhead": ["overhead and profit", "O&P", "general contractor"],
};

function getSearchTermsForItem(description: string): string[] {
  const lower = description.toLowerCase();
  const terms = [description]; // always include the raw description

  for (const [key, synonyms] of Object.entries(COMPONENT_SEARCH_MAP)) {
    if (lower.includes(key)) {
      terms.push(...synonyms.slice(0, 2));
      break;
    }
  }

  return terms;
}

// ── Data Retrieval ──────────────────────────────────────────────

async function queryManufacturerData(
  supabase: any,
  lineItems: LineItem[],
  claimManufacturer?: string
): Promise<{ perItem: Record<string, any[]>; allSpecs: any[] }> {
  const perItem: Record<string, any[]> = {};
  const allSpecs: any[] = [];
  const seen = new Set<string>();

  // Get ALL manufacturer-spec documents for broader matching
  const { data: mfrDocs } = await supabase
    .from("ai_knowledge_documents")
    .select("id, file_name, category")
    .eq("category", "manufacturer-specs");

  const mfrDocIds = new Set((mfrDocs || []).map((d: any) => d.id));
  const mfrDocMap = new Map((mfrDocs || []).map((d: any) => [d.id, d]));

  for (const li of lineItems) {
    const itemKey = li.description || li.code || "";
    if (!itemKey) continue;
    perItem[itemKey] = [];

    // Extract manufacturer from this specific line item
    const itemMfr = extractManufacturerFromText(itemKey) || claimManufacturer;
    const searchTerms = getSearchTermsForItem(itemKey);

    console.log(`[mfr-lookup] Item: "${itemKey}" → searching terms: ${searchTerms.join(', ')}, mfr: ${itemMfr || 'none'}`);

    // Track per-item seen keys to prevent cross-contamination
    const itemSeen = new Set<string>();

  for (const term of searchTerms.slice(0, 2)) {
      const words = term.split(/[\s\/&\-]+/).filter((w) => w.length > 2);
      if (!words.length) continue;
      const tsQuery = words.join(" & ");

      try {
        const { data: chunks } = await supabase
          .from("ai_knowledge_chunks")
          .select("content, document_id")
          .textSearch("content", tsQuery, { type: "plain" })
          .limit(3);

        if (!chunks?.length) continue;

        for (const chunk of chunks) {
          if (!mfrDocIds.has(chunk.document_id)) continue;

          const doc = mfrDocMap.get(chunk.document_id);
          if (!doc) continue;

          const contentKey = chunk.content.slice(0, 80);
          if (itemSeen.has(contentKey)) continue;
          itemSeen.add(contentKey);

          // Relevance check: content must mention at least one item-specific keyword
          const contentLower = chunk.content.toLowerCase();
          const itemKeywords = itemKey.toLowerCase().split(/[\s\/&\-]+/).filter((w: string) => w.length > 2);
          const hasItemRelevance = itemKeywords.some((kw: string) => contentLower.includes(kw));
          if (!hasItemRelevance) {
            console.log(`[mfr-lookup] Skipping irrelevant chunk for "${itemKey}" from ${doc.file_name}: no keyword match`);
            continue;
          }

          const docNameLower = doc.file_name.toLowerCase();
          const isManufacturerMatch = itemMfr && docNameLower.includes(itemMfr.toLowerCase());

          const entry = {
            source: doc.file_name,
            content: chunk.content.slice(0, 600),
            manufacturer: itemMfr || extractManufacturerFromText(doc.file_name) || "Unknown",
            isDirectMatch: isManufacturerMatch || false,
          };

          perItem[itemKey].push(entry);
          if (!seen.has(contentKey)) {
            seen.add(contentKey);
            allSpecs.push(entry);
          }
        }
      } catch (e) {
        console.warn(`Search failed for term "${term}":`, e);
      }
    }

    // Sort: direct manufacturer matches first
    perItem[itemKey].sort((a: any, b: any) => (b.isDirectMatch ? 1 : 0) - (a.isDirectMatch ? 1 : 0));
    perItem[itemKey] = perItem[itemKey].slice(0, 3);
    console.log(`[mfr-lookup] Result for "${itemKey}": ${perItem[itemKey].length} specs matched`);
  }

  // Deduplicate allSpecs
  const uniqueSpecs: any[] = [];
  const specSeen = new Set<string>();
  for (const s of allSpecs) {
    const k = s.content.slice(0, 80);
    if (!specSeen.has(k)) {
      specSeen.add(k);
      uniqueSpecs.push(s);
    }
  }

  return { perItem, allSpecs: uniqueSpecs.slice(0, 15) };
}

async function queryBuildingCodes(
  supabase: any,
  lineItems: LineItem[],
  stateCode: string
): Promise<{ perItem: Record<string, any[]>; allCodes: any[] }> {
  const perItem: Record<string, any[]> = {};
  const allCodes: any[] = [];

  if (!ALLOWED_STATES.includes(stateCode.toUpperCase())) {
    // Return empty with per-item "not applicable" markers
    for (const li of lineItems) {
      perItem[li.description || ""] = [];
    }
    return { perItem, allCodes };
  }

  // Fetch all codes for this state at once
  const { data: allStateCodesRaw, error: codeErr } = await supabase
    .from("building_code_citations")
    .select("section_number, section_title, code_source, content, keywords, state_adoptions")
    .contains("state_adoptions", [stateCode.toUpperCase()]);

  console.log(`[codes] Query for state "${stateCode}": ${allStateCodesRaw?.length || 0} citations found${codeErr ? `, error: ${codeErr.message}` : ''}`);

  if (!allStateCodesRaw?.length) {
    for (const li of lineItems) {
      perItem[li.description || ""] = [];
    }
    return { perItem, allCodes };
  }

  const seen = new Set<string>();

  for (const li of lineItems) {
    const itemKey = li.description || li.code || "";
    if (!itemKey) continue;
    perItem[itemKey] = [];

    const searchTerms = getSearchTermsForItem(itemKey);
    const itemKeywords = searchTerms.flatMap((t) =>
      t.toLowerCase().split(/[\s\/&\-]+/).filter((w) => w.length > 2)
    );

    console.log(`[codes-lookup] Item: "${itemKey}" → keywords: ${itemKeywords.join(', ')}`);

    // Score each code citation against this item
    const scored = allStateCodesRaw.map((row: any) => {
      const rowKeywords = (row.keywords || []).map((k: string) => k.toLowerCase());
      const contentLower = (row.content || "").toLowerCase();
      const titleLower = (row.section_title || "").toLowerCase();
      let score = 0;

      for (const kw of itemKeywords) {
        if (rowKeywords.includes(kw)) score += 5;
        if (titleLower.includes(kw)) score += 3;
        if (contentLower.includes(kw)) score += 1;
      }
      return { ...row, relevanceScore: score };
    });

    // Require a minimum relevance score to avoid cross-contamination
    const MIN_RELEVANCE = 3;
    const matches = scored
      .filter((s: any) => s.relevanceScore >= MIN_RELEVANCE)
      .sort((a: any, b: any) => b.relevanceScore - a.relevanceScore)
      .slice(0, 3);

    console.log(`[codes-lookup] Result for "${itemKey}": ${matches.length} codes matched (min score ${MIN_RELEVANCE})`);

    for (const m of matches) {
      const entry = {
        section: m.section_number,
        title: m.section_title || "",
        source: m.code_source,
        content: m.content.slice(0, 600),
        state: stateCode.toUpperCase(),
        citation: `${stateCode.toUpperCase()} ${m.code_source} §${m.section_number}`,
      };
      perItem[itemKey].push(entry);

      const codeKey = `${m.code_source}-${m.section_number}`;
      if (!seen.has(codeKey)) {
        seen.add(codeKey);
        allCodes.push(entry);
      }
    }
  }

  return { perItem, allCodes: allCodes.slice(0, 20) };
}

async function queryKnowledgeBase(
  supabase: any,
  searchTerms: string[]
): Promise<{ source: string; content: string; category: string }[]> {
  const results: any[] = [];
  const seen = new Set<string>();

  for (const term of searchTerms.slice(0, 3)) {
    const words = term.split(/[\s\/&\-]+/).filter((w) => w.length > 2);
    if (!words.length) continue;

    try {
      const { data } = await supabase
        .from("ai_knowledge_chunks")
        .select("content, document_id")
        .textSearch("content", words.join(" & "), { type: "plain" })
        .limit(3);

      if (!data?.length) continue;

      const docIds = [...new Set(data.map((d: any) => d.document_id))];
      const { data: docs } = await supabase
        .from("ai_knowledge_documents")
        .select("id, file_name, category")
        .in("id", docIds)
        .in("category", ["building-codes", "training-materials", "other"]);

      const docMap = new Map((docs || []).map((d: any) => [d.id, d]));

      for (const chunk of data) {
        const doc = docMap.get(chunk.document_id);
        if (!doc) continue;
        const key = chunk.content.slice(0, 80);
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({
          source: doc.file_name,
          content: chunk.content.slice(0, 500),
          category: doc.category,
        });
      }
    } catch (e) {
      console.warn(`KB search failed for "${term}":`, e);
    }
  }

  return results.slice(0, 5);
}

// ── AI Call ──────────────────────────────────────────────────────

async function callAI(systemPrompt: string, userPrompt: string, itemCount: number): Promise<string> {
  // Allocate ~800 tokens per justification item, with a generous floor and ceiling.
  const dynamicMax = Math.min(12000, Math.max(4000, itemCount * 800));
  const forceStrong = itemCount > 3 || (systemPrompt.length + userPrompt.length) > 6000;

  const result = await generate({
    task: 'extraction',
    system: systemPrompt,
    user: userPrompt,
    searchMode: 'off',
    temperature: 0.15,
    jsonMode: true,
    maxTokens: dynamicMax,
    forceStrong,
  });

  console.log(`[darwin-justify-line-items] model=${result.model}, items=${itemCount}, maxTokens=${dynamicMax}, forceStrong=${forceStrong}, cached=${result.cached}`);
  return result.text;
}

// ── Main Handler ────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body: RequestBody = await req.json();
    const { claimId, lineItems, stateCode, manufacturer, lossType, viewMode = "internal", industryStandards } = body;

    if (!claimId || !lineItems?.length) {
      return new Response(
        JSON.stringify({ ok: false, error: "Missing claimId or lineItems" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const effectiveState = ALLOWED_STATES.includes(stateCode?.toUpperCase()) ? stateCode.toUpperCase() : "";

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Build search terms
    const searchTerms = lineItems.map((li) => li.description || li.code || "").filter(Boolean);
    const uniqueTerms = [...new Set(searchTerms)];

    console.log(`[justify] State: "${stateCode}" → effectiveState: "${effectiveState}", allowed: ${ALLOWED_STATES.join(',')}`);
    console.log(`[justify] Manufacturer: "${manufacturer || 'none'}", lineItems: ${lineItems.length}, terms: ${uniqueTerms.join(', ')}`);

    // Parallel data retrieval — per-item matching for manufacturer and codes
    const [mfrData, codeData, kbChunks] = await Promise.all([
      queryManufacturerData(supabase, lineItems, manufacturer || undefined),
      effectiveState ? queryBuildingCodes(supabase, lineItems, effectiveState) : Promise.resolve({ perItem: {} as Record<string, any[]>, allCodes: [] }),
      queryKnowledgeBase(supabase, uniqueTerms),
    ]);

    console.log(`[justify] Retrieved: ${mfrData.allSpecs.length} mfr specs, ${codeData.allCodes.length} code citations, ${kbChunks.length} KB chunks`);
    
    // Log per-item code matches for debugging
    for (const [itemKey, codes] of Object.entries(codeData.perItem)) {
      console.log(`[justify][codes] "${itemKey}" → ${(codes as any[]).length} matches: ${(codes as any[]).map((c: any) => c.citation).join(', ') || 'none'}`);
    }
    for (const [itemKey, specs] of Object.entries(mfrData.perItem)) {
      console.log(`[justify][mfr] "${itemKey}" → ${(specs as any[]).length} matches: ${(specs as any[]).map((s: any) => s.source).join(', ') || 'none'}`);
    }

    // ── Build per-item context for the prompt ──
    const perItemContext = lineItems.map((li, idx) => {
      const key = li.description || li.code || "";
      const itemMfr = extractManufacturerFromText(key) || manufacturer || null;
      const mfrResults = mfrData.perItem[key] || [];
      const codeResults = codeData.perItem[key] || [];

      let mfrSection: string;
      if (mfrResults.length > 0) {
        mfrSection = mfrResults.map((m: any, i: number) =>
          `  [Manufacturer Spec ${idx + 1}.${i + 1} - ${m.manufacturer} - ${m.source}${m.isDirectMatch ? " (DIRECT MATCH)" : ""}]:\n  ${m.content}`
        ).join("\n");
      } else {
        mfrSection = `  No manufacturer data available for "${key}"${itemMfr ? ` (searched for ${itemMfr})` : ""}. Use "No manufacturer data available" in output.`;
      }

      let codeSection: string;
      if (codeResults.length > 0) {
        codeSection = codeResults.map((c: any, i: number) =>
          `  [${c.citation}${c.title ? ` "${c.title}"` : ""}]:\n  ${c.content}`
        ).join("\n");
      } else if (effectiveState) {
        codeSection = `  No applicable building codes found for "${key}" in ${effectiveState}. Use "No applicable codes for ${effectiveState}" in output.`;
      } else {
        codeSection = `  State "${stateCode || "unknown"}" is not in supported list (NJ, PA, SC). Use "Building code lookup not available for this jurisdiction" in output.`;
      }

      return `--- ITEM ${idx + 1}: ${key}${li.quantity ? ` (${li.quantity} ${li.unit || "EA"})` : ""}${li.code ? ` [Code: ${li.code}]` : ""} ---
Detected manufacturer: ${itemMfr || "None detected"}
MANUFACTURER DATA:
${mfrSection}
BUILDING CODES:
${codeSection}`;
    }).join("\n\n");

    // KB context (general)
    const kbContext = kbChunks.length
      ? kbChunks.map((c, i) => `[KB Chunk #${i + 1} - ${c.source} (${c.category})]:\n${c.content}`).join("\n\n")
      : "No additional knowledge base entries found.";

    // ── Build AI prompt ──
    const systemPrompt = `You are a line item justification engine for a public adjuster firm. Generate precise, source-backed justifications for insurance estimate line items.

CRITICAL RULES:
0. YOU MUST RETURN EXACTLY ONE JUSTIFICATION OBJECT FOR EVERY LINE ITEM PROVIDED — no skipping, no merging, no summarizing. The output array length MUST equal the input item count (${lineItems.length}). Items appear in the same order as the input.

1. Every assertion MUST cite a specific source from the provided data:
   - Manufacturer: cite as [Manufacturer Spec N.M - MANUFACTURER - FILENAME]
   - Building code: cite as [STATE CODE §SECTION]
   - Knowledge base: cite as [KB Chunk #N]
   - Industry standard: cite the standard name verbatim (e.g., "ASTM D3737", "NFPA 101", "ARMA TAB-R-2014")

2. FALLBACK HANDLING — this is mandatory:
   - If NO manufacturer specs were provided for an item, set manufacturer.text to "No manufacturer data available" and manufacturer.confidence to "needs_evidence"
   - If NO building codes were provided for an item, set code.text to "No applicable codes for this jurisdiction" and code.confidence to "needs_evidence"
   - NEVER fabricate section numbers, manufacturer names, or requirements not in the provided data

3. For manufacturer section:
   - manufacturer.text: The actual requirement from the spec sheet with citation
   - manufacturer.functionText: What this component does in the system (always provide this)
   - manufacturer.failureRisk: What happens if omitted (always provide this)
   - manufacturer.sourceName: The source document filename, or null if none

4. For code section:
   - code.text: The actual code requirement text with citation
   - code.reference: The specific section number (e.g., "IRC §R905.2.8.5") or "N/A" if none found
   - code.sourceName: The code source name, or null

5. Building codes are ONLY available for: NJ, PA, SC. Current state: ${effectiveState || "Not in supported states"}.

6. INDUSTRY STANDARDS (mandatory when provided):
   - When the user supplies industry standards, you MUST explicitly name and apply at least one relevant standard inside whyRequired AND inside carrierFacingText for every applicable line item.
   - Add the standard to the "sources" array with type "kb" and label = the standard's name (e.g., "ASTM D3737").
   - If a provided standard genuinely does not apply to a particular item, briefly state why in inlineNote — do not silently omit it.

7. For carrier-facing text: Strict 5-sentence format (function, manufacturer authority, code compliance, industry standard / policy tie-in, consequence of omission). Clean prose only.

8. The "sources" array MUST list every source actually cited in the justification. Each source needs:
   - type: "manufacturer" | "code" | "kb"
   - label: Human-readable label (e.g., "GAF Timberline HDZ Installation Instructions" or "NJ IRC §R905.2.8.5" or "ASTM D3737")
   - content: The relevant excerpt (50-150 chars)

OUTPUT: Return a JSON array with one object per line item:
{
  "normalizedItem": "string",
  "trade": "roofing|siding|interior|gutters|windows|general",
  "system": "string (e.g., water shedding system)",
  "whyRequired": "string",
  "manufacturer": {
    "text": "string with citation OR 'No manufacturer data available'",
    "functionText": "string - always populated",
    "failureRisk": "string - always populated",
    "confidence": "direct|inferred|needs_evidence",
    "sourceName": "string|null",
    "manufacturer": "string|null"
  },
  "code": {
    "text": "string with citation OR 'No applicable codes for this jurisdiction'",
    "confidence": "direct|inferred|needs_evidence",
    "reference": "string - section number or 'N/A'",
    "sourceName": "string|null"
  },
  "policy": {
    "text": "string",
    "confidence": "direct|inferred|needs_evidence"
  },
  "missingEvidence": ["string"],
  "confidenceScore": 0-100,
  "confidenceLabel": "High|Medium|Low",
  "supportStrength": "direct|inferred|needs_evidence",
  "inlineNote": "string",
  "carrierFacingText": "string",
  "sources": [{"type": "manufacturer|code|kb", "label": "string", "content": "string"}]
}`;

    const userPrompt = `Justify ALL ${lineItems.length} line items below for a claim in ${effectiveState || "unknown"} state. Return exactly ${lineItems.length} objects in the JSON array — one per item, same order.
${manufacturer ? `Claim-level manufacturer: ${manufacturer}` : "No claim-level manufacturer set."}
${lossType ? `Loss type: ${lossType}` : ""}
View mode: ${viewMode}
${industryStandards ? `\n=== INDUSTRY STANDARDS (USER-PROVIDED — MUST be explicitly named and applied in every applicable item) ===\n${industryStandards}\n=== END INDUSTRY STANDARDS ===` : "\n(No industry standards supplied by user.)"}

PER-ITEM DATA (manufacturer specs and building codes matched to each item):
${perItemContext}

GENERAL KNOWLEDGE BASE CONTEXT:
${kbContext}

CRITICAL:
- Each item's manufacturer data and building codes are ALREADY scoped to that specific item. Do NOT use manufacturer data or building codes from one item to justify a different item.
- Output array length MUST equal ${lineItems.length}. Do not skip items, even if data is sparse — use the fallback strings.
${industryStandards ? `- Every applicable item must explicitly name at least one of the supplied industry standards in whyRequired AND carrierFacingText AND sources.` : ""}

Return ONLY a valid JSON array. No markdown fences, no commentary.`;

    const aiResponse = await callAI(systemPrompt, userPrompt, lineItems.length);

    // Parse AI response
    let justifications: any[];
    try {
      const cleaned = aiResponse.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      justifications = JSON.parse(cleaned);
      if (!Array.isArray(justifications)) {
        justifications = [justifications];
      }
    } catch (parseErr) {
      console.error("Failed to parse AI response:", aiResponse.slice(0, 1000));
      return new Response(
        JSON.stringify({ ok: false, error: "AI returned unparseable response. The model likely truncated output — try fewer line items at once, or retry." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (justifications.length < lineItems.length) {
      console.warn(`[justify] AI returned ${justifications.length} items but ${lineItems.length} were requested. Output may have been truncated.`);
    }

    // Post-process: ensure fallback fields are never empty
    for (const j of justifications) {
      if (!j.manufacturer) j.manufacturer = {};
      if (!j.manufacturer.text) j.manufacturer.text = "No manufacturer data available";
      if (!j.manufacturer.functionText) j.manufacturer.functionText = "Component function could not be determined from available data.";
      if (!j.manufacturer.failureRisk) j.manufacturer.failureRisk = "Risk assessment requires manufacturer documentation.";
      if (!j.manufacturer.confidence) j.manufacturer.confidence = "needs_evidence";

      if (!j.code) j.code = {};
      if (!j.code.text) j.code.text = effectiveState ? `No applicable codes for ${effectiveState}` : "Building code lookup not available for this jurisdiction";
      if (!j.code.reference) j.code.reference = "N/A";
      if (!j.code.confidence) j.code.confidence = "needs_evidence";

      if (!j.policy) j.policy = {};
      if (!j.policy.text) j.policy.text = "Policy-specific support not available.";
      if (!j.policy.confidence) j.policy.confidence = "needs_evidence";

      if (!j.sources) j.sources = [];
      if (!j.missingEvidence) j.missingEvidence = [];
      if (!j.confidenceScore) j.confidenceScore = 30;
      if (!j.confidenceLabel) j.confidenceLabel = "Low";
      if (!j.supportStrength) j.supportStrength = "needs_evidence";
    }

    // Persist justifications
    for (const r of justifications) {
      try {
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
      } catch (e) {
        console.warn("Failed to persist justification:", r.normalizedItem, e);
      }
    }

    // Build metadata with per-item source counts
    const itemsWithMfrData = Object.values(mfrData.perItem).filter((arr: any[]) => arr.length > 0).length;
    const itemsWithCodeData = Object.values(codeData.perItem).filter((arr: any[]) => arr.length > 0).length;

    return new Response(
      JSON.stringify({
        ok: true,
        justifications,
        metadata: {
          kbChunksUsed: kbChunks.length,
          codeCitationsUsed: codeData.allCodes.length,
          mfrSpecsUsed: mfrData.allSpecs.length,
          itemsWithMfrData,
          itemsWithCodeData,
          totalItems: lineItems.length,
          stateCode: effectiveState || null,
          stateSupported: !!effectiveState,
          sourcesQueried: [
            "ai_knowledge_chunks (manufacturer-specs)",
            "building_code_citations",
            "ai_knowledge_chunks (general)",
          ],
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
