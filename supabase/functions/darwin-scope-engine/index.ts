import { createClient } from "npm:@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// ─── Price Book ───
const PRICE_BOOK: Record<string, number> = {
  RFG240: 525, RFG220: 85, RFG300: 8.5, RFGST: 4.5, RFGFELTSYN: 45,
  RFGICE: 1.85, RFGDRIP: 4.25, RFGVENT: 16, SIDVINYL: 74, SIDVINYLREP: 38,
  SIDFIBER: 96, SIDDROP: 1.65, DRYWALL: 3.8, PAINT: 1.95, INSUL: 1.45,
  WINREPL: 850, GUT5K: 18, DWN23: 16, FNCREP: 42,
};
function getUnitPrice(code: string): number { return PRICE_BOOK[code] ?? 0; }

// ─── Types ───
type DamageCategory = "roof"|"siding"|"interior"|"window"|"gutter"|"fence"|"other";
type Severity = "low"|"medium"|"high";
type Repairability = "repair"|"replace"|"undetermined";

interface DamageObservation {
  category: DamageCategory; component: string; material: string;
  damageType: string; severity: Severity; repairability: Repairability;
  quantityBasis: string; recommendedQuantity: number; unit: string;
  confidence: number; rationale: string;
}

interface ScopeContext {
  state?: string; repairPercent?: number; discontinuedMaterial?: boolean;
  brittleTestFailed?: boolean; matchingRequired?: boolean;
  ridgeVentPresent?: boolean; dripEdgePresent?: boolean;
  iceBarrierPresent?: boolean; wasteFactor?: number;
}

interface ScopeLineItem {
  code: string; description: string; quantity: number; unit: string;
  unitPrice: number; total: number; reasoning: string;
  sourceObservationIndexes: number[]; isCodeRequired?: boolean;
  isDependency?: boolean; isManualReviewRequired?: boolean;
}

interface ScopeWarning {
  type: "no_match"|"low_confidence"|"manual_review"|"code_upgrade"|"matching_issue";
  message: string; observationIndex?: number;
}

// ─── Utils ───
function round2(v: number): number { return Number(v.toFixed(2)); }

function makeLineItem(args: {
  code: string; description: string; quantity: number; unit: string;
  reasoning: string; sourceObservationIndexes?: number[];
  isCodeRequired?: boolean; isDependency?: boolean; isManualReviewRequired?: boolean;
}): ScopeLineItem {
  const unitPrice = getUnitPrice(args.code);
  return {
    code: args.code, description: args.description,
    quantity: round2(args.quantity), unit: args.unit, unitPrice,
    total: round2(unitPrice * args.quantity), reasoning: args.reasoning,
    sourceObservationIndexes: args.sourceObservationIndexes ?? [],
    isCodeRequired: args.isCodeRequired, isDependency: args.isDependency,
    isManualReviewRequired: args.isManualReviewRequired,
  };
}

function mergeDuplicateLineItems(items: ScopeLineItem[]): ScopeLineItem[] {
  const map = new Map<string, ScopeLineItem>();
  for (const item of items) {
    const key = `${item.code}__${item.unit}__${item.description}`;
    const existing = map.get(key);
    if (!existing) { map.set(key, { ...item }); continue; }
    existing.quantity = round2(existing.quantity + item.quantity);
    existing.total = round2(existing.total + item.total);
    existing.reasoning = `${existing.reasoning} | ${item.reasoning}`;
    existing.sourceObservationIndexes = Array.from(new Set([...existing.sourceObservationIndexes, ...item.sourceObservationIndexes]));
    existing.isCodeRequired = existing.isCodeRequired || item.isCodeRequired;
    existing.isDependency = existing.isDependency || item.isDependency;
    existing.isManualReviewRequired = existing.isManualReviewRequired || item.isManualReviewRequired;
  }
  return Array.from(map.values());
}

