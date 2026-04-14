import { callVision, MODEL_VISION } from "../_shared/ai/generate.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// ─── Price Book ───
const PRICE_BOOK: Record<string, number> = {
  RFG240: 525, RFG220: 85, RFGDECK: 12.5, RFGDECKREP: 8.75, RFGDETACHRESET: 4.5,
  FRMRAFREP: 28, RFG300: 8.5, RFGST: 4.5, RFGFELTSYN: 45, RFGICE: 1.85,
  RFGDRIP: 4.25, RFGVENT: 16, SIDVINYL: 74, SIDVINYLREP: 38, SIDFIBER: 96,
  SIDDROP: 1.65, DRYWALL: 3.8, DRYWALLREPL: 5.9, PAINT: 1.95, INSUL: 1.45,
  MOISTMAP: 185, WINREPL: 850, GUT5K: 18, DWN23: 16, FNCREP: 42,
  DRBASEDET: 4.5, DRSHELFDET: 12, DRRODDET: 45, DRLIGHTDET: 65, DRSWDET: 18,
  FLOORPROT: 0.65, DEBRIS: 0.95,
};
function getUnitPrice(code: string): number { return PRICE_BOOK[code] ?? 0; }

// ─── Types ───
type DamageCategory = "roof"|"siding"|"interior"|"window"|"gutter"|"fence"|"other";
type Severity = "low"|"medium"|"high";
type Repairability = "repair"|"replace"|"undetermined";
type AssemblyLayer = "roof_covering"|"underlayment"|"decking"|"framing"|"interior_finish"|"insulation"|"flashing"|"trim"|"unknown";
type DamageMechanism = "water_staining"|"rot"|"delamination"|"sagging"|"active_leak"|"missing_material"|"creased"|"hail_impact"|"wind_damage"|"deterioration"|"unknown";

interface DamageObservation {
  category: DamageCategory; component: string; material: string;
  damageType: string; severity: Severity; repairability: Repairability;
  quantityBasis: string; recommendedQuantity: number; unit: string;
  confidence: number; rationale: string;
  assemblyLayer?: AssemblyLayer; damageMechanism?: DamageMechanism;
  accessRequired?: boolean; structuralConcern?: boolean;
  measurementConfidence?: "low"|"medium"|"high";
  provisionalQuantity?: boolean; visibleAreaOnly?: boolean;
  attachedItems?: string[];
  roomType?: "closet"|"bedroom"|"bathroom"|"kitchen"|"hall"|"attic"|"garage"|"other";
  surfaceOrientation?: "ceiling"|"wall"|"sloped_ceiling"|"other";
  finishLevel?: "painted"|"textured"|"wallpaper"|"unfinished"|"unknown";
  obstructionLevel?: "low"|"medium"|"high";
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
  isProvisionalQuantity?: boolean;
}

interface ScopeWarning {
  type: "no_match"|"low_confidence"|"manual_review"|"code_upgrade"|"matching_issue"|"manual_measurement_required"|"structural_review_recommended"|"access_scope_required";
  message: string; observationIndex?: number;
}

// ─── Utils ───
function round2(v: number): number { return Number(v.toFixed(2)); }

function makeLineItem(args: {
  code: string; description: string; quantity: number; unit: string;
  reasoning: string; sourceObservationIndexes?: number[];
  isCodeRequired?: boolean; isDependency?: boolean; isManualReviewRequired?: boolean;
  isProvisionalQuantity?: boolean;
}): ScopeLineItem {
  const unitPrice = getUnitPrice(args.code);
  return {
    code: args.code, description: args.description,
    quantity: round2(args.quantity), unit: args.unit, unitPrice,
    total: round2(unitPrice * args.quantity), reasoning: args.reasoning,
    sourceObservationIndexes: args.sourceObservationIndexes ?? [],
    isCodeRequired: args.isCodeRequired, isDependency: args.isDependency,
    isManualReviewRequired: args.isManualReviewRequired,
    isProvisionalQuantity: args.isProvisionalQuantity,
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
    existing.isProvisionalQuantity = existing.isProvisionalQuantity || item.isProvisionalQuantity;
  }
  return Array.from(map.values());
}

