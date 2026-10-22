/**
 * Expected Payment Activity form -> the payment provider's underwriting body
 * (PUT /accounts/{id}/underwriting). The provider rejects the flat form
 * state (dollar strings, top-level percentages and fulfillment fields), so
 * amounts go in as whole cents and the percentages and fulfillment answers
 * are nested the way the provider returns them (the form already reads
 * volumeByCustomerType and fulfillment back in that shape).
 */

export interface UnderwritingAnswers {
  averageTransactionSize: string;
  maxTransactionSize: string;
  averageMonthlyTransactionVolume: string;
  businessToBusinessPercentage: string;
  consumerToBusinessPercentage: string;
  hasPhysicalGoods: boolean;
  isShippingProduct: boolean;
  shipmentDurationDays: string;
  returnPolicy: string;
}

export type UnderwritingPayload = {
  averageTransactionSize: number;
  maxTransactionSize: number;
  averageMonthlyTransactionVolume: number;
  volumeByCustomerType: { businessToBusinessPercentage: number; consumerToBusinessPercentage: number };
  fulfillment: {
    hasPhysicalGoods: boolean;
    isShippingProduct: boolean;
    shipmentDurationDays: number;
    returnPolicy: string;
  };
};

const dollarsToCents = (value: string): number | null => {
  const text = String(value ?? "").replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  return Math.round(Number(text) * 100);
};

const wholeNumber = (value: string): number | null => {
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) ? Number(text) : null;
};

/** The provider body, or the plain-words problem with the answers. */
export function buildUnderwritingPayload(
  answers: UnderwritingAnswers,
): { ok: boolean; payload?: UnderwritingPayload; message?: string } {
  const average = dollarsToCents(answers.averageTransactionSize);
  const max = dollarsToCents(answers.maxTransactionSize);
  const monthly = dollarsToCents(answers.averageMonthlyTransactionVolume);
  if (average == null || max == null || monthly == null) {
    return { ok: false, message: "Enter the average payment, largest payment and monthly volume as dollar amounts." };
  }
  if (max < average) {
    return { ok: false, message: "The largest payment can't be smaller than the average payment." };
  }
  const b2b = wholeNumber(answers.businessToBusinessPercentage);
  const c2b = wholeNumber(answers.consumerToBusinessPercentage);
  if (b2b == null || c2b == null || b2b + c2b !== 100) {
    return { ok: false, message: "Business and consumer percentages must be whole numbers that add up to 100." };
  }
  const days = wholeNumber(answers.shipmentDurationDays);
  if (days == null) return { ok: false, message: "Shipping days must be a whole number (0 if you don't ship)." };
  return {
    ok: true,
    payload: {
      averageTransactionSize: average,
      maxTransactionSize: max,
      averageMonthlyTransactionVolume: monthly,
      volumeByCustomerType: { businessToBusinessPercentage: b2b, consumerToBusinessPercentage: c2b },
      fulfillment: {
        hasPhysicalGoods: Boolean(answers.hasPhysicalGoods),
        isShippingProduct: Boolean(answers.isShippingProduct),
        shipmentDurationDays: days,
        returnPolicy: answers.returnPolicy || "none",
      },
    },
  };
}