// ─── Material Classifier ───
function normalizeObservationMaterial(obs: DamageObservation): DamageObservation {
  const text = `${obs.component} ${obs.material} ${obs.damageType}`.toLowerCase();
  let material = obs.material;
  if (text.includes("architectural") || text.includes("laminated") || text.includes("comp shingle") || text.includes("asphalt")) material = "architectural shingle";
  else if (text.includes("vinyl")) material = "vinyl siding";
  else if (text.includes("hardie") || text.includes("fiber cement")) material = "fiber cement siding";
  else if (text.includes("drywall") || text.includes("sheetrock")) material = "drywall";
  else if (text.includes("gutter")) material = "gutter";
  else if (text.includes("window")) material = "window unit";
  return { ...obs, material };
}

// ─── Xactimate Map ───
interface XactimateTemplate {
  code: string; description: string; defaultUnit: string; category: string;
  appliesWhen: { category?: DamageCategory; materialIncludes?: string[]; damageTypeIncludes?: string[]; repairability?: Repairability[]; };
}

const XACTIMATE_MAP: XactimateTemplate[] = [
  { code: "RFG240", description: "Remove and replace laminated composition shingles", defaultUnit: "SQ", category: "roof", appliesWhen: { category: "roof", materialIncludes: ["architectural","laminated","composition","asphalt"], repairability: ["replace"] }},
  { code: "RFG220", description: "Repair composition shingle roofing", defaultUnit: "EA", category: "roof", appliesWhen: { category: "roof", materialIncludes: ["architectural","laminated","composition","asphalt"], repairability: ["repair"] }},
  { code: "SIDVINYL", description: "Remove and replace vinyl siding", defaultUnit: "SF", category: "siding", appliesWhen: { category: "siding", materialIncludes: ["vinyl"], repairability: ["replace"] }},
  { code: "SIDVINYLREP", description: "Repair vinyl siding", defaultUnit: "SF", category: "siding", appliesWhen: { category: "siding", materialIncludes: ["vinyl"], repairability: ["repair"] }},
  { code: "SIDFIBER", description: "Remove and replace fiber cement siding", defaultUnit: "SF", category: "siding", appliesWhen: { category: "siding", materialIncludes: ["fiber cement","hardie","cement board"], repairability: ["replace"] }},
  { code: "DRYWALL", description: "Repair drywall", defaultUnit: "SF", category: "interior", appliesWhen: { category: "interior", materialIncludes: ["drywall","gypsum","sheetrock"] }},
  { code: "WINREPL", description: "Replace window unit", defaultUnit: "EA", category: "window", appliesWhen: { category: "window", repairability: ["replace"] }},
  { code: "GUT5K", description: "Replace 5-inch gutter", defaultUnit: "LF", category: "gutter", appliesWhen: { category: "gutter", repairability: ["replace","repair"] }},
  { code: "DWN23", description: "Replace downspout", defaultUnit: "LF", category: "gutter", appliesWhen: { category: "gutter", materialIncludes: ["downspout"] }},
  { code: "FNCREP", description: "Repair fence", defaultUnit: "LF", category: "fence", appliesWhen: { category: "fence" }},
];

function findBestTemplate(obs: DamageObservation): XactimateTemplate | null {
  const material = obs.material.toLowerCase();
  const damageType = obs.damageType.toLowerCase();
  for (const t of XACTIMATE_MAP) {
    const a = t.appliesWhen;
    if (a.category && a.category !== obs.category) continue;
    if (a.repairability && !a.repairability.includes(obs.repairability)) continue;
    if (a.materialIncludes && !a.materialIncludes.some(m => material.includes(m))) continue;
    if (a.damageTypeIncludes && !a.damageTypeIncludes.some(d => damageType.includes(d))) continue;
    return t;
  }
  return null;
}

// ─── Dependency Rules ───
function deriveQuantity(obs: DamageObservation, defaultUnit: string, context: ScopeContext): number {
  const q = obs.recommendedQuantity || 1;
  const wf = context.wasteFactor ?? 0.1;
  if (defaultUnit === "SQ") {
    if (obs.unit === "SQ") return q * (1 + wf);
    if (obs.unit === "SF") return (q / 100) * (1 + wf);
    return Math.max(1, q);
  }
  if (defaultUnit === "SF") { if (obs.unit === "SQ") return q * 100; return Math.max(1, q); }
  return Math.max(1, q);
}

