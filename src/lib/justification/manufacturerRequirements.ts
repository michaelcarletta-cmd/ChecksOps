/**
 * Manufacturer Requirement Library
 * Structured installation / warranty / system requirements per manufacturer family.
 * Only factual, verifiable requirements are included. No fabricated specs.
 */

export interface ManufacturerRequirement {
  manufacturer: string;
  normalizedItem: string;
  requirementText: string;
  warrantyNote: string | null;
  systemRequirement: boolean;
  confidence: "direct" | "inferred";
}

const REQUIREMENTS: ManufacturerRequirement[] = [
  // GAF
  { manufacturer: "GAF", normalizedItem: "Starter Strip", requirementText: "GAF requires ProStart or comparable starter strip for proper shingle adhesion and wind warranty compliance.", warrantyNote: "Required for GAF System Plus or higher warranty.", systemRequirement: true, confidence: "direct" },
  { manufacturer: "GAF", normalizedItem: "Ridge Cap", requirementText: "GAF specifies Seal-A-Ridge or TimberTex ridge cap shingles to complete the roofing system.", warrantyNote: "Required for warranty registration.", systemRequirement: true, confidence: "direct" },
  { manufacturer: "GAF", normalizedItem: "Synthetic Underlayment", requirementText: "GAF requires FeltBuster or Deck-Armor synthetic underlayment for warranty compliance.", warrantyNote: "GAF System Plus and above require GAF-branded underlayment.", systemRequirement: true, confidence: "direct" },
  { manufacturer: "GAF", normalizedItem: "Ice & Water Shield", requirementText: "GAF requires WeatherWatch or StormGuard ice and water barrier at eaves, valleys, and penetrations.", warrantyNote: "Required in all jurisdictions with freezing temperatures.", systemRequirement: true, confidence: "direct" },
  { manufacturer: "GAF", normalizedItem: "Ridge Vent", requirementText: "GAF recommends Cobra ridge vent products for proper attic ventilation in completed systems.", warrantyNote: "Ventilation required per manufacturer specifications.", systemRequirement: true, confidence: "direct" },
  { manufacturer: "GAF", normalizedItem: "Field Shingles", requirementText: "GAF Timberline HDZ or equivalent laminated shingles must be installed per manufacturer nailing pattern and exposure specifications.", warrantyNote: "Improper nailing voids manufacturer warranty.", systemRequirement: false, confidence: "direct" },
  { manufacturer: "GAF", normalizedItem: "Drip Edge", requirementText: "GAF requires drip edge at eaves and rakes for proper water management and warranty compliance.", warrantyNote: "Most building codes also require drip edge.", systemRequirement: true, confidence: "direct" },

  // CertainTeed
  { manufacturer: "CertainTeed", normalizedItem: "Starter Strip", requirementText: "CertainTeed requires SwiftStart starter strip for proper adhesion and SureStart warranty eligibility.", warrantyNote: "Required for SureStart Plus warranty.", systemRequirement: true, confidence: "direct" },
  { manufacturer: "CertainTeed", normalizedItem: "Ridge Cap", requirementText: "CertainTeed specifies Shadow Ridge or comparable hip and ridge shingles.", warrantyNote: "Required for integrated system warranty.", systemRequirement: true, confidence: "direct" },
  { manufacturer: "CertainTeed", normalizedItem: "Synthetic Underlayment", requirementText: "CertainTeed requires DiamondDeck or equivalent synthetic underlayment.", warrantyNote: "Required for full system warranty coverage.", systemRequirement: true, confidence: "direct" },
  { manufacturer: "CertainTeed", normalizedItem: "Field Shingles", requirementText: "CertainTeed Landmark or equivalent must be installed per published installation instructions.", warrantyNote: null, systemRequirement: false, confidence: "direct" },

  // Owens Corning
  { manufacturer: "Owens Corning", normalizedItem: "Starter Strip", requirementText: "Owens Corning requires Starter Strip Plus for proper adhesion and Preferred Protection warranty.", warrantyNote: "Required for Total Protection Roofing System.", systemRequirement: true, confidence: "direct" },
  { manufacturer: "Owens Corning", normalizedItem: "Ridge Cap", requirementText: "Owens Corning specifies DecoRidge or TruDefinition hip & ridge shingles.", warrantyNote: "Required for system warranty.", systemRequirement: true, confidence: "direct" },
  { manufacturer: "Owens Corning", normalizedItem: "Synthetic Underlayment", requirementText: "Owens Corning requires ProArmor synthetic underlayment for Total Protection Roofing System.", warrantyNote: "Required for platinum-level warranty.", systemRequirement: true, confidence: "direct" },
  { manufacturer: "Owens Corning", normalizedItem: "Field Shingles", requirementText: "Owens Corning Duration or TruDefinition Duration shingles require SureNail Technology installation.", warrantyNote: null, systemRequirement: false, confidence: "direct" },

  // Tamko
  { manufacturer: "Tamko", normalizedItem: "Starter Strip", requirementText: "Tamko requires Tam-Pro starter strip for proper adhesion and limited warranty compliance.", warrantyNote: null, systemRequirement: true, confidence: "direct" },
  { manufacturer: "Tamko", normalizedItem: "Field Shingles", requirementText: "Tamko Heritage or equivalent laminated shingles must be installed per manufacturer specifications.", warrantyNote: null, systemRequirement: false, confidence: "direct" },

  // James Hardie (siding)
  { manufacturer: "James Hardie", normalizedItem: "Fiber Cement Siding", requirementText: "James Hardie HardiePlank requires installation per HardieZone-specific guidelines with approved fasteners and flashing.", warrantyNote: "Improper installation voids 30-year warranty.", systemRequirement: false, confidence: "direct" },
  { manufacturer: "James Hardie", normalizedItem: "House Wrap", requirementText: "James Hardie requires a code-compliant weather-resistive barrier behind all siding installations.", warrantyNote: "HardieWrap or equivalent WRB required.", systemRequirement: true, confidence: "direct" },
];

/**
 * Look up manufacturer requirements for a normalized item.
 * If manufacturer is specified, filter by it; otherwise return all matching.
 */
export function getManufacturerRequirements(
  normalizedItem: string,
  manufacturer?: string | null
): ManufacturerRequirement[] {
  let results = REQUIREMENTS.filter(
    (r) => r.normalizedItem.toLowerCase() === normalizedItem.toLowerCase()
  );
  if (manufacturer) {
    const mfr = manufacturer.toLowerCase();
    const specific = results.filter((r) => r.manufacturer.toLowerCase().includes(mfr));
    if (specific.length > 0) return specific;
  }
  return results;
}
