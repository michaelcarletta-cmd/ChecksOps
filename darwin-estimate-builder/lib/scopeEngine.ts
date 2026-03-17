import { DamageObservation } from "@/types";
import { normalizeObservationMaterial } from "@/lib/materialClassifier";
import { ScopeContext } from "@/lib/xactimateMap";
import { buildBaseScopeFromObservations } from "@/lib/dependencyRules";
import { applyCodeAndMatchingRules } from "@/lib/codeRules";
import { ScopeBuildResult } from "@/lib/scopeTypes";
import { mergeDuplicateLineItems, round2 } from "@/lib/scopeUtils";

export function buildFullScope(args: {
  observations: DamageObservation[];
  context?: ScopeContext;
}): ScopeBuildResult {
  const context: ScopeContext = {
    state: args.context?.state ?? "NJ",
    wasteFactor: args.context?.wasteFactor ?? 0.1,
    ...args.context
  };

  const observations = args.observations.map(normalizeObservationMaterial);

  const roofSquares = sumByCategoryUnit(observations, "roof", "SQ");
  const roofApproxSf =
    roofSquares > 0 ? roofSquares * 100 : sumByCategoryUnit(observations, "roof", "SF");
  const roofPerimeterLf = estimateRoofPerimeterLf(roofApproxSf);
  const ridgeLf = estimateRidgeLf(roofApproxSf);

  const sidingSf = sumByCategoryUnit(observations, "siding", "SF");
  const interiorSf = sumByCategoryUnit(observations, "interior", "SF");
  const gutterLf = sumByCategoryUnit(observations, "gutter", "LF");
  const windowCount = observations.filter((o) => o.category === "window").length;

  const base = buildBaseScopeFromObservations({ observations, context });

  const coded = applyCodeAndMatchingRules({
    items: base.items,
    context,
    roofSquares: roofSquares || round2(roofApproxSf / 100),
    roofPerimeterLf,
    ridgeLf,
    warnings: base.warnings
  });

  const lineItems = mergeDuplicateLineItems(coded.items).sort((a, b) =>
    a.code.localeCompare(b.code)
  );

  const grossTotal = round2(lineItems.reduce((sum, item) => sum + item.total, 0));

  const assumptions = [
    "Xactimate-style line item codes are internal placeholders and should be mapped to your exact approved price list/code set.",
    "Quantities derived from photos are provisional until field measurements or roof reports confirm dimensions.",
    ...coded.assumptions
  ];

  const summary = buildSummary({
    observationsCount: observations.length,
    lineItemsCount: lineItems.length,
    grossTotal,
    roofSquares: roofSquares || round2(roofApproxSf / 100),
    sidingSf,
    interiorSf,
    gutterLf,
    windowCount
  });

  return {
    summary,
    observations,
    lineItems,
    warnings: coded.warnings,
    assumptions,
    metrics: {
      roofSquares: roofSquares || round2(roofApproxSf / 100),
      sidingSf,
      interiorSf,
      gutterLf,
      windowCount,
      grossTotal
    },
    contextUsed: context
  };
}

function sumByCategoryUnit(
  observations: DamageObservation[],
  category: DamageObservation["category"],
  unit: string
): number {
  return round2(
    observations
      .filter((o) => o.category === category && o.unit === unit)
      .reduce((sum, o) => sum + (o.recommendedQuantity || 0), 0)
  );
}

function estimateRoofPerimeterLf(roofSf: number): number {
  if (!roofSf) return 0;
  const side = Math.sqrt(roofSf);
  return round2(side * 4);
}

function estimateRidgeLf(roofSf: number): number {
  if (!roofSf) return 0;
  return round2(Math.sqrt(roofSf));
}

function buildSummary(args: {
  observationsCount: number;
  lineItemsCount: number;
  grossTotal: number;
  roofSquares: number;
  sidingSf: number;
  interiorSf: number;
  gutterLf: number;
  windowCount: number;
}): string {
  const parts = [
    `${args.observationsCount} observations analyzed`,
    `${args.lineItemsCount} scope items generated`,
    `gross total $${args.grossTotal.toFixed(2)}`
  ];

  if (args.roofSquares > 0) parts.push(`roof scope ${args.roofSquares} SQ`);
  if (args.sidingSf > 0) parts.push(`siding ${args.sidingSf} SF`);
  if (args.interiorSf > 0) parts.push(`interior ${args.interiorSf} SF`);
  if (args.gutterLf > 0) parts.push(`gutters ${args.gutterLf} LF`);
  if (args.windowCount > 0) parts.push(`windows ${args.windowCount} EA`);

  return parts.join(" | ");
}