function buildBaseScopeFromObservations(observations: DamageObservation[], context: ScopeContext): { items: ScopeLineItem[]; warnings: ScopeWarning[] } {
  const items: ScopeLineItem[] = [];
  const warnings: ScopeWarning[] = [];
  observations.forEach((obs, index) => {
    if (obs.confidence < 0.45) warnings.push({ type: "low_confidence", message: `Low-confidence observation for ${obs.component}. Review before relying on automated scope.`, observationIndex: index });
    const template = findBestTemplate(obs);
    if (!template) { warnings.push({ type: "no_match", message: `No Xactimate mapping found for ${obs.category} / ${obs.material} / ${obs.damageType}.`, observationIndex: index }); return; }
    const quantity = deriveQuantity(obs, template.defaultUnit, context);
    items.push(makeLineItem({ code: template.code, description: template.description, quantity, unit: template.defaultUnit, reasoning: `${obs.component}: ${obs.damageType}; material ${obs.material}; severity ${obs.severity}; basis ${obs.quantityBasis}`, sourceObservationIndexes: [index], isManualReviewRequired: obs.confidence < 0.6 }));
    if (obs.category === "interior") items.push(makeLineItem({ code: "PAINT", description: "Seal and paint affected area", quantity: Math.max(quantity, 1), unit: "SF", reasoning: `Paint added as dependency after interior repair for ${obs.component}.`, sourceObservationIndexes: [index], isDependency: true }));
    if (obs.category === "interior" && /insulation|wet insulation|ceiling leak|water damage/i.test(`${obs.damageType} ${obs.rationale}`)) items.push(makeLineItem({ code: "INSUL", description: "Replace insulation", quantity: Math.max(quantity, 1), unit: "SF", reasoning: `Insulation replacement added due to probable wet/damaged cavity insulation at ${obs.component}.`, sourceObservationIndexes: [index], isDependency: true }));
    if (obs.category === "siding" && obs.repairability === "replace" && !items.some(i => i.code === "SIDDROP")) items.push(makeLineItem({ code: "SIDDROP", description: "Remove and reset house wrap / weather barrier", quantity: Math.max(quantity, 1), unit: "SF", reasoning: `Weather barrier reset added as siding replacement dependency for ${obs.component}.`, sourceObservationIndexes: [index], isDependency: true }));
  });
  return { items, warnings };
}

