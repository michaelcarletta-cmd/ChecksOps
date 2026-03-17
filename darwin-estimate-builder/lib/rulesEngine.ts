import { DamageObservation, EstimateLineItem } from "@/types";
import { buildFullScope } from "@/lib/scopeEngine";
import { ScopeContext } from "@/lib/xactimateMap";

export function buildEstimateItems(
  observations: DamageObservation[],
  context?: ScopeContext
): EstimateLineItem[] {
  const result = buildFullScope({ observations, context });

  return result.lineItems.map((item) => ({
    code: item.code,
    description: item.description,
    quantity: item.quantity,
    unit: item.unit,
    unitPrice: item.unitPrice,
    total: item.total,
    reasoning: item.reasoning
  }));
}