// ─── Material Classifier ───
function normalizeObservationMaterial(obs: DamageObservation): DamageObservation {
  const text = `${obs.component} ${obs.material} ${obs.damageType} ${obs.rationale}`.toLowerCase();
  let material = obs.material;
  let assemblyLayer: AssemblyLayer = (obs.assemblyLayer as AssemblyLayer) ?? "unknown";
  let damageMechanism: DamageMechanism = (obs.damageMechanism as DamageMechanism) ?? "unknown";
  let structuralConcern = obs.structuralConcern ?? false;
  let accessRequired = obs.accessRequired ?? false;
  let measurementConfidence = obs.measurementConfidence ?? "medium";

  if (text.includes("architectural") || text.includes("laminated") || text.includes("comp shingle") || text.includes("asphalt")) {
    material = "architectural shingle";
    if (assemblyLayer === "unknown") assemblyLayer = "roof_covering";
  } else if (text.includes("vinyl")) { material = "vinyl siding"; }
  else if (text.includes("hardie") || text.includes("fiber cement")) { material = "fiber cement siding"; }
  else if (text.includes("drywall") || text.includes("sheetrock") || text.includes("gypsum")) {
    material = "drywall";
    if (assemblyLayer === "unknown") assemblyLayer = "interior_finish";
  } else if (text.includes("gutter")) { material = "gutter"; }
  else if (text.includes("window")) { material = "window unit"; }
  else if (text.includes("decking") || text.includes("sheathing") || text.includes("roof deck") || text.includes("wood plank") || text.includes("plank")) {
    material = "wood roof decking"; assemblyLayer = "decking"; accessRequired = true; measurementConfidence = "low";
  } else if (text.includes("rafter") || text.includes("truss") || text.includes("joist") || text.includes("framing") || text.includes("wood member")) {
    material = "wood framing"; assemblyLayer = "framing"; structuralConcern = true; accessRequired = true; measurementConfidence = "low";
  } else if (text.includes("insulation")) { material = "insulation"; assemblyLayer = "insulation"; }

  if (text.includes("water stain") || text.includes("staining") || text.includes("water damage")) damageMechanism = "water_staining";
  if (text.includes("rot") || text.includes("rotted") || text.includes("decay")) {
    damageMechanism = "rot";
    structuralConcern = structuralConcern || assemblyLayer === "framing" || assemblyLayer === "decking";
  }
  if (text.includes("delamin")) damageMechanism = "delamination";
  if (text.includes("sag") || text.includes("bow")) { damageMechanism = "sagging"; structuralConcern = true; }
  if (text.includes("active leak") || text.includes("drip")) damageMechanism = "active_leak";

  const visibleAreaOnly = obs.visibleAreaOnly ?? measurementConfidence === "low";
  const provisionalQuantity = obs.provisionalQuantity ?? measurementConfidence === "low";

  return { ...obs, material, assemblyLayer, damageMechanism, structuralConcern, accessRequired, measurementConfidence, visibleAreaOnly, provisionalQuantity };
}

// ─── Xactimate Map ───
interface XactimateTemplate {
  code: string; description: string; defaultUnit: string; category: string;
  appliesWhen: {
    category?: DamageCategory; materialIncludes?: string[]; damageTypeIncludes?: string[];
    repairability?: Repairability[]; assemblyLayers?: AssemblyLayer[];
    damageMechanisms?: DamageMechanism[]; structuralConcern?: boolean;
  };
}

