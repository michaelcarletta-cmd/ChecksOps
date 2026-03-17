import { DamageCategory } from "@/types";

export type Repairability = "repair" | "replace" | "undetermined";

export interface ScopeContext {
  state?: string;
  carrier?: string;
  policyForm?: string;
  dateOfLoss?: string;
  roofStories?: number;
  roofPitch?: number;
  roofLayers?: number;
  repairPercent?: number;
  discontinuedMaterial?: boolean;
  brittleTestFailed?: boolean;
  matchingRequired?: boolean;
  iceBarrierPresent?: boolean;
  dripEdgePresent?: boolean;
  starterPresent?: boolean;
  ridgeVentPresent?: boolean;
  feltType?: "15lb" | "30lb" | "synthetic" | "unknown";
  wasteFactor?: number;
}

export interface ScopeObservation {
  category: DamageCategory;
  component: string;
  material: string;
  damageType: string;
  severity: "low" | "medium" | "high";
  repairability: Repairability;
  quantityBasis: string;
  recommendedQuantity: number;
  unit: string;
  confidence: number;
  rationale: string;
}

export interface XactimateTemplate {
  code: string;
  description: string;
  defaultUnit: "EA" | "LF" | "SF" | "SQ";
  category: DamageCategory | "supplement";
  appliesWhen: {
    category?: DamageCategory;
    materialIncludes?: string[];
    damageTypeIncludes?: string[];
    repairability?: Repairability[];
  };
}

export const XACTIMATE_MAP: XactimateTemplate[] = [
  {
    code: "RFG240",
    description: "Remove and replace laminated composition shingles",
    defaultUnit: "SQ",
    category: "roof",
    appliesWhen: {
      category: "roof",
      materialIncludes: ["architectural", "laminated", "composition", "asphalt"],
      repairability: ["replace"]
    }
  },
  {
    code: "RFG220",
    description: "Repair composition shingle roofing",
    defaultUnit: "EA",
    category: "roof",
    appliesWhen: {
      category: "roof",
      materialIncludes: ["architectural", "laminated", "composition", "asphalt"],
      repairability: ["repair"]
    }
  },
  {
    code: "RFG300",
    description: "Ridge cap - composition shingles",
    defaultUnit: "LF",
    category: "supplement",
    appliesWhen: {}
  },
  {
    code: "RFGST",
    description: "Starter course - composition shingles",
    defaultUnit: "LF",
    category: "supplement",
    appliesWhen: {}
  },
  {
    code: "RFGFELTSYN",
    description: "Synthetic felt underlayment",
    defaultUnit: "SQ",
    category: "supplement",
    appliesWhen: {}
  },
  {
    code: "RFGICE",
    description: "Ice and water barrier",
    defaultUnit: "SF",
    category: "supplement",
    appliesWhen: {}
  },
  {
    code: "RFGDRIP",
    description: "Drip edge",
    defaultUnit: "LF",
    category: "supplement",
    appliesWhen: {}
  },
  {
    code: "RFGVENT",
    description: "Ridge vent",
    defaultUnit: "LF",
    category: "supplement",
    appliesWhen: {}
  },
  {
    code: "SIDVINYL",
    description: "Remove and replace vinyl siding",
    defaultUnit: "SF",
    category: "siding",
    appliesWhen: {
      category: "siding",
      materialIncludes: ["vinyl"],
      repairability: ["replace"]
    }
  },
  {
    code: "SIDVINYLREP",
    description: "Repair vinyl siding",
    defaultUnit: "SF",
    category: "siding",
    appliesWhen: {
      category: "siding",
      materialIncludes: ["vinyl"],
      repairability: ["repair"]
    }
  },
  {
    code: "SIDFIBER",
    description: "Remove and replace fiber cement siding",
    defaultUnit: "SF",
    category: "siding",
    appliesWhen: {
      category: "siding",
      materialIncludes: ["fiber cement", "hardie", "cement board"],
      repairability: ["replace"]
    }
  },
  {
    code: "SIDDROP",
    description: "Remove and reset house wrap / weather barrier",
    defaultUnit: "SF",
    category: "supplement",
    appliesWhen: {}
  },
  {
    code: "DRYWALL",
    description: "Repair drywall",
    defaultUnit: "SF",
    category: "interior",
    appliesWhen: {
      category: "interior",
      materialIncludes: ["drywall", "gypsum", "sheetrock"]
    }
  },
  {
    code: "PAINT",
    description: "Seal and paint affected area",
    defaultUnit: "SF",
    category: "supplement",
    appliesWhen: {}
  },
  {
    code: "INSUL",
    description: "Replace insulation",
    defaultUnit: "SF",
    category: "supplement",
    appliesWhen: {}
  },
  {
    code: "WINREPL",
    description: "Replace window unit",
    defaultUnit: "EA",
    category: "window",
    appliesWhen: {
      category: "window",
      repairability: ["replace"]
    }
  },
  {
    code: "GUT5K",
    description: "Replace 5-inch gutter",
    defaultUnit: "LF",
    category: "gutter",
    appliesWhen: {
      category: "gutter",
      repairability: ["replace", "repair"]
    }
  },
  {
    code: "DWN23",
    description: "Replace downspout",
    defaultUnit: "LF",
    category: "gutter",
    appliesWhen: {
      category: "gutter",
      materialIncludes: ["downspout"]
    }
  },
  {
    code: "FNCREP",
    description: "Repair fence",
    defaultUnit: "LF",
    category: "fence",
    appliesWhen: {
      category: "fence"
    }
  }
];

export function findBestTemplate(
  observation: ScopeObservation
): XactimateTemplate | null {
  const material = observation.material.toLowerCase();
  const damageType = observation.damageType.toLowerCase();

  for (const template of XACTIMATE_MAP) {
    const { appliesWhen } = template;

    if (appliesWhen.category && appliesWhen.category !== observation.category) {
      continue;
    }

    if (
      appliesWhen.repairability &&
      !appliesWhen.repairability.includes(observation.repairability)
    ) {
      continue;
    }

    if (
      appliesWhen.materialIncludes &&
      !appliesWhen.materialIncludes.some((m) => material.includes(m))
    ) {
      continue;
    }

    if (
      appliesWhen.damageTypeIncludes &&
      !appliesWhen.damageTypeIncludes.some((d) => damageType.includes(d))
    ) {
      continue;
    }

    return template;
  }

  return null;
}
