/**
 * Building Code Requirement Engine
 * Returns adopted code year and relevant section references per state.
 * NEVER fabricates section numbers. Uses known references or safe fallbacks.
 */

export interface CodeRequirement {
  normalizedItem: string;
  codeReference: string;
  requirementText: string;
  confidence: "direct" | "inferred";
}

interface StateCodeInfo {
  adoptedCode: string;
  codeYear: string;
}

const STATE_CODES: Record<string, StateCodeInfo> = {
  NJ: { adoptedCode: "IRC/IBC", codeYear: "2021" },
  PA: { adoptedCode: "IRC/IBC (UCC)", codeYear: "2018" },
  TX: { adoptedCode: "IRC/IBC", codeYear: "2021" },
  FL: { adoptedCode: "FBC (Florida Building Code)", codeYear: "2023" },
  NY: { adoptedCode: "IRC/IBC", codeYear: "2020" },
  CA: { adoptedCode: "CBC (California Building Code)", codeYear: "2022" },
  CO: { adoptedCode: "IRC/IBC", codeYear: "2021" },
  GA: { adoptedCode: "IRC/IBC", codeYear: "2018" },
  VA: { adoptedCode: "USBC (Virginia)", codeYear: "2021" },
  MD: { adoptedCode: "IRC/IBC", codeYear: "2021" },
  OH: { adoptedCode: "IRC/IBC (OBC)", codeYear: "2019" },
  IL: { adoptedCode: "IRC/IBC", codeYear: "2021" },
  NC: { adoptedCode: "NC Building Code (IRC/IBC)", codeYear: "2018" },
  SC: { adoptedCode: "IRC/IBC", codeYear: "2018" },
};

// Known code requirements – only include verified references
const CODE_REQUIREMENTS: CodeRequirement[] = [
  { normalizedItem: "Drip Edge", codeReference: "IRC R905.2.8.5", requirementText: "Drip edge is required at eaves and rakes of shingle roofs per adopted residential building code.", confidence: "direct" },
  { normalizedItem: "Ice & Water Shield", codeReference: "IRC R905.2.7.1", requirementText: "Ice barrier underlayment is required in jurisdictions where the January mean temperature is 25°F or less.", confidence: "direct" },
  { normalizedItem: "Synthetic Underlayment", codeReference: "IRC R905.2.7", requirementText: "Underlayment is required beneath asphalt shingles per adopted residential building code.", confidence: "direct" },
  { normalizedItem: "Starter Strip", codeReference: "IRC R905.2.8.1", requirementText: "A starter course is required at eaves per adopted code for proper shingle installation.", confidence: "direct" },
  { normalizedItem: "Ridge Vent", codeReference: "IRC R806", requirementText: "Enclosed attic spaces require ventilation per adopted building code; ridge ventilation satisfies exhaust requirements.", confidence: "inferred" },
  { normalizedItem: "Roof Decking", codeReference: "IRC R803.2", requirementText: "Roof sheathing must meet structural requirements for span, thickness, and fastening per adopted code.", confidence: "direct" },
  { normalizedItem: "Step Flashing", codeReference: "IRC R905.2.8.3", requirementText: "Flashing is required at wall-to-roof intersections per adopted residential code.", confidence: "direct" },
  { normalizedItem: "Valley Metal/Lining", codeReference: "IRC R905.2.8.2", requirementText: "Valley flashing is required per adopted residential code for proper water management.", confidence: "direct" },
  { normalizedItem: "Pipe Boot/Flashing", codeReference: "IRC R905.2.8.3", requirementText: "Flashing is required around all roof penetrations per adopted residential code.", confidence: "direct" },
  { normalizedItem: "House Wrap", codeReference: "IRC R703.2", requirementText: "A weather-resistive barrier is required behind exterior wall coverings per adopted code.", confidence: "direct" },
  { normalizedItem: "Permit", codeReference: "IRC R105.1", requirementText: "A building permit is required for roof replacement and exterior repairs per adopted code.", confidence: "direct" },
];

export function getStateCodeInfo(stateCode: string): StateCodeInfo {
  return STATE_CODES[stateCode?.toUpperCase()] || { adoptedCode: "IRC/IBC", codeYear: "2021" };
}

export function getCodeRequirements(
  normalizedItem: string,
  stateCode: string
): { stateInfo: StateCodeInfo; requirements: CodeRequirement[] } {
  const stateInfo = getStateCodeInfo(stateCode);
  const reqs = CODE_REQUIREMENTS.filter(
    (r) => r.normalizedItem.toLowerCase() === normalizedItem.toLowerCase()
  );

  // If no specific code reference, return safe fallback
  if (reqs.length === 0) {
    return {
      stateInfo,
      requirements: [
        {
          normalizedItem,
          codeReference: `${stateInfo.adoptedCode} (${stateInfo.codeYear})`,
          requirementText: `Must comply with adopted residential code requirements (${stateInfo.adoptedCode}, ${stateInfo.codeYear} edition).`,
          confidence: "inferred",
        },
      ],
    };
  }

  return { stateInfo, requirements: reqs };
}
