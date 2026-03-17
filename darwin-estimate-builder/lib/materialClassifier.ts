import { DamageObservation } from "@/types";

export function normalizeObservationMaterial(
  observation: DamageObservation
): DamageObservation {
  const text =
    `${observation.component} ${observation.material} ${observation.damageType} ${observation.rationale}`.toLowerCase();

  let material = observation.material;
  let assemblyLayer = observation.assemblyLayer ?? "unknown";
  let damageMechanism = observation.damageMechanism ?? "unknown";
  let structuralConcern = observation.structuralConcern ?? false;
  let accessRequired = observation.accessRequired ?? false;
  let measurementConfidence = observation.measurementConfidence ?? "medium";

  if (
    text.includes("architectural") ||
    text.includes("laminated") ||
    text.includes("comp shingle") ||
    text.includes("asphalt")
  ) {
    material = "architectural shingle";
    if (assemblyLayer === "unknown") assemblyLayer = "roof_covering";
  } else if (text.includes("vinyl")) {
    material = "vinyl siding";
  } else if (text.includes("hardie") || text.includes("fiber cement")) {
    material = "fiber cement siding";
  } else if (text.includes("drywall") || text.includes("sheetrock") || text.includes("gypsum")) {
    material = "drywall";
    if (assemblyLayer === "unknown") assemblyLayer = "interior_finish";
  } else if (text.includes("gutter")) {
    material = "gutter";
  } else if (text.includes("window")) {
    material = "window unit";
  } else if (
    text.includes("decking") ||
    text.includes("sheathing") ||
    text.includes("roof deck") ||
    text.includes("wood plank") ||
    text.includes("plank")
  ) {
    material = "wood roof decking";
    assemblyLayer = "decking";
    accessRequired = true;
    measurementConfidence = "low";
  } else if (
    text.includes("rafter") ||
    text.includes("truss") ||
    text.includes("joist") ||
    text.includes("framing") ||
    text.includes("wood member")
  ) {
    material = "wood framing";
    assemblyLayer = "framing";
    structuralConcern = true;
    accessRequired = true;
    measurementConfidence = "low";
  } else if (text.includes("baseboard") || text.includes("trim")) {
    material = "baseboard trim";
    assemblyLayer = "trim";
  } else if (text.includes("insulation")) {
    material = "insulation";
    assemblyLayer = "insulation";
  }

  if (
    text.includes("water stain") ||
    text.includes("staining") ||
    text.includes("water damage")
  ) {
    damageMechanism = "water_staining";
  }
  if (text.includes("rot") || text.includes("rotted") || text.includes("decay")) {
    damageMechanism = "rot";
    structuralConcern = structuralConcern || assemblyLayer === "framing" || assemblyLayer === "decking";
  }
  if (text.includes("delamin")) {
    damageMechanism = "delamination";
  }
  if (text.includes("sag") || text.includes("bow")) {
    damageMechanism = "sagging";
    structuralConcern = true;
  }
  if (text.includes("active leak") || text.includes("drip")) {
    damageMechanism = "active_leak";
  }

  const visibleAreaOnly = observation.visibleAreaOnly ?? measurementConfidence === "low";
  const provisionalQuantity = observation.provisionalQuantity ?? measurementConfidence === "low";

  return {
    ...observation,
    material,
    assemblyLayer,
    damageMechanism,
    structuralConcern,
    accessRequired,
    measurementConfidence,
    visibleAreaOnly,
    provisionalQuantity
  };
}
