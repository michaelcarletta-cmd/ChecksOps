/**
 * Expected Payment Activity form -> the payment provider's underwriting body
 * (POST /accounts/{id}/underwriting, provider API v2025.07.00). The provider
 * asks where customers are and the estimated monthly ACH volume for payments
 * the organization sends and accepts, each as one of its fixed ranges; the
 * server accepts exactly this shape.
 */

export const GEOGRAPHIC_REACH_OPTIONS = [
  { value: "us-only", label: "United States only" },
  { value: "us-and-international", label: "United States and other countries" },
  { value: "international-only", label: "Outside the United States only" },
] as const;

export const MONTHLY_VOLUME_OPTIONS = [
  { value: "under-10k", label: "Under $10,000" },
  { value: "10k-50k", label: "$10,000 – $50,000" },
  { value: "50k-100k", label: "$50,000 – $100,000" },
  { value: "100k-250k", label: "$100,000 – $250,000" },
  { value: "250k-500k", label: "$250,000 – $500,000" },
  { value: "500k-1m", label: "$500,000 – $1 million" },
  { value: "1m-5m", label: "$1 million – $5 million" },
  { value: "over-5m", label: "Over $5 million" },
] as const;

export type GeographicReach = (typeof GEOGRAPHIC_REACH_OPTIONS)[number]["value"];
export type MonthlyVolumeRange = (typeof MONTHLY_VOLUME_OPTIONS)[number]["value"];

export interface UnderwritingAnswers {
  geographicReach: string;
  sendAchMonthlyVolume: string;
  collectAchMonthlyVolume: string;
}

type AchActivity = { ach: { estimatedActivity: { monthlyVolumeRange: MonthlyVolumeRange } } };

export type UnderwritingPayload = {
  geographicReach: GeographicReach;
  sendFunds: AchActivity;
  collectFunds: AchActivity;
};

const isReach = (v: string): v is GeographicReach => GEOGRAPHIC_REACH_OPTIONS.some((o) => o.value === v);
const isRange = (v: string): v is MonthlyVolumeRange => MONTHLY_VOLUME_OPTIONS.some((o) => o.value === v);
const ach = (monthlyVolumeRange: MonthlyVolumeRange): AchActivity => ({ ach: { estimatedActivity: { monthlyVolumeRange } } });

/** The provider body, or the plain-words problem with the answers. */
export function buildUnderwritingPayload(
  answers: UnderwritingAnswers,
): { ok: boolean; payload?: UnderwritingPayload; message?: string } {
  if (!isReach(answers.geographicReach)) return { ok: false, message: "Choose where your customers are located." };
  if (!isRange(answers.sendAchMonthlyVolume)) {
    return { ok: false, message: "Choose your estimated monthly volume for ACH payments you send." };
  }
  if (!isRange(answers.collectAchMonthlyVolume)) {
    return { ok: false, message: "Choose your estimated monthly volume for ACH payments you accept." };
  }
  return {
    ok: true,
    payload: {
      geographicReach: answers.geographicReach,
      sendFunds: ach(answers.sendAchMonthlyVolume),
      collectFunds: ach(answers.collectAchMonthlyVolume),
    },
  };
}

/** Form answers from the provider's underwriting read (blank where it has none). */
export function answersFromUnderwriting(u: unknown): UnderwritingAnswers {
  type Activity = { ach?: { estimatedActivity?: { monthlyVolumeRange?: unknown } } };
  const o = (u ?? {}) as { geographicReach?: unknown; sendFunds?: Activity; collectFunds?: Activity };
  const range = (side: "sendFunds" | "collectFunds") => {
    const v = o[side]?.ach?.estimatedActivity?.monthlyVolumeRange;
    return typeof v === "string" && isRange(v) ? v : "";
  };
  return {
    geographicReach: typeof o.geographicReach === "string" && isReach(o.geographicReach) ? o.geographicReach : "",
    sendAchMonthlyVolume: range("sendFunds"),
    collectAchMonthlyVolume: range("collectFunds"),
  };
}
