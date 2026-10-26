/**
 * Expected Payment Activity form -> the payment provider's underwriting body
 * (POST /accounts/{id}/underwriting, provider API v2025.07.00). The provider
 * asks where customers are and the estimated monthly ACH volume for payments
 * the organization sends and accepts, each as one of its fixed ranges. Once
 * either volume is $10,000 or more it also asks the extended questions: the
 * average and largest ACH payment on each side (whole dollars, next to the
 * range), where the business operates, pending litigation, and the share of
 * volume by customer type. The server accepts exactly this shape.
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

export const BUSINESS_PRESENCE_OPTIONS = [
  { value: "commercial-office", label: "Commercial office" },
  { value: "home-based", label: "Home-based" },
  { value: "mixed-presence", label: "Mixed (office and remote or online)" },
  { value: "mobile-business", label: "Mobile business" },
  { value: "online-only", label: "Online only" },
  { value: "retail-storefront", label: "Retail storefront" },
] as const;

export const PENDING_LITIGATION_OPTIONS = [
  { value: "none", label: "None" },
  { value: "bankruptcy-or-insolvency", label: "Bankruptcy or insolvency" },
  { value: "consumer-protection-or-class-action", label: "Consumer protection or class action" },
  { value: "data-breach-or-privacy", label: "Data breach or privacy" },
  { value: "employment-or-workplace-disputes", label: "Employment or workplace disputes" },
  { value: "fraud-or-financial-crime", label: "Fraud or financial crime" },
  { value: "government-enforcement-or-investigation", label: "Government enforcement or investigation" },
  { value: "intellectual-property", label: "Intellectual property" },
  { value: "personal-injury-or-medical", label: "Personal injury or medical" },
  { value: "other", label: "Other" },
] as const;

export type GeographicReach = (typeof GEOGRAPHIC_REACH_OPTIONS)[number]["value"];
export type MonthlyVolumeRange = (typeof MONTHLY_VOLUME_OPTIONS)[number]["value"];
export type BusinessPresence = (typeof BUSINESS_PRESENCE_OPTIONS)[number]["value"];
export type PendingLitigation = (typeof PENDING_LITIGATION_OPTIONS)[number]["value"];

export interface UnderwritingAnswers {
  geographicReach: string;
  sendAchMonthlyVolume: string;
  collectAchMonthlyVolume: string;
  sendAchAverageAmount: string;
  sendAchMaximumAmount: string;
  collectAchAverageAmount: string;
  collectAchMaximumAmount: string;
  businessPresence: string;
  pendingLitigation: string;
  businessSharePercent: string;
  consumerSharePercent: string;
  p2pSharePercent: string;
}

export const EMPTY_UNDERWRITING_ANSWERS: UnderwritingAnswers = {
  geographicReach: "",
  sendAchMonthlyVolume: "",
  collectAchMonthlyVolume: "",
  sendAchAverageAmount: "",
  sendAchMaximumAmount: "",
  collectAchAverageAmount: "",
  collectAchMaximumAmount: "",
  businessPresence: "",
  pendingLitigation: "",
  businessSharePercent: "",
  consumerSharePercent: "",
  p2pSharePercent: "",
};

type EstimatedActivity = {
  monthlyVolumeRange: MonthlyVolumeRange;
  averageTransactionAmount?: number;
  maximumTransactionAmount?: number;
};
type AchActivity = { ach: { estimatedActivity: EstimatedActivity } };

export type UnderwritingPayload = {
  geographicReach: GeographicReach;
  sendFunds: AchActivity;
  collectFunds: AchActivity;
  businessPresence?: BusinessPresence;
  pendingLitigation?: PendingLitigation;
  volumeShareByCustomerType?: { business: number; consumer: number; p2p: number };
};

const isReach = (v: string): v is GeographicReach => GEOGRAPHIC_REACH_OPTIONS.some((o) => o.value === v);
const isRange = (v: string): v is MonthlyVolumeRange => MONTHLY_VOLUME_OPTIONS.some((o) => o.value === v);
const isPresence = (v: string): v is BusinessPresence => BUSINESS_PRESENCE_OPTIONS.some((o) => o.value === v);
const isLitigation = (v: string): v is PendingLitigation => PENDING_LITIGATION_OPTIONS.some((o) => o.value === v);

/** True when the provider asks the extended questions (either ACH volume $10,000 or more). */
export const needsExtendedUnderwriting = (a: Pick<UnderwritingAnswers, "sendAchMonthlyVolume" | "collectAchMonthlyVolume">) =>
  [a.sendAchMonthlyVolume, a.collectAchMonthlyVolume].some((v) => isRange(v) && v !== "under-10k");

const blank = (v: string) => String(v ?? "").trim() === "";

/** Whole dollars ("1,250" or "$1250"), or null. Cents are refused: the provider takes whole USD. */
const wholeDollars = (value: string): number | null => {
  const text = String(value ?? "").replace(/[$,\s]/g, "");
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n > 0 && Number.isSafeInteger(n) ? n : null;
};