// ─── Code & Matching Rules ───
function applyCodeAndMatchingRules(args: { items: ScopeLineItem[]; context: ScopeContext; roofSquares: number; roofPerimeterLf: number; ridgeLf: number; warnings: ScopeWarning[] }) {
  const { context, roofSquares, roofPerimeterLf, ridgeLf } = args;
  const items = [...args.items];
  const warnings = [...args.warnings];
  const assumptions: string[] = [];
  const hasFullRoof = items.some(i => i.code === "RFG240");
  if (hasFullRoof) {
    if (!items.some(i => i.code === "RFGST")) items.push(makeLineItem({ code: "RFGST", description: "Starter course - composition shingles", quantity: roofPerimeterLf, unit: "LF", reasoning: "Added as roof-system dependency for full shingle replacement.", isDependency: true }));
    if (!items.some(i => i.code === "RFG300")) items.push(makeLineItem({ code: "RFG300", description: "Ridge cap - composition shingles", quantity: ridgeLf, unit: "LF", reasoning: "Added as roof-system dependency for full shingle replacement.", isDependency: true }));
    if (!items.some(i => i.code === "RFGFELTSYN")) items.push(makeLineItem({ code: "RFGFELTSYN", description: "Synthetic felt underlayment", quantity: roofSquares, unit: "SQ", reasoning: "Added as underlayment for roof replacement scope.", isDependency: true }));
    if (!context.dripEdgePresent && !items.some(i => i.code === "RFGDRIP")) { items.push(makeLineItem({ code: "RFGDRIP", description: "Drip edge", quantity: roofPerimeterLf, unit: "LF", reasoning: "Added because drip edge not confirmed present.", isCodeRequired: true })); warnings.push({ type: "code_upgrade", message: "Drip edge added as likely code-required item for roof replacement." }); }
    if ((context.state === "NJ" || context.state === "PA") && !context.iceBarrierPresent && !items.some(i => i.code === "RFGICE")) { items.push(makeLineItem({ code: "RFGICE", description: "Ice and water barrier", quantity: Math.max(roofPerimeterLf * 2, roofSquares * 100 * 0.35), unit: "SF", reasoning: "Added as likely code-required cold-climate eave protection item.", isCodeRequired: true })); warnings.push({ type: "code_upgrade", message: "Ice and water barrier added for probable NJ/PA code compliance." }); }
    if (context.ridgeVentPresent && !items.some(i => i.code === "RFGVENT")) items.push(makeLineItem({ code: "RFGVENT", description: "Ridge vent", quantity: ridgeLf, unit: "LF", reasoning: "Added because ridge vent is present and roof replacement should include replacement/reset.", isDependency: true }));
  }
  if (context.repairPercent && context.repairPercent >= 25 && !hasFullRoof) warnings.push({ type: "code_upgrade", message: "Repair area is at or above 25%; verify whether full replacement is required by applicable code or ordinance." });
  if (context.discontinuedMaterial || context.matchingRequired) { warnings.push({ type: "matching_issue", message: "Discontinued or matching-sensitive material flagged. Verify full elevation/slope replacement requirements." }); assumptions.push("Matching/discontinued-material issue may require broader replacement than visible direct damage."); }
  if (context.brittleTestFailed) { warnings.push({ type: "manual_review", message: "Brittle test failed. Repairability should be escalated toward replacement review." }); assumptions.push("Brittleness may make spot repair infeasible and justify replacement scope."); }
  return { items, warnings, assumptions };
}

// ─── Full Scope Engine ───
function buildFullScope(observations: DamageObservation[], ctx?: ScopeContext) {
  const context: ScopeContext = { state: ctx?.state ?? "NJ", wasteFactor: ctx?.wasteFactor ?? 0.1, ...ctx };
  const normalized = observations.map(normalizeObservationMaterial);
  const sumCatUnit = (cat: string, unit: string) => round2(normalized.filter(o => o.category === cat && o.unit === unit).reduce((s, o) => s + (o.recommendedQuantity || 0), 0));
  const roofSq = sumCatUnit("roof", "SQ");
  const roofSf = roofSq > 0 ? roofSq * 100 : sumCatUnit("roof", "SF");
  const perim = roofSf ? round2(Math.sqrt(roofSf) * 4) : 0;
  const ridge = roofSf ? round2(Math.sqrt(roofSf)) : 0;
  const sidingSf = sumCatUnit("siding", "SF");
  const interiorSf = sumCatUnit("interior", "SF");
  const gutterLf = sumCatUnit("gutter", "LF");
  const windowCount = normalized.filter(o => o.category === "window").length;

  const base = buildBaseScopeFromObservations(normalized, context);
  const coded = applyCodeAndMatchingRules({ items: base.items, context, roofSquares: roofSq || round2(roofSf / 100), roofPerimeterLf: perim, ridgeLf: ridge, warnings: base.warnings });
  const lineItems = mergeDuplicateLineItems(coded.items).sort((a, b) => a.code.localeCompare(b.code));
  const grossTotal = round2(lineItems.reduce((s, i) => s + i.total, 0));
  const rSq = roofSq || round2(roofSf / 100);

  const parts = [`${normalized.length} observations analyzed`, `${lineItems.length} scope items generated`, `gross total $${grossTotal.toFixed(2)}`];
  if (rSq > 0) parts.push(`roof scope ${rSq} SQ`);
  if (sidingSf > 0) parts.push(`siding ${sidingSf} SF`);
  if (interiorSf > 0) parts.push(`interior ${interiorSf} SF`);
  if (gutterLf > 0) parts.push(`gutters ${gutterLf} LF`);
  if (windowCount > 0) parts.push(`windows ${windowCount} EA`);

  const assumptions = [
    "Xactimate-style line item codes are internal placeholders and should be mapped to your exact approved price list/code set.",
    "Quantities derived from photos are provisional until field measurements or roof reports confirm dimensions.",
    ...coded.assumptions,
  ];

  return {
    summary: parts.join(" | "),
    observations: normalized,
    lineItems,
    warnings: coded.warnings,
    assumptions,
    metrics: { roofSquares: rSq, sidingSf, interiorSf, gutterLf, windowCount, grossTotal },
    contextUsed: context,
  };
}

