import { ScopeLineItem } from "@/lib/scopeTypes";
import { getUnitPrice } from "@/lib/priceBook";

export function round2(value: number): number {
  return Number(value.toFixed(2));
}

export function makeLineItem(args: {
  code: string;
  description: string;
  quantity: number;
  unit: string;
  reasoning: string;
  sourceObservationIndexes?: number[];
  isCodeRequired?: boolean;
  isDependency?: boolean;
  isManualReviewRequired?: boolean;
}): ScopeLineItem {
  const unitPrice = getUnitPrice(args.code);
  return {
    code: args.code,
    description: args.description,
    quantity: round2(args.quantity),
    unit: args.unit,
    unitPrice,
    total: round2(unitPrice * args.quantity),
    reasoning: args.reasoning,
    sourceObservationIndexes: args.sourceObservationIndexes ?? [],
    isCodeRequired: args.isCodeRequired,
    isDependency: args.isDependency,
    isManualReviewRequired: args.isManualReviewRequired
  };
}

export function mergeDuplicateLineItems(items: ScopeLineItem[]): ScopeLineItem[] {
  const map = new Map<string, ScopeLineItem>();

  for (const item of items) {
    const key = `${item.code}__${item.unit}__${item.description}`;
    const existing = map.get(key);

    if (!existing) {
      map.set(key, { ...item });
      continue;
    }

    existing.quantity = round2(existing.quantity + item.quantity);
    existing.total = round2(existing.total + item.total);
    existing.reasoning = `${existing.reasoning} | ${item.reasoning}`;
    existing.sourceObservationIndexes = Array.from(
      new Set([...existing.sourceObservationIndexes, ...item.sourceObservationIndexes])
    );
    existing.isCodeRequired = existing.isCodeRequired || item.isCodeRequired;
    existing.isDependency = existing.isDependency || item.isDependency;
    existing.isManualReviewRequired =
      existing.isManualReviewRequired || item.isManualReviewRequired;
  }

  return Array.from(map.values());
}
