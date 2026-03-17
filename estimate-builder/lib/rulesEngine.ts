import { DamageObservation, EstimateLineItem } from "@/types";

const PRICE_BOOK: Record<string, { unitPrice: number; description: string }> = {
  ROOF_SHINGLE_REPAIR: {
    unitPrice: 425,
    description: "Repair laminated/asphalt shingle roofing"
  },
  ROOF_SHINGLE_REPLACE: {
    unitPrice: 525,
    description: "Remove and replace laminated/asphalt shingle roofing"
  },
  SIDING_REPAIR: {
    unitPrice: 38,
    description: "Repair siding"
  },
  SIDING_REPLACE: {
    unitPrice: 74,
    description: "Replace siding"
  },
  INTERIOR_DRYWALL_REPAIR: {
    unitPrice: 3.8,
    description: "Repair drywall"
  },
  INTERIOR_PAINT: {
    unitPrice: 1.95,
    description: "Paint affected area"
  },
  WINDOW_REPLACE: {
    unitPrice: 850,
    description: "Replace window unit"
  },
  GUTTER_REPLACE: {
    unitPrice: 18,
    description: "Replace gutter"
  },
  FENCE_REPAIR: {
    unitPrice: 42,
    description: "Repair fence"
  }
};

function makeItem(
  code: string,
  quantity: number,
  unit: string,
  reasoning: string
): EstimateLineItem {
  const rule = PRICE_BOOK[code];
  const unitPrice = rule?.unitPrice ?? 0;
  return {
    code,
    description: rule?.description ?? code,
    quantity,
    unit,
    unitPrice,
    total: Number((quantity * unitPrice).toFixed(2)),
    reasoning
  };
}

export function buildEstimateItems(
  observations: DamageObservation[]
): EstimateLineItem[] {
  const items: EstimateLineItem[] = [];

  for (const obs of observations) {
    const reason = `${obs.component}: ${obs.damageType}; severity ${obs.severity}; AI confidence ${obs.confidence}`;

    if (obs.category === "roof") {
      if (obs.repairability === "replace") {
        items.push(
          makeItem(
            "ROOF_SHINGLE_REPLACE",
            obs.recommendedQuantity || 1,
            obs.unit || "SQ",
            reason
          )
        );
      } else {
        items.push(
          makeItem(
            "ROOF_SHINGLE_REPAIR",
            obs.recommendedQuantity || 1,
            obs.unit || "EA",
            reason
          )
        );
      }
    }

    if (obs.category === "siding") {
      items.push(
        makeItem(
          obs.repairability === "replace" ? "SIDING_REPLACE" : "SIDING_REPAIR",
          obs.recommendedQuantity || 1,
          obs.unit || "SF",
          reason
        )
      );
    }

    if (obs.category === "interior") {
      items.push(
        makeItem(
          "INTERIOR_DRYWALL_REPAIR",
          obs.recommendedQuantity || 1,
          obs.unit || "SF",
          reason
        )
      );
      items.push(
        makeItem(
          "INTERIOR_PAINT",
          obs.recommendedQuantity || 1,
          obs.unit || "SF",
          `Paint required after drywall repair. ${reason}`
        )
      );
    }

    if (obs.category === "window" && obs.repairability === "replace") {
      items.push(
        makeItem(
          "WINDOW_REPLACE",
          obs.recommendedQuantity || 1,
          obs.unit || "EA",
          reason
        )
      );
    }

    if (obs.category === "gutter") {
      items.push(
        makeItem(
          "GUTTER_REPLACE",
          obs.recommendedQuantity || 1,
          obs.unit || "LF",
          reason
        )
      );
    }

    if (obs.category === "fence") {
      items.push(
        makeItem(
          "FENCE_REPAIR",
          obs.recommendedQuantity || 1,
          obs.unit || "LF",
          reason
        )
      );
    }
  }

  return items;
}