const XACTIMATE_MAP: XactimateTemplate[] = [
  { code: "RFG240", description: "Remove and replace laminated composition shingles", defaultUnit: "SQ", category: "roof", appliesWhen: { category: "roof", materialIncludes: ["architectural","laminated","composition","asphalt"], repairability: ["replace"] }},
  { code: "RFG220", description: "Repair composition shingle roofing", defaultUnit: "EA", category: "roof", appliesWhen: { category: "roof", materialIncludes: ["architectural","laminated","composition","asphalt"], repairability: ["repair"] }},
  { code: "RFGDECK", description: "Remove and replace roof decking", defaultUnit: "SF", category: "roof", appliesWhen: { category: "roof", assemblyLayers: ["decking"], damageMechanisms: ["rot","delamination","water_staining","deterioration"], repairability: ["replace","undetermined"] }},
  { code: "RFGDECKREP", description: "Repair roof decking", defaultUnit: "SF", category: "roof", appliesWhen: { category: "roof", assemblyLayers: ["decking"], repairability: ["repair"] }},
  { code: "FRMRAFREP", description: "Repair or reinforce roof framing member", defaultUnit: "LF", category: "roof", appliesWhen: { category: "roof", assemblyLayers: ["framing"], structuralConcern: true }},
  { code: "SIDVINYL", description: "Remove and replace vinyl siding", defaultUnit: "SF", category: "siding", appliesWhen: { category: "siding", materialIncludes: ["vinyl"], repairability: ["replace"] }},
  { code: "SIDVINYLREP", description: "Repair vinyl siding", defaultUnit: "SF", category: "siding", appliesWhen: { category: "siding", materialIncludes: ["vinyl"], repairability: ["repair"] }},
  { code: "SIDFIBER", description: "Remove and replace fiber cement siding", defaultUnit: "SF", category: "siding", appliesWhen: { category: "siding", materialIncludes: ["fiber cement","hardie","cement board"], repairability: ["replace"] }},
  { code: "DRYWALL", description: "Repair drywall", defaultUnit: "SF", category: "interior", appliesWhen: { category: "interior", materialIncludes: ["drywall","gypsum","sheetrock"] }},
  { code: "DRYWALLREPL", description: "Remove and replace drywall", defaultUnit: "SF", category: "interior", appliesWhen: { category: "interior", materialIncludes: ["drywall","gypsum","sheetrock"], repairability: ["replace"] }},
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
    if (a.structuralConcern !== undefined && a.structuralConcern !== !!obs.structuralConcern) continue;
    if (a.assemblyLayers && (!obs.assemblyLayer || !a.assemblyLayers.includes(obs.assemblyLayer))) continue;
    if (a.damageMechanisms && (!obs.damageMechanism || !a.damageMechanisms.includes(obs.damageMechanism))) continue;
    if (a.materialIncludes && !a.materialIncludes.some(m => material.includes(m))) continue;
    if (a.damageTypeIncludes && !a.damageTypeIncludes.some(d => damageType.includes(d))) continue;
    return t;
  }
  return null;
}

// ─── Interior Access Rules ───
function estimateBaseboardLf(areaSf: number): number {
  if (!areaSf) return 8;
  return Math.max(8, Math.sqrt(areaSf) * 2);
}

function addInteriorAccessItems(obs: DamageObservation, baseQuantitySf: number, observationIndex: number): ScopeLineItem[] {
  const items: ScopeLineItem[] = [];
  const text = `${obs.component} ${obs.rationale} ${obs.damageType}`.toLowerCase();
  const attached = (obs.attachedItems ?? []).map(x => x.toLowerCase());
  const roomType = (obs.roomType ?? "").toLowerCase();
  const surface = (obs.surfaceOrientation ?? "").toLowerCase();

  // Wall drywall → baseboard detach/reset
  if (surface === "wall" || text.includes("wall")) {
    items.push(makeLineItem({ code: "DRBASEDET", description: "Detach and reset baseboard trim", quantity: estimateBaseboardLf(baseQuantitySf), unit: "LF", reasoning: "Baseboard detach/reset added because wall drywall replacement typically requires trim removal at floor line.", sourceObservationIndexes: [observationIndex], isDependency: true, isProvisionalQuantity: true }));
  }

  // Closet → shelving & rod detach/reset
  if (roomType === "closet" || text.includes("closet") || attached.includes("shelving")) {
    items.push(makeLineItem({ code: "DRSHELFDET", description: "Detach and reset closet shelving", quantity: Math.max(4, estimateBaseboardLf(baseQuantitySf) / 2), unit: "LF", reasoning: "Closet shelving detach/reset added because drywall access is likely obstructed by installed shelves.", sourceObservationIndexes: [observationIndex], isDependency: true, isProvisionalQuantity: true }));
    items.push(makeLineItem({ code: "DRRODDET", description: "Detach and reset closet rod/hardware", quantity: 1, unit: "EA", reasoning: "Closet rod/hardware detach/reset added as likely access dependency.", sourceObservationIndexes: [observationIndex], isDependency: true, isProvisionalQuantity: true }));
  }

  // Ceiling → light fixture detach/reset
  if (surface === "ceiling" || text.includes("ceiling")) {
    items.push(makeLineItem({ code: "DRLIGHTDET", description: "Detach and reset light fixture", quantity: 1, unit: "EA", reasoning: "Ceiling work may require fixture detach/reset in affected area.", sourceObservationIndexes: [observationIndex], isDependency: true, isProvisionalQuantity: true }));
  }

  // Floor protection (always for interior demo/replacement)
  items.push(makeLineItem({ code: "FLOORPROT", description: "Floor and contents protection", quantity: Math.max(baseQuantitySf, 16), unit: "SF", reasoning: "Protection added because drywall demolition/replacement creates dust and debris in occupied interior space.", sourceObservationIndexes: [observationIndex], isDependency: true, isProvisionalQuantity: true }));

  // Debris removal (always for interior demo/replacement)
  items.push(makeLineItem({ code: "DEBRIS", description: "Debris removal", quantity: Math.max(baseQuantitySf, 16), unit: "SF", reasoning: "Debris removal added due to drywall demolition and disposal needs.", sourceObservationIndexes: [observationIndex], isDependency: true, isProvisionalQuantity: true }));

  return items;
}

