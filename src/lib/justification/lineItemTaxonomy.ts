/**
 * Line Item Normalization Taxonomy
 * Maps common Xactimate shorthand / variations → canonical normalized names.
 */

export interface TaxonomyEntry {
  normalized: string;
  trade: string;
  aliases: string[];
}

export const LINE_ITEM_TAXONOMY: TaxonomyEntry[] = [
  // Roofing
  { normalized: "Starter Strip", trade: "roofing", aliases: ["RFG STTR", "starter", "starter strip", "edge starter", "RFGSTTR"] },
  { normalized: "Field Shingles", trade: "roofing", aliases: ["LAM SHINGLE", "lam shingle", "shingle", "architectural shingle", "dimensional shingle", "RFGLAM", "RFG LAM"] },
  { normalized: "Ridge Cap", trade: "roofing", aliases: ["RIDGE CAP", "ridge cap", "hip cap", "ridge shingle", "RFGRDG", "RFG RDG"] },
  { normalized: "Hip & Ridge", trade: "roofing", aliases: ["hip and ridge", "hip ridge", "hip & ridge"] },
  { normalized: "Drip Edge", trade: "roofing", aliases: ["drip edge", "DRIP EDGE", "eave metal", "rake metal", "RFGDRP", "RFG DRP"] },
  { normalized: "Ice & Water Shield", trade: "roofing", aliases: ["ice barrier", "ice shield", "ice water shield", "ice & water", "RFGICE", "RFG ICE"] },
  { normalized: "Synthetic Underlayment", trade: "roofing", aliases: ["underlayment", "synthetic felt", "felt", "RFGFELT", "RFG FELT", "roof felt"] },
  { normalized: "Ridge Vent", trade: "roofing", aliases: ["ridge vent", "RIDGE VENT", "attic vent", "RFGVENT"] },
  { normalized: "Pipe Boot/Flashing", trade: "roofing", aliases: ["pipe boot", "pipe flashing", "plumbing boot", "vent boot", "RFGFLSH"] },
  { normalized: "Step Flashing", trade: "roofing", aliases: ["step flash", "step flashing", "wall flashing", "RFGSTEP"] },
  { normalized: "Valley Metal/Lining", trade: "roofing", aliases: ["valley metal", "valley", "valley lining", "RFGVLY"] },
  { normalized: "Roof Decking", trade: "roofing", aliases: ["decking", "plywood", "OSB", "roof deck", "sheathing", "RFGDECK"] },
  { normalized: "Tear-Off", trade: "roofing", aliases: ["tear off", "tearoff", "remove shingles", "strip roof", "RFGTO"] },
  { normalized: "Disposal/Haul-Off", trade: "roofing", aliases: ["disposal", "haul off", "dump fee", "debris removal", "RFGDISP"] },

  // Gutters
  { normalized: "Gutters", trade: "gutters", aliases: ["gutter", "gutters", "seamless gutter", "K-style gutter", "GTRK"] },
  { normalized: "Downspouts", trade: "gutters", aliases: ["downspout", "downspouts", "leader", "GTRDS"] },
  { normalized: "Gutter Guards", trade: "gutters", aliases: ["gutter guard", "leaf guard", "gutter screen"] },

  // Siding
  { normalized: "Vinyl Siding", trade: "siding", aliases: ["vinyl siding", "siding", "SIDVINYL", "SID VINYL"] },
  { normalized: "Fiber Cement Siding", trade: "siding", aliases: ["hardie", "james hardie", "fiber cement", "hardieplank", "SIDFIBER"] },
  { normalized: "House Wrap", trade: "siding", aliases: ["house wrap", "tyvek", "weather barrier", "WRB", "SIDWRAP"] },
  { normalized: "Soffit", trade: "siding", aliases: ["soffit", "SOFFIT", "eave soffit"] },
  { normalized: "Fascia", trade: "siding", aliases: ["fascia", "FASCIA", "fascia board"] },

  // Interior
  { normalized: "Drywall Repair", trade: "interior", aliases: ["drywall", "drywall repair", "sheetrock", "DRYWALL"] },
  { normalized: "Drywall Replace", trade: "interior", aliases: ["drywall replace", "drywall replacement", "DRYWALLREPL"] },
  { normalized: "Paint", trade: "interior", aliases: ["paint", "interior paint", "repaint", "PAINT"] },
  { normalized: "Baseboard", trade: "interior", aliases: ["baseboard", "base molding", "base trim", "BASEBOARD"] },
  { normalized: "Insulation", trade: "interior", aliases: ["insulation", "batt insulation", "blown insulation", "INSUL"] },

  // Windows
  { normalized: "Window", trade: "windows", aliases: ["window", "WINDOW", "window unit", "window replacement"] },
  { normalized: "Window Screen", trade: "windows", aliases: ["window screen", "screen", "insect screen"] },

  // General
  { normalized: "Overhead & Profit", trade: "general", aliases: ["O&P", "overhead", "overhead and profit", "contractor overhead", "OH&P"] },
  { normalized: "Permit", trade: "general", aliases: ["permit", "building permit", "permit fee"] },
  { normalized: "Code Upgrade", trade: "general", aliases: ["code upgrade", "code compliance", "building code"] },
];

const aliasMap = new Map<string, TaxonomyEntry>();
for (const entry of LINE_ITEM_TAXONOMY) {
  for (const alias of entry.aliases) {
    aliasMap.set(alias.toLowerCase().trim(), entry);
  }
  aliasMap.set(entry.normalized.toLowerCase().trim(), entry);
}

/** Normalize a raw line-item description to its canonical name and trade. */
export function normalizeLineItem(raw: string): { normalized: string; trade: string } {
  const key = raw.toLowerCase().trim();
  const exact = aliasMap.get(key);
  if (exact) return { normalized: exact.normalized, trade: exact.trade };

  // Fuzzy: check if any alias is a substring
  for (const entry of LINE_ITEM_TAXONOMY) {
    for (const alias of entry.aliases) {
      if (key.includes(alias.toLowerCase())) {
        return { normalized: entry.normalized, trade: entry.trade };
      }
    }
  }

  return { normalized: raw, trade: "other" };
}
