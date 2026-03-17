import { DamageObservation } from "@/types";
import { ScopeContext, findBestTemplate } from "@/lib/xactimateMap";
import { ScopeLineItem, ScopeWarning } from "@/lib/scopeTypes";
import { makeLineItem } from "@/lib/scopeUtils";
import { addInteriorAccessItems } from "@/lib/interiorAccessRules";

export function buildBaseScopeFromObservations(args: {
  observations: DamageObservation[];
  context: ScopeContext;
}): { items: ScopeLineItem[]; warnings: ScopeWarning[] } {
  const items: ScopeLineItem[] = [];
  const warnings: ScopeWarning[] = [];

  args.observations.forEach((obs, index) => {
    if (obs.confidence < 0.45) {
      warnings.push({
        type: "low_confidence",
        message: `Low-confidence observation for ${obs.component}. Review before relying on automated scope.`,
        observationIndex: index
      });
    }

    if (obs.measurementConfidence === "low" || obs.provisionalQuantity) {
      warnings.push({
        type: "manual_measurement_required",
        message: `Manual measurement required for ${obs.component}; visible area does not provide reliable final quantity.`,
        observationIndex: index
      });
    }

    if (obs.structuralConcern) {
      warnings.push({
        type: "structural_review_recommended",
        message: `Structural concern flagged for ${obs.component}; framing/decking review recommended.`,
        observationIndex: index
      });
    }

    if (
      obs.accessRequired &&
      (obs.category === "roof" ||
        obs.assemblyLayer === "decking" ||
        obs.assemblyLayer === "framing")
    ) {
      warnings.push({
        type: "access_scope_required",
        message: `Roof/substrate access scope likely required for ${obs.component} before full repair quantity can be confirmed.`,
        observationIndex: index
      });
    }

    const template = findBestTemplate(obs);

    if (!template) {
      warnings.push({
        type: "no_match",
        message: `No Xactimate mapping found for ${obs.category} / ${obs.material} / ${obs.damageType}.`,
        observationIndex: index
      });
      return;
    }

    const quantity = deriveQuantity(obs, template.defaultUnit, args.context);

    items.push(
      makeLineItem({
        code: template.code,
        description: template.description,
        quantity,
        unit: template.defaultUnit,
        reasoning: `${obs.component}: ${obs.damageType}; material ${obs.material}; layer ${obs.assemblyLayer ?? "unknown"}; basis ${obs.quantityBasis}`,
        sourceObservationIndexes: [index],
        isManualReviewRequired: obs.confidence < 0.6 || !!obs.structuralConcern,
        isProvisionalQuantity: !!obs.provisionalQuantity
      })
    );

    if (obs.category === "interior") {
      const hasDrywallItem = items.some(
        (i) => i.code === "DRYWALL" || i.code === "DRYWALLREPL"
      );

      if (!hasDrywallItem) {
        const drywallReplace =
          obs.repairability === "replace" ||
          obs.damageMechanism === "rot" ||
          obs.damageMechanism === "active_leak";

        items.push(
          makeLineItem({
            code: drywallReplace ? "DRYWALLREPL" : "DRYWALL",
            description: drywallReplace
              ? "Remove and replace drywall"
              : "Repair drywall",
            quantity: Math.max(quantity, 1),
            unit: "SF",
            reasoning: `${drywallReplace ? "Replacement" : "Repair"} selected for interior finish damage at ${obs.component}.`,
            sourceObservationIndexes: [index],
            isManualReviewRequired: obs.confidence < 0.6,
            isProvisionalQuantity: !!obs.provisionalQuantity
          })
        );
      }

      items.push(
        makeLineItem({
          code: "PAINT",
          description: "Seal and paint affected area",
          quantity: Math.max(quantity, 1),
          unit: "SF",
          reasoning: `Paint added after interior finish work at ${obs.component}.`,
          sourceObservationIndexes: [index],
          isDependency: true,
          isProvisionalQuantity: !!obs.provisionalQuantity
        })
      );

      // Interior access items (baseboard, shelving, fixtures, floor protection, debris)
      const accessItems = addInteriorAccessItems({
        observation: obs,
        baseQuantitySf: Math.max(quantity, 1),
        observationIndex: index
      });
      items.push(...accessItems);
    }

    if (
      obs.category === "interior" &&
      (obs.assemblyLayer === "insulation" ||
        /insulation|wet insulation|ceiling leak|water damage/i.test(
          `${obs.damageType} ${obs.rationale}`
        ))
    ) {
      items.push(
        makeLineItem({
          code: "INSUL",
          description: "Replace insulation",
          quantity: Math.max(quantity, 1),
          unit: "SF",
          reasoning: `Insulation replacement added due to probable wet/damaged insulation at ${obs.component}.`,
          sourceObservationIndexes: [index],
          isDependency: true,
          isProvisionalQuantity: !!obs.provisionalQuantity
        })
      );
    }

    if (
      obs.category === "roof" &&
      obs.accessRequired &&
      (obs.assemblyLayer === "decking" || obs.assemblyLayer === "framing")
    ) {
      items.push(
        makeLineItem({
          code: "RFGDETACHRESET",
          description: "Detach and reset roofing to access substrate",
          quantity: deriveAccessQuantity(obs, args.context),
          unit: "SF",
          reasoning: `Access scope added to reach ${obs.assemblyLayer} at ${obs.component}.`,
          sourceObservationIndexes: [index],
          isDependency: true,
          isProvisionalQuantity: true
        })
      );
    }

    if (
      obs.category === "roof" &&
      obs.structuralConcern &&
      !items.some((i) => i.code === "MOISTMAP")
    ) {
      items.push(
        makeLineItem({
          code: "MOISTMAP",
          description: "Moisture mapping / investigative moisture readings",
          quantity: 1,
          unit: "EA",
          reasoning: `Investigation item added due to structural/water-damage concerns at ${obs.component}.`,
          sourceObservationIndexes: [index],
          isDependency: true
        })
      );
    }

    if (
      obs.category === "siding" &&
      obs.repairability === "replace" &&
      !items.some((i) => i.code === "SIDDROP")
    ) {
      items.push(
        makeLineItem({
          code: "SIDDROP",
          description: "Remove and reset house wrap / weather barrier",
          quantity: Math.max(quantity, 1),
          unit: "SF",
          reasoning: `Weather barrier reset added as siding replacement dependency for ${obs.component}.`,
          sourceObservationIndexes: [index],
          isDependency: true,
          isProvisionalQuantity: !!obs.provisionalQuantity
        })
      );
    }
  });

  return { items, warnings };
}