// ─── Dependency Rules ───
function deriveQuantity(obs: DamageObservation, defaultUnit: string, context: ScopeContext): number {
  const q = obs.recommendedQuantity || 1;
  const wf = context.wasteFactor ?? 0.1;
  if (obs.measurementConfidence === "low") {
    if (defaultUnit === "SQ") return Math.max(0.25, q * (1 + wf));
    if (defaultUnit === "SF") return Math.max(16, q);
    if (defaultUnit === "LF") return Math.max(8, q);
    return Math.max(1, q);
  }
  if (defaultUnit === "SQ") {
    if (obs.unit === "SQ") return q * (1 + wf);
    if (obs.unit === "SF") return (q / 100) * (1 + wf);
    return Math.max(1, q);
  }
  if (defaultUnit === "SF") { if (obs.unit === "SQ") return q * 100; return Math.max(1, q); }
  return Math.max(1, q);
}

function deriveAccessQuantity(obs: DamageObservation): number {
  const q = obs.recommendedQuantity || 1;
  if (obs.unit === "SQ") return q * 100;
  if (obs.unit === "SF") return Math.max(q, 16);
  if (obs.measurementConfidence === "low") return Math.max(32, q);
  return Math.max(q, 16);
}

function buildBaseScopeFromObservations(observations: DamageObservation[], context: ScopeContext): { items: ScopeLineItem[]; warnings: ScopeWarning[] } {
  const items: ScopeLineItem[] = [];
  const warnings: ScopeWarning[] = [];
  observations.forEach((obs, index) => {
    if (obs.confidence < 0.45) warnings.push({ type: "low_confidence", message: `Low-confidence observation for ${obs.component}. Review before relying on automated scope.`, observationIndex: index });
    if (obs.measurementConfidence === "low" || obs.provisionalQuantity) warnings.push({ type: "manual_measurement_required", message: `Manual measurement required for ${obs.component}; visible area does not provide reliable final quantity.`, observationIndex: index });
    if (obs.structuralConcern) warnings.push({ type: "structural_review_recommended", message: `Structural concern flagged for ${obs.component}; framing/decking review recommended.`, observationIndex: index });
    if (obs.accessRequired) warnings.push({ type: "access_scope_required", message: `Access-related scope likely required for ${obs.component} before full repair quantity can be confirmed.`, observationIndex: index });

    const template = findBestTemplate(obs);
    if (!template) { warnings.push({ type: "no_match", message: `No Xactimate mapping found for ${obs.category} / ${obs.material} / ${obs.damageType}.`, observationIndex: index }); return; }
    const quantity = deriveQuantity(obs, template.defaultUnit, context);
    items.push(makeLineItem({ code: template.code, description: template.description, quantity, unit: template.defaultUnit, reasoning: `${obs.component}: ${obs.damageType}; material ${obs.material}; layer ${obs.assemblyLayer ?? "unknown"}; basis ${obs.quantityBasis}`, sourceObservationIndexes: [index], isManualReviewRequired: obs.confidence < 0.6 || !!obs.structuralConcern, isProvisionalQuantity: !!obs.provisionalQuantity }));

    // Interior dependencies
    if (obs.category === "interior") {
      const drywallReplace = obs.repairability === "replace" || obs.damageMechanism === "rot" || obs.damageMechanism === "active_leak";
      items.push(makeLineItem({ code: drywallReplace ? "DRYWALLREPL" : "PAINT", description: drywallReplace ? "Remove and replace drywall" : "Seal and paint affected area", quantity: Math.max(quantity, 1), unit: "SF", reasoning: `${drywallReplace ? "Drywall replacement" : "Paint"} added based on interior finish damage at ${obs.component}.`, sourceObservationIndexes: [index], isDependency: true, isProvisionalQuantity: !!obs.provisionalQuantity }));
      if (drywallReplace) items.push(makeLineItem({ code: "PAINT", description: "Seal and paint affected area", quantity: Math.max(quantity, 1), unit: "SF", reasoning: `Paint added as dependency after drywall replacement at ${obs.component}.`, sourceObservationIndexes: [index], isDependency: true, isProvisionalQuantity: !!obs.provisionalQuantity }));

      // Interior access items (baseboard, shelving, rod, light, floor protection, debris)
      const accessItems = addInteriorAccessItems(obs, Math.max(quantity, 1), index);
      items.push(...accessItems);
    }

    if (obs.category === "interior" && (obs.assemblyLayer === "insulation" || /insulation|wet insulation|ceiling leak|water damage/i.test(`${obs.damageType} ${obs.rationale}`))) items.push(makeLineItem({ code: "INSUL", description: "Replace insulation", quantity: Math.max(quantity, 1), unit: "SF", reasoning: `Insulation replacement added due to probable wet/damaged insulation at ${obs.component}.`, sourceObservationIndexes: [index], isDependency: true, isProvisionalQuantity: !!obs.provisionalQuantity }));

    // Roof access/investigation dependencies
    if (obs.category === "roof" && obs.accessRequired && (obs.assemblyLayer === "decking" || obs.assemblyLayer === "framing")) {
      items.push(makeLineItem({ code: "RFGDETACHRESET", description: "Detach and reset roofing to access substrate", quantity: deriveAccessQuantity(obs), unit: "SF", reasoning: `Access scope added to reach ${obs.assemblyLayer} at ${obs.component}.`, sourceObservationIndexes: [index], isDependency: true, isProvisionalQuantity: true }));
    }
    if (obs.category === "roof" && obs.structuralConcern && !items.some(i => i.code === "MOISTMAP")) {
      items.push(makeLineItem({ code: "MOISTMAP", description: "Moisture mapping / investigative moisture readings", quantity: 1, unit: "EA", reasoning: `Investigation item added due to structural/water-damage concerns at ${obs.component}.`, sourceObservationIndexes: [index], isDependency: true }));
    }

    // Siding dependencies
    if (obs.category === "siding" && obs.repairability === "replace" && !items.some(i => i.code === "SIDDROP")) items.push(makeLineItem({ code: "SIDDROP", description: "Remove and reset house wrap / weather barrier", quantity: Math.max(quantity, 1), unit: "SF", reasoning: `Weather barrier reset added as siding replacement dependency for ${obs.component}.`, sourceObservationIndexes: [index], isDependency: true, isProvisionalQuantity: !!obs.provisionalQuantity }));
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
  const hasDeckingScope = items.some(i => i.code === "RFGDECK" || i.code === "RFGDECKREP");
  const hasStructuralScope = items.some(i => i.code === "FRMRAFREP");

  if (hasFullRoof) {
    if (!items.some(i => i.code === "RFGST")) items.push(makeLineItem({ code: "RFGST", description: "Starter course - composition shingles", quantity: roofPerimeterLf, unit: "LF", reasoning: "Added as roof-system dependency for full shingle replacement.", isDependency: true }));
    if (!items.some(i => i.code === "RFG300")) items.push(makeLineItem({ code: "RFG300", description: "Ridge cap - composition shingles", quantity: ridgeLf, unit: "LF", reasoning: "Added as roof-system dependency for full shingle replacement.", isDependency: true }));
    if (!items.some(i => i.code === "RFGFELTSYN")) items.push(makeLineItem({ code: "RFGFELTSYN", description: "Synthetic felt underlayment", quantity: roofSquares, unit: "SQ", reasoning: "Added as underlayment for roof replacement scope.", isDependency: true }));
    if (!context.dripEdgePresent && !items.some(i => i.code === "RFGDRIP")) { items.push(makeLineItem({ code: "RFGDRIP", description: "Drip edge", quantity: roofPerimeterLf, unit: "LF", reasoning: "Added because drip edge not confirmed present.", isCodeRequired: true })); warnings.push({ type: "code_upgrade", message: "Drip edge added as likely code-required item for roof replacement." }); }
    if ((context.state === "NJ" || context.state === "PA") && !context.iceBarrierPresent && !items.some(i => i.code === "RFGICE")) { items.push(makeLineItem({ code: "RFGICE", description: "Ice and water barrier", quantity: Math.max(roofPerimeterLf * 2, roofSquares * 100 * 0.35), unit: "SF", reasoning: "Added as likely code-required cold-climate eave protection item.", isCodeRequired: true })); warnings.push({ type: "code_upgrade", message: "Ice and water barrier added for probable NJ/PA code compliance." }); }
    if (context.ridgeVentPresent && !items.some(i => i.code === "RFGVENT")) items.push(makeLineItem({ code: "RFGVENT", description: "Ridge vent", quantity: ridgeLf, unit: "LF", reasoning: "Added because ridge vent is present and roof replacement should include replacement/reset.", isDependency: true }));
  }

  if (hasDeckingScope && !items.some(i => i.code === "RFGDETACHRESET")) {
    items.push(makeLineItem({ code: "RFGDETACHRESET", description: "Detach and reset roofing to access substrate", quantity: Math.max(roofSquares * 100, 32), unit: "SF", reasoning: "Added because decking scope typically requires roofing detach/reset access.", isDependency: true, isProvisionalQuantity: true }));
    warnings.push({ type: "access_scope_required", message: "Decking damage indicates access/detach-reset scope is likely required." });
  }

  if (hasStructuralScope) {
    warnings.push({ type: "structural_review_recommended", message: "Structural framing repair appears implicated; contractor/engineer review is recommended." });
    assumptions.push("Structural framing scope may expand after invasive inspection or contractor/engineer evaluation.");
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
    "Low measurement-confidence observations are treated as visible-area indicators, not final measured scope.",
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
      "rationale": "string",
      "assemblyLayer": "roof_covering|underlayment|decking|framing|interior_finish|insulation|flashing|trim|unknown",
      "damageMechanism": "water_staining|rot|delamination|sagging|active_leak|missing_material|creased|hail_impact|wind_damage|deterioration|unknown",
      "accessRequired": true,
      "structuralConcern": false,
      "measurementConfidence": "low|medium|high",
      "provisionalQuantity": true,
      "visibleAreaOnly": true,
      "attachedItems": ["shelving", "closet rod"],
      "roomType": "closet|bedroom|bathroom|kitchen|hall|attic|garage|other",
      "surfaceOrientation": "ceiling|wall|sloped_ceiling|other",
      "finishLevel": "painted|textured|wallpaper|unfinished|unknown",
      "obstructionLevel": "low|medium|high"
    }
  ]
}

Rules:
- Be conservative and evidence-based.
- Identify probable material and assembly layer when reasonably visible.
- For wood framing, sheathing, roof decking, leaks, staining, or rot, set assemblyLayer and damageMechanism carefully.
- If exact quantity cannot be measured from image, use a provisional visible-area estimate and set measurementConfidence to low.
- Set structuralConcern true for rafters, trusses, framing, sagging members, or rot affecting structure.
- Set accessRequired true when roofing, finishes, or coverings would need removal to access damaged substrate/framing.
- Identify roomType when visible (closet, bedroom, bathroom, kitchen, hall, attic, garage).
- Identify surfaceOrientation (ceiling, wall, sloped_ceiling) when the damaged surface is visible.
- List any attachedItems visible that would need detach/reset for repair access (e.g. shelving, closet rod, baseboard, light fixture).
- Set finishLevel based on the visible surface finish (painted, textured, wallpaper, unfinished).
- Set obstructionLevel to indicate how obstructed the damaged area is by contents/fixtures.
- confidence must be a number from 0 to 1.
- Return no markdown fences.
- Return an empty observations array if the image does not clearly show property damage.`;

    const visionResult = await callVision({
      model: MODEL_VISION,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: [
          { type: 'text', text: 'Analyze this property damage photo for estimate-building and scope mapping.' },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
        ]},
      ],
      temperature: 0.2,
    });

    console.log(`[darwin-scope-engine] model=${MODEL_VISION}, cached=false`);

    const raw = visionResult.text ?? "{}";
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