// ─── JSON extraction helper ───
function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const f = trimmed.indexOf("{");
  const l = trimmed.lastIndexOf("}");
  if (f !== -1 && l !== -1 && l > f) return trimmed.slice(f, l + 1);
  throw new Error("No valid JSON object found in model response");
}

// ─── Handler ───
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY not configured');

    const body = await req.json();
    const imageBase64 = body?.imageBase64 as string | undefined;
    const mimeType = body?.mimeType as string | undefined;

    if (!imageBase64 || !mimeType) {
      return new Response(JSON.stringify({ error: "imageBase64 and mimeType are required" }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const context: ScopeContext = {
      state: body?.state ?? "NJ",
      repairPercent: body?.repairPercent,
      discontinuedMaterial: body?.discontinuedMaterial,
      brittleTestFailed: body?.brittleTestFailed,
      matchingRequired: body?.matchingRequired,
      ridgeVentPresent: body?.ridgeVentPresent,
      dripEdgePresent: body?.dripEdgePresent,
      iceBarrierPresent: body?.iceBarrierPresent,
      wasteFactor: body?.wasteFactor,
    };

    const prompt = `You are an insurance field estimating assistant.
Analyze the uploaded property damage image and return ONLY valid JSON.

Return this exact schema:
{
  "summary": "short summary",
  "observations": [
    {
      "category": "roof|siding|interior|window|gutter|fence|other",
      "component": "string",
      "material": "string",
      "damageType": "string",
      "severity": "low|medium|high",
      "repairability": "repair|replace|undetermined",
      "quantityBasis": "string",
      "recommendedQuantity": 1,
      "unit": "EA|SF|LF|SQ",
      "confidence": 0.0,
      "rationale": "string"
    }
  ]
}

Rules:
- Be conservative and evidence-based.
- Identify probable material when reasonably visible.
- If quantity cannot be measured from image, use a reasonable visible estimate and explain quantityBasis.
- confidence must be a number from 0 to 1.
- Return no markdown fences.
- Return an empty observations array if the image does not clearly show property damage.`;

    const aiResp = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        temperature: 0.2,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: [
            { type: 'text', text: 'Analyze this property damage photo for estimate-building and scope mapping.' },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          ]},
        ],
      }),
    });

    if (!aiResp.ok) {
      const errText = await aiResp.text();
      throw new Error(`AI gateway error ${aiResp.status}: ${errText.slice(0, 200)}`);
    }

    const aiData = await aiResp.json();
    const raw = aiData.choices?.[0]?.message?.content ?? "{}";
    const jsonText = extractJson(raw);
    const parsed = JSON.parse(jsonText) as { summary?: string; observations?: DamageObservation[] };
    const observations = Array.isArray(parsed.observations) ? parsed.observations : [];

    const scope = buildFullScope(observations, context);

    return new Response(JSON.stringify({
      aiSummary: parsed.summary ?? "",
      summary: scope.summary,
      observations: scope.observations,
      estimateItems: scope.lineItems,
      warnings: scope.warnings,
      assumptions: scope.assumptions,
      metrics: scope.metrics,
      contextUsed: scope.contextUsed,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('darwin-scope-engine error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
