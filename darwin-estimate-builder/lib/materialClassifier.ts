import { DamageObservation } from "@/types";

export function normalizeObservationMaterial(
  observation: DamageObservation
): DamageObservation {
  const text =
    `${observation.component} ${observation.material} ${observation.damageType}`.toLowerCase();

  let material = observation.material;

  if (
    text.includes("architectural") ||
    text.includes("laminated") ||
    text.includes("comp shingle") ||
    text.includes("asphalt")
  ) {
    material = "architectural shingle";
  } else if (text.includes("vinyl")) {
    material = "vinyl siding";
  } else if (text.includes("hardie") || text.includes("fiber cement")) {
    material = "fiber cement siding";
  } else if (text.includes("drywall") || text.includes("sheetrock")) {
    material = "drywall";
  } else if (text.includes("gutter")) {
    material = "gutter";
  } else if (text.includes("window")) {
    material = "window unit";
  }

  return {
    ...observation,
    material
  };
}
