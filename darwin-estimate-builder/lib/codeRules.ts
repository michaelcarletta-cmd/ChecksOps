import { ScopeContext } from "@/lib/xactimateMap";
import { ScopeLineItem, ScopeWarning } from "@/lib/scopeTypes";
import { makeLineItem } from "@/lib/scopeUtils";

export function applyCodeAndMatchingRules(args: {
  items: ScopeLineItem[];
  context: ScopeContext;
  roofSquares: number;
  roofPerimeterLf: number;
  ridgeLf: number;
  warnings: ScopeWarning[];
}): { items: ScopeLineItem[]; warnings: ScopeWarning[]; assumptions: string[] } {
  const { context, roofSquares, roofPerimeterLf, ridgeLf } = args;
  const items = [...args.items];
  const warnings = [...args.warnings];
  const assumptions: string[] = [];

  const hasFullRoofReplacement = items.some((i) => i.code === "RFG240");

  if (hasFullRoofReplacement) {
    if (!items.some((i) => i.code === "RFGST")) {
      items.push(
        makeLineItem({
          code: "RFGST",
          description: "Starter course - composition shingles",
          quantity: roofPerimeterLf,
          unit: "LF",
          reasoning: "Added as roof-system dependency for full shingle replacement.",
          isDependency: true
        })
      );
    }

    if (!items.some((i) => i.code === "RFG300")) {
      items.push(
        makeLineItem({
          code: "RFG300",
          description: "Ridge cap - composition shingles",
          quantity: ridgeLf,
          unit: "LF",
          reasoning: "Added as roof-system dependency for full shingle replacement.",
          isDependency: true
        })
      );
    }

    if (!items.some((i) => i.code === "RFGFELTSYN")) {
      items.push(
        makeLineItem({
          code: "RFGFELTSYN",
          description: "Synthetic felt underlayment",
          quantity: roofSquares,
          unit: "SQ",
          reasoning: "Added as underlayment for roof replacement scope.",
          isDependency: true
        })
      );
    }

    if (!context.dripEdgePresent && !items.some((i) => i.code === "RFGDRIP")) {
      items.push(
        makeLineItem({
          code: "RFGDRIP",
          description: "Drip edge",
          quantity: roofPerimeterLf,
          unit: "LF",
          reasoning: "Added because drip edge not confirmed present.",
          isCodeRequired: true
        })
      );
      warnings.push({
        type: "code_upgrade",
        message: "Drip edge added as likely code-required item for roof replacement."
      });
    }

    if (
      (context.state === "NJ" || context.state === "PA") &&
      !context.iceBarrierPresent &&
      !items.some((i) => i.code === "RFGICE")
    ) {
      items.push(
        makeLineItem({
          code: "RFGICE",
          description: "Ice and water barrier",
          quantity: Math.max(roofPerimeterLf * 2, roofSquares * 100 * 0.35),
          unit: "SF",
          reasoning: "Added as likely code-required cold-climate eave protection item.",
          isCodeRequired: true
        })
      );
      warnings.push({
        type: "code_upgrade",
        message: "Ice and water barrier added for probable NJ/PA code compliance."
      });
    }

    if (context.ridgeVentPresent && !items.some((i) => i.code === "RFGVENT")) {
      items.push(
        makeLineItem({
          code: "RFGVENT",
          description: "Ridge vent",
          quantity: ridgeLf,
          unit: "LF",
          reasoning:
            "Added because ridge vent is present and roof replacement should include replacement/reset.",
          isDependency: true
        })
      );
    }
  }

  if (context.repairPercent && context.repairPercent >= 25 && !hasFullRoofReplacement) {
    warnings.push({
      type: "code_upgrade",
      message:
        "Repair area is at or above 25%; verify whether full replacement is required by applicable code or ordinance."
    });
  }

  if (context.discontinuedMaterial || context.matchingRequired) {
    warnings.push({
      type: "matching_issue",
      message:
        "Discontinued or matching-sensitive material flagged. Verify full elevation/slope replacement requirements."
    });
    assumptions.push(
      "Matching/discontinued-material issue may require broader replacement than visible direct damage."
    );
  }

  if (context.brittleTestFailed) {
    warnings.push({
      type: "manual_review",
      message:
        "Brittle test failed. Repairability should be escalated toward replacement review."
    });
    assumptions.push(
      "Brittleness may make spot repair infeasible and justify replacement scope."
    );
  }

  return { items, warnings, assumptions };
}
