import { DamageObservation } from "@/types";
import { ScopeContext, findBestTemplate } from "@/lib/xactimateMap";
import { ScopeLineItem, ScopeWarning } from "@/lib/scopeTypes";
import { makeLineItem } from "@/lib/scopeUtils";

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
        reasoning: `${obs.component}: ${obs.damageType}; material ${obs.material}; severity ${obs.severity}; basis ${obs.quantityBasis}`,
        sourceObservationIndexes: [index],
        isManualReviewRequired: obs.confidence < 0.6
      })
    );

    if (obs.category === "interior") {
      items.push(
        makeLineItem({
          code: "PAINT",
          description: "Seal and paint affected area",
          quantity: Math.max(quantity, 1),
          unit: "SF",
          reasoning: `Paint added as dependency after interior wall/ceiling repair for ${obs.component}.`,
          sourceObservationIndexes: [index],
          isDependency: true
        })
      );
    }

    if (
      obs.category === "interior" &&
      /insulation|wet insulation|ceiling leak|water damage/i.test(
        `${obs.damageType} ${obs.rationale}`
      )
    ) {
      items.push(
        makeLineItem({
          code: "INSUL",
          description: "Replace insulation",
          quantity: Math.max(quantity, 1),
          unit: "SF",
          reasoning: `Insulation replacement added due to probable wet/damaged cavity insulation at ${obs.component}.`,
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
          isDependency: true
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