const percent = (value: string): number | null => {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n <= 100 ? n : null;
};

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
  const required = needsExtendedUnderwriting(answers);

  const side = (
    range: MonthlyVolumeRange,
    averageText: string,
    maximumText: string,
    words: string,
  ): { activity?: AchActivity; message?: string } => {
    const estimatedActivity: EstimatedActivity = { monthlyVolumeRange: range };
    if (required || !blank(averageText) || !blank(maximumText)) {
      const average = wholeDollars(averageText);
      const maximum = wholeDollars(maximumText);
      if (average == null || maximum == null) {
        return { message: `Enter the average and largest ACH payment you ${words} as whole dollar amounts.` };
      }
      if (maximum < average) return { message: `The largest ACH payment you ${words} can't be smaller than the average.` };
      estimatedActivity.averageTransactionAmount = average;
      estimatedActivity.maximumTransactionAmount = maximum;
    }
    return { activity: { ach: { estimatedActivity } } };
  };
  const send = side(answers.sendAchMonthlyVolume, answers.sendAchAverageAmount, answers.sendAchMaximumAmount, "send");
  if (!send.activity) return { ok: false, message: send.message };
  const collect = side(answers.collectAchMonthlyVolume, answers.collectAchAverageAmount, answers.collectAchMaximumAmount, "accept");
  if (!collect.activity) return { ok: false, message: collect.message };

  const payload: UnderwritingPayload = {
    geographicReach: answers.geographicReach,
    sendFunds: send.activity,
    collectFunds: collect.activity,
  };
  if (required || !blank(answers.businessPresence)) {
    if (!isPresence(answers.businessPresence)) return { ok: false, message: "Choose where your business operates." };
    payload.businessPresence = answers.businessPresence;
  }
  if (required || !blank(answers.pendingLitigation)) {
    if (!isLitigation(answers.pendingLitigation)) {
      return { ok: false, message: "Choose whether your business has pending litigation (None if it has none)." };
    }
    payload.pendingLitigation = answers.pendingLitigation;
  }
  const shares = [answers.businessSharePercent, answers.consumerSharePercent, answers.p2pSharePercent];
  if (required || shares.some((s) => !blank(s))) {
    const [business, consumer, p2p] = shares.map((s) => (blank(s) ? 0 : percent(s)));
    if (business == null || consumer == null || p2p == null || business + consumer + p2p !== 100) {
      return { ok: false, message: "Business, consumer and person-to-person shares must be whole percentages that add up to 100." };
    }
    payload.volumeShareByCustomerType = { business, consumer, p2p };
  }
  return { ok: true, payload };
}

/** Form answers from the provider's underwriting read (blank where it has none). */
export function answersFromUnderwriting(u: unknown): UnderwritingAnswers {
  type Activity = { ach?: { estimatedActivity?: { monthlyVolumeRange?: unknown; averageTransactionAmount?: unknown; maximumTransactionAmount?: unknown } } };
  const o = (u ?? {}) as {
    geographicReach?: unknown;
    sendFunds?: Activity;
    collectFunds?: Activity;
    businessPresence?: unknown;
    pendingLitigation?: unknown;
    volumeShareByCustomerType?: { business?: unknown; consumer?: unknown; p2p?: unknown };
  };
  const range = (s: "sendFunds" | "collectFunds") => {
    const v = o[s]?.ach?.estimatedActivity?.monthlyVolumeRange;
    return typeof v === "string" && isRange(v) ? v : "";
  };
  const amount = (s: "sendFunds" | "collectFunds", key: "averageTransactionAmount" | "maximumTransactionAmount") => {
    const v = o[s]?.ach?.estimatedActivity?.[key];
    return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? String(v) : "";
  };
  const share = (key: "business" | "consumer" | "p2p") => {
    const v = o.volumeShareByCustomerType?.[key];
    return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 100 ? String(v) : "";
  };
  return {
    geographicReach: typeof o.geographicReach === "string" && isReach(o.geographicReach) ? o.geographicReach : "",
    sendAchMonthlyVolume: range("sendFunds"),
    collectAchMonthlyVolume: range("collectFunds"),
    sendAchAverageAmount: amount("sendFunds", "averageTransactionAmount"),
    sendAchMaximumAmount: amount("sendFunds", "maximumTransactionAmount"),
    collectAchAverageAmount: amount("collectFunds", "averageTransactionAmount"),
    collectAchMaximumAmount: amount("collectFunds", "maximumTransactionAmount"),
    businessPresence: typeof o.businessPresence === "string" && isPresence(o.businessPresence) ? o.businessPresence : "",
    pendingLitigation: typeof o.pendingLitigation === "string" && isLitigation(o.pendingLitigation) ? o.pendingLitigation : "",
    businessSharePercent: share("business"),
    consumerSharePercent: share("consumer"),
    p2pSharePercent: share("p2p"),
  };
}