function deriveQuantity(
  obs: DamageObservation,
  defaultUnit: string,
  context: ScopeContext
): number {
  const q = obs.recommendedQuantity || 1;
  const wasteFactor = context.wasteFactor ?? 0.1;

  if (obs.measurementConfidence === "low") {
    if (defaultUnit === "SQ") return Math.max(0.25, q * (1 + wasteFactor));
    if (defaultUnit === "SF") return Math.max(16, q);
    if (defaultUnit === "LF") return Math.max(8, q);
    return Math.max(1, q);
  }

  if (defaultUnit === "SQ") {
    if (obs.unit === "SQ") return q * (1 + wasteFactor);
    if (obs.unit === "SF") return (q / 100) * (1 + wasteFactor);
    return Math.max(1, q);
  }

  if (defaultUnit === "SF") {
    if (obs.unit === "SQ") return q * 100;
    return Math.max(1, q);
  }

  return Math.max(1, q);
}

function deriveAccessQuantity(obs: DamageObservation, context: ScopeContext): number {
  const q = obs.recommendedQuantity || 1;

  if (obs.unit === "SQ") return q * 100;
  if (obs.unit === "SF") return Math.max(q, 16);
  if (obs.measurementConfidence === "low") return Math.max(32, q);

  return Math.max(q, 16);
}
