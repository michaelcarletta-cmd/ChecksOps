/**
 * Manufacturer Requirement Library
 * Function-first requirements: what FUNCTION does this serve, what BREAKS if omitted,
 * what SEQUENCE dependency exists, what FAILURE RISK results.
 */

export interface ManufacturerRequirement {
  manufacturer: string;
  normalizedItem: string;
  requirementText: string;
  functionText: string;
  failureRisk: string;
  warrantyNote: string | null;
  systemRequirement: boolean;
  confidence: "direct" | "inferred";
}

const REQUIREMENTS: ManufacturerRequirement[] = [
  // GAF
  { manufacturer: "GAF", normalizedItem: "Starter Strip", requirementText: "GAF requires ProStart or comparable starter strip for proper shingle adhesion and wind warranty compliance.", functionText: "Provides the adhesive seal line for the first course of shingles, preventing wind uplift at the most vulnerable roof edge.", failureRisk: "Without starter strip, the first course lacks sealant adhesion, resulting in wind blow-off and voided manufacturer warranty.", warrantyNote: "Required for GAF System Plus or higher warranty.", systemRequirement: true, confidence: "direct" },
  { manufacturer: "GAF", normalizedItem: "Ridge Cap", requirementText: "GAF specifies Seal-A-Ridge or TimberTex ridge cap shingles to complete the roofing system.", functionText: "Seals the ridge line where opposing roof planes converge, completing the water shedding system at its highest point.", failureRisk: "Exposed ridge allows direct water penetration into attic space and compromises the entire roof system integrity.", warrantyNote: "Required for warranty registration.", systemRequirement: true, confidence: "direct" },
  { manufacturer: "GAF", normalizedItem: "Synthetic Underlayment", requirementText: "GAF requires FeltBuster or Deck-Armor synthetic underlayment for warranty compliance.", functionText: "Serves as the secondary water barrier protecting the roof deck during and after shingle installation.", failureRisk: "Absence of underlayment exposes the roof deck to moisture intrusion during installation and through any future shingle damage.", warrantyNote: "GAF System Plus and above require GAF-branded underlayment.", systemRequirement: true, confidence: "direct" },
  { manufacturer: "GAF", normalizedItem: "Ice & Water Shield", requirementText: "GAF requires WeatherWatch or StormGuard ice and water barrier at eaves, valleys, and penetrations.", functionText: "Self-adhering membrane that seals around fastener penetrations at vulnerable locations to prevent ice dam and wind-driven rain infiltration.", failureRisk: "Without ice and water shield, fastener penetrations at eaves and valleys become direct water entry points during ice dam events.", warrantyNote: "Required in all jurisdictions with freezing temperatures.", systemRequirement: true, confidence: "direct" },
  { manufacturer: "GAF", normalizedItem: "Ridge Vent", requirementText: "GAF recommends Cobra ridge vent products for proper attic ventilation in completed systems.", functionText: "Provides continuous exhaust ventilation that regulates attic temperature and prevents condensation damage to decking and shingles.", failureRisk: "Inadequate ventilation causes premature shingle aging, deck rot from condensation, and ice dam formation in cold climates.", warrantyNote: "Ventilation required per manufacturer specifications.", systemRequirement: true, confidence: "direct" },
  { manufacturer: "GAF", normalizedItem: "Field Shingles", requirementText: "GAF Timberline HDZ or equivalent laminated shingles must be installed per manufacturer nailing pattern and exposure specifications.", functionText: "Primary water shedding surface that must be installed in sequence after underlayment, ice shield, starter strip, and flashing components.", failureRisk: "Improper nailing pattern or exposure voids manufacturer warranty and compromises wind resistance ratings.", warrantyNote: "Improper nailing voids manufacturer warranty.", systemRequirement: false, confidence: "direct" },
  { manufacturer: "GAF", normalizedItem: "Drip Edge", requirementText: "GAF requires drip edge at eaves and rakes for proper water management and warranty compliance.", functionText: "Directs water runoff from the roof edge into the gutter system and prevents water wicking back under the roof deck.", failureRisk: "Without drip edge, water wicks under the deck edge causing fascia rot and potential structural damage to the roof perimeter.", warrantyNote: "Most building codes also require drip edge.", systemRequirement: true, confidence: "direct" },

  // CertainTeed
  { manufacturer: "CertainTeed", normalizedItem: "Starter Strip", requirementText: "CertainTeed requires SwiftStart starter strip for proper adhesion and SureStart warranty eligibility.", functionText: "Provides the factory-applied sealant line that bonds the first shingle course to the roof edge.", failureRisk: "Missing starter strip eliminates wind resistance at the eave, the area most susceptible to wind uplift.", warrantyNote: "Required for SureStart Plus warranty.", systemRequirement: true, confidence: "direct" },
  { manufacturer: "CertainTeed", normalizedItem: "Ridge Cap", requirementText: "CertainTeed specifies Shadow Ridge or comparable hip and ridge shingles.", functionText: "Seals ridge and hip intersections with purpose-manufactured components designed for high-exposure locations.", failureRisk: "Field-cut shingles at ridges lack proper thickness and adhesion, leading to premature failure at the roof's highest points.", warrantyNote: "Required for integrated system warranty.", systemRequirement: true, confidence: "direct" },
  { manufacturer: "CertainTeed", normalizedItem: "Synthetic Underlayment", requirementText: "CertainTeed requires DiamondDeck or equivalent synthetic underlayment.", functionText: "Secondary water barrier installed directly on the roof deck prior to shingle application.", failureRisk: "Omission removes the secondary defense layer, leaving the roof deck unprotected if shingles are damaged or displaced.", warrantyNote: "Required for full system warranty coverage.", systemRequirement: true, confidence: "direct" },
  { manufacturer: "CertainTeed", normalizedItem: "Field Shingles", requirementText: "CertainTeed Landmark or equivalent must be installed per published installation instructions.", functionText: "Primary water shedding surface installed in proper sequence over prepared substrate.", failureRisk: "Deviation from published installation instructions compromises performance and voids warranty.", warrantyNote: null, systemRequirement: false, confidence: "direct" },

  // Owens Corning
  { manufacturer: "Owens Corning", normalizedItem: "Starter Strip", requirementText: "Owens Corning requires Starter Strip Plus for proper adhesion and Preferred Protection warranty.", functionText: "Factory-sealant starter that creates the wind-resistant bond for the first shingle course.", failureRisk: "First course without starter adhesion is vulnerable to blow-off in moderate wind events.", warrantyNote: "Required for Total Protection Roofing System.", systemRequirement: true, confidence: "direct" },
  { manufacturer: "Owens Corning", normalizedItem: "Ridge Cap", requirementText: "Owens Corning specifies DecoRidge or TruDefinition hip & ridge shingles.", functionText: "Purpose-manufactured ridge components that provide superior coverage and adhesion at ridge intersections.", failureRisk: "Improper ridge treatment allows water infiltration at the roof apex and reduces system wind resistance.", warrantyNote: "Required for system warranty.", systemRequirement: true, confidence: "direct" },
  { manufacturer: "Owens Corning", normalizedItem: "Synthetic Underlayment", requirementText: "Owens Corning requires ProArmor synthetic underlayment for Total Protection Roofing System.", functionText: "Engineered secondary barrier that protects the deck during installation and provides long-term moisture defense.", failureRisk: "Omission leaves the structural deck exposed to moisture during and after construction.", warrantyNote: "Required for platinum-level warranty.", systemRequirement: true, confidence: "direct" },
  { manufacturer: "Owens Corning", normalizedItem: "Field Shingles", requirementText: "Owens Corning Duration or TruDefinition Duration shingles require SureNail Technology installation.", functionText: "Primary roof surface with patented nailing zone that ensures consistent fastener placement.", failureRisk: "Nailing outside the SureNail strip reduces wind resistance and voids the manufacturer warranty.", warrantyNote: null, systemRequirement: false, confidence: "direct" },

  // Tamko
  { manufacturer: "Tamko", normalizedItem: "Starter Strip", requirementText: "Tamko requires Tam-Pro starter strip for proper adhesion and limited warranty compliance.", functionText: "Creates the adhesive bond for the first course at the eave edge.", failureRisk: "Without manufacturer-specified starter, the first course lacks required wind resistance.", warrantyNote: null, systemRequirement: true, confidence: "direct" },
  { manufacturer: "Tamko", normalizedItem: "Field Shingles", requirementText: "Tamko Heritage or equivalent laminated shingles must be installed per manufacturer specifications.", functionText: "Primary water shedding component installed per specified nailing and exposure requirements.", failureRisk: "Deviation from specifications voids limited warranty protection.", warrantyNote: null, systemRequirement: false, confidence: "direct" },

  // James Hardie
  { manufacturer: "James Hardie", normalizedItem: "Fiber Cement Siding", requirementText: "James Hardie HardiePlank requires installation per HardieZone-specific guidelines with approved fasteners and flashing.", functionText: "Primary exterior cladding that forms the outermost layer of the weather barrier system.", failureRisk: "Improper installation allows moisture behind the cladding, leading to wall assembly damage and voided 30-year warranty.", warrantyNote: "Improper installation voids 30-year warranty.", systemRequirement: false, confidence: "direct" },
  { manufacturer: "James Hardie", normalizedItem: "House Wrap", requirementText: "James Hardie requires a code-compliant weather-resistive barrier behind all siding installations.", functionText: "Critical secondary drainage plane that prevents bulk water from reaching the wall sheathing and framing.", failureRisk: "Absence of WRB allows moisture to penetrate the wall assembly, causing structural damage and mold growth.", warrantyNote: "HardieWrap or equivalent WRB required.", systemRequirement: true, confidence: "direct" },
];

/**
 * Look up manufacturer requirements for a normalized item.
 * Returns function-first reasoning with failure risk context.
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
