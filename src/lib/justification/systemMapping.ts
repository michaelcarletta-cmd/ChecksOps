/**
 * System-Based Reasoning Map
 * Every line item maps to ONE functional system.
 * Used to generate function-first justification language.
 */

export interface SystemDefinition {
  system: string;
  functionDescription: string;
}

const TRADE_SYSTEM_MAP: Record<string, SystemDefinition> = {
  roofing: {
    system: "water shedding system",
    functionDescription: "protect the structure from water intrusion and weather exposure",
  },
  siding: {
    system: "weather barrier system",
    functionDescription: "maintain the exterior envelope and prevent moisture infiltration",
  },
  interior: {
    system: "continuous finish system",
    functionDescription: "restore interior surfaces to a continuous, code-compliant condition",
  },
  gutters: {
    system: "water management system",
    functionDescription: "direct water away from the structure and protect the foundation",
  },
  windows: {
    system: "building envelope system",
    functionDescription: "maintain thermal performance and weather resistance of the building envelope",
  },
  general: {
    system: "construction compliance system",
    functionDescription: "ensure the project meets regulatory and contractual requirements",
  },
  other: {
    system: "building restoration system",
    functionDescription: "restore the damaged property to its pre-loss condition",
  },
};

/** Item-specific function descriptions (override trade-level generic) */
const ITEM_FUNCTION_MAP: Record<string, string> = {
  "Starter Strip": "establishes the sealing edge of the water shedding system, enabling proper adhesion and wind resistance of the first shingle course",
  "Field Shingles": "provides the primary water shedding surface, protecting the roof deck and interior from precipitation and weather exposure",
  "Ridge Cap": "seals the ridge intersection where opposing roof planes meet, preventing water intrusion at the highest point of the roof system",
  "Hip & Ridge": "seals hip and ridge intersections to maintain continuity of the water shedding system across all roof planes",
  "Drip Edge": "directs water away from fascia and into the gutter system, preventing wood rot and water damage at the roof edge",
  "Ice & Water Shield": "provides a self-adhering waterproof membrane at vulnerable areas to prevent ice dam and wind-driven rain infiltration",
  "Synthetic Underlayment": "provides a secondary water barrier beneath the shingle layer, protecting the roof deck from moisture penetration",
  "Ridge Vent": "enables continuous exhaust ventilation to regulate attic temperature and moisture, preventing premature shingle degradation and condensation damage",
  "Pipe Boot/Flashing": "creates a watertight seal around roof penetrations to prevent water intrusion at pipe and vent locations",
  "Step Flashing": "prevents water intrusion at wall-to-roof intersections by directing water away from the joint and onto the roof surface",
  "Valley Metal/Lining": "channels concentrated water flow in roof valleys, preventing ponding and leakage at high-volume drainage points",
  "Roof Decking": "provides the structural substrate that supports the entire roofing system and transfers loads to the framing",
  "Tear-Off": "removes compromised roofing materials to expose the substrate for inspection and proper installation of new system components",
  "Disposal/Haul-Off": "removes debris from the jobsite as required for safe working conditions and code compliance",
  "Gutters": "collects and channels roof runoff to protect the foundation, landscaping, and exterior walls from water damage",
  "Downspouts": "conveys collected water from gutters to grade level, directing it away from the foundation",
  "Vinyl Siding": "provides the primary weather-resistant exterior cladding that protects the wall assembly from moisture and impact",
  "Fiber Cement Siding": "serves as the exterior cladding of the weather barrier system, providing impact resistance and moisture protection",
  "House Wrap": "functions as the weather-resistive barrier behind exterior cladding, preventing bulk water infiltration while allowing vapor transmission",
  "Soffit": "provides ventilation intake for the attic system and protects rafter tails from weather exposure",
  "Fascia": "seals the exposed rafter ends and provides a mounting surface for the gutter system",
  "Drywall Repair": "restores the continuous interior finish surface to a uniform, code-compliant condition",
  "Drywall Replace": "replaces damaged substrate to restore structural integrity and continuity of the interior finish system",
  "Paint": "restores the protective and aesthetic finish of the continuous interior surface system",
  "Baseboard": "provides the transition trim between wall and floor surfaces, completing the continuous finish system",
  "Insulation": "restores the thermal barrier required for energy code compliance and occupant comfort",
  "Window": "restores the glazing component of the building envelope, maintaining thermal performance and weather resistance",
  "Window Screen": "restores the ventilation screening component of the window assembly",
  "Overhead & Profit": "compensates the general contractor for project coordination, supervision, liability, and profit as required when multiple trades are involved",
  "Permit": "satisfies the jurisdictional requirement for a building permit prior to commencing regulated construction work",
  "Code Upgrade": "brings the damaged system into compliance with current adopted building code requirements as mandated by local jurisdiction",
};

export function getSystemForTrade(trade: string): SystemDefinition {
  return TRADE_SYSTEM_MAP[trade] || TRADE_SYSTEM_MAP.other;
}

export function getItemFunction(normalizedItem: string, trade: string): string {
  return ITEM_FUNCTION_MAP[normalizedItem] || getSystemForTrade(trade).functionDescription;
}
