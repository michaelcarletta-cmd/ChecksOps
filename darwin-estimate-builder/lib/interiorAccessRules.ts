import { DamageObservation } from "@/types";
import { ScopeLineItem } from "@/lib/scopeTypes";
import { makeLineItem } from "@/lib/scopeUtils";

export function addInteriorAccessItems(args: {
  observation: DamageObservation;
  baseQuantitySf: number;
  observationIndex: number;
}): ScopeLineItem[] {
  const { observation, baseQuantitySf, observationIndex } = args;
  const items: ScopeLineItem[] = [];

  const text = `${observation.component} ${observation.rationale} ${observation.damageType}`.toLowerCase();
  const attached = (observation.attachedItems ?? []).map((x) => x.toLowerCase());
  const roomType = (observation.roomType ?? "").toLowerCase();
  const surface = (observation.surfaceOrientation ?? "").toLowerCase();

  // Wall drywall replacement → baseboard detach/reset
  if (surface === "wall" || text.includes("wall")) {
    items.push(
      makeLineItem({
        code: "DRBASEDET",
        description: "Detach and reset baseboard trim",
        quantity: estimateBaseboardLf(baseQuantitySf),
        unit: "LF",
        reasoning: "Baseboard detach/reset added because wall drywall replacement typically requires trim removal at floor line.",
        sourceObservationIndexes: [observationIndex],
        isDependency: true,
        isProvisionalQuantity: true
      })
    );
  }

  // Closet → shelving & rod detach/reset
  if (roomType === "closet" || text.includes("closet") || attached.includes("shelving")) {
    items.push(
      makeLineItem({
        code: "DRSHELFDET",
        description: "Detach and reset closet shelving",
        quantity: Math.max(4, estimateBaseboardLf(baseQuantitySf) / 2),
        unit: "LF",
        reasoning: "Closet shelving detach/reset added because drywall access is likely obstructed by installed shelves.",
        sourceObservationIndexes: [observationIndex],
        isDependency: true,
        isProvisionalQuantity: true
      })
    );

    items.push(
      makeLineItem({
        code: "DRRODDET",
        description: "Detach and reset closet rod/hardware",
        quantity: 1,
        unit: "EA",
        reasoning: "Closet rod/hardware detach/reset added as likely access dependency.",
        sourceObservationIndexes: [observationIndex],
        isDependency: true,
        isProvisionalQuantity: true
      })
    );
  }

  // Ceiling work → light fixture detach/reset
  if (surface === "ceiling" || text.includes("ceiling")) {
    items.push(
      makeLineItem({
        code: "DRLIGHTDET",
        description: "Detach and reset light fixture",
        quantity: 1,
        unit: "EA",
        reasoning: "Ceiling work may require fixture detach/reset in affected area.",
        sourceObservationIndexes: [observationIndex],
        isDependency: true,
        isProvisionalQuantity: true
      })
    );
  }

  // Floor protection (always for interior demo/replacement)
  items.push(
    makeLineItem({
      code: "FLOORPROT",
      description: "Floor and contents protection",
      quantity: Math.max(baseQuantitySf, 16),
      unit: "SF",
      reasoning: "Protection added because drywall demolition/replacement creates dust and debris in occupied interior space.",
      sourceObservationIndexes: [observationIndex],
      isDependency: true,
      isProvisionalQuantity: true
    })
  );

  // Debris removal (always for interior demo/replacement)
  items.push(
    makeLineItem({
      code: "DEBRIS",
      description: "Debris removal",
      quantity: Math.max(baseQuantitySf, 16),
      unit: "SF",
      reasoning: "Debris removal added due to drywall demolition and disposal needs.",
      sourceObservationIndexes: [observationIndex],
      isDependency: true,
      isProvisionalQuantity: true
    })
  );

  return items;
}

function estimateBaseboardLf(areaSf: number): number {
  if (!areaSf) return 8;
  return Math.max(8, Math.sqrt(areaSf) * 2);
}
