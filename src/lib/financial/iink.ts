/**
 * ChecksOps vs iink comparison engine.
 *
 * EXTERNALLY SOURCED PRICING — iink.com/pricing, captured 2026-08-21.
 * Everything in IINK_TIERS below comes straight off iink's public pricing page
 * and its published feature-comparison grid. It is intentionally isolated in
 * this one table so it can be re-checked and updated in a single place.
 *
 * ChecksOps pricing defaults are the rates the product already bills today
 * (tenants.monthly_rate_cents, tenants.per_check_rate_cents, disbursement
 * pass-through, MortgageOps handling, $7,500 one-time setup).
 */

export const IINK_PRICING_SOURCE = "iink.com/pricing";
export const IINK_PRICING_CAPTURED = "August 21, 2026";

export type IinkTierKey = "basic" | "essential" | "plus" | "premium";

export interface IinkTier {
  key: IinkTierKey;
  label: string;
  /** Published monthly subscription price (monthly term). */
  monthlyFee: number;
  /** Check submissions included in the subscription each month. */
  includedChecks: number;
  /** Price of each additional check submission beyond the allowance. */
  overageFee: number;
  /** Fee on checks with a mortgage-company payee, % of the check amount. */
  mortgageFeePct: number;
  /** Cap on that mortgage fee, per check submission. */
  mortgageFeeCap: number;
  /** Charge for each additional mortgage company beyond the first (2+). */
  additionalMortgageCompanyFee: number;
  /** Instant RTP bank transfer rate, % of the amount transferred. */
  rtpPct: number;
  /** Per-check remote deposit limit. */
  depositLimit: number;
  /** Annual underwriting fee (billed yearly). */
  annualUnderwritingFee: number;
  /** Business locations included. */
  locations: string;
  /** Early access to check proceeds, if offered. */
  earlyAccess: string;
}

/** iink published tiers — monthly term. Source: iink.com/pricing (2026-08-21). */
export const IINK_TIERS: IinkTier[] = [
  {
    key: "basic",
    label: "Basic",
    monthlyFee: 45,
    includedChecks: 2,
    overageFee: 22.5,
    mortgageFeePct: 1,
    mortgageFeeCap: 329,
    additionalMortgageCompanyFee: 15,
    rtpPct: 3,
    depositLimit: 100_000,
    annualUnderwritingFee: 299,
    locations: "1",
    earlyAccess: "—",
  },
  {
    key: "essential",
    label: "Essential",
    monthlyFee: 96,
    includedChecks: 8,
    overageFee: 12,
    mortgageFeePct: 1,
    mortgageFeeCap: 329,
    additionalMortgageCompanyFee: 15,
    rtpPct: 2,
    depositLimit: 500_000,
    annualUnderwritingFee: 0,
    locations: "1",
    earlyAccess: "2 days early, $60k cap",
  },
  {
    key: "plus",
    label: "Plus",
    monthlyFee: 225,
    includedChecks: 25,
    overageFee: 9,
    mortgageFeePct: 1,
    mortgageFeeCap: 299,
    additionalMortgageCompanyFee: 15,
    rtpPct: 2,
    depositLimit: 750_000,
    annualUnderwritingFee: 0,
    locations: "2",
    earlyAccess: "2 days early, $60k cap",
  },
  {
    key: "premium",
    label: "Premium",
    monthlyFee: 375,
    includedChecks: 50,
    overageFee: 7.5,
    mortgageFeePct: 1,
    mortgageFeeCap: 299,
    additionalMortgageCompanyFee: 15,
    rtpPct: 2,
    depositLimit: 1_000_000,
    annualUnderwritingFee: 0,
    locations: "Unlimited",
    earlyAccess: "2 days early, $60k cap",
  },
];

/** Annual term: 10% off the subscription, 12-month commitment (both terms commit 12 months). */
export const IINK_ANNUAL_DISCOUNT_PCT = 10;
export const IINK_COMMITMENT_NOTE =
  "Both monthly and annual terms are a 12-month commitment. Annual is 10% off and releases the full year of included checks on day one.";

/** Feature grid rows shown in the comparison table. Source: iink.com/pricing. */
export const IINK_FEATURE_ROWS: {
  label: string;
  checksOps: string;
  values: Record<IinkTierKey, string>;
}[] = [
  {
    label: "Included check submissions / mo",
    checksOps: "Unlimited (per-check pricing)",
    values: { basic: "2", essential: "8", plus: "25", premium: "50" },
  },
  {
    label: "Additional check submission",
    checksOps: "Flat per-check fee",
    values: { basic: "$22.50", essential: "$12.00", plus: "$9.00", premium: "$7.50" },
  },
  {
    label: "Per-check deposit limit",
    checksOps: "No published cap",
    values: { basic: "$100k", essential: "$500k", plus: "$750k", premium: "$1M" },
  },
  {
    label: "Early access to proceeds",
    checksOps: "Standard clearing",
    values: {
      basic: "—",
      essential: "2 days early ($60k cap)",
      plus: "2 days early ($60k cap)",
      premium: "2 days early ($60k cap)",
    },
  },
  {
    label: "Instant RTP transfers",
    checksOps: "Flat same-day fee",
    values: { basic: "3% of amount", essential: "2%", plus: "2%", premium: "2%" },
  },
  {
    label: "Standard ACH transfers",
    checksOps: "Flat next-day fee",
    values: { basic: "Included", essential: "Included", plus: "Included", premium: "Included" },
  },
  {
    label: "Mortgage check fee",
    checksOps: "Flat handling fee",
    values: { basic: "1% (cap $329)", essential: "1% (cap $329)", plus: "1% (cap $299)", premium: "1% (cap $299)" },
  },
  {
    label: "Additional mortgage companies (2+)",
    checksOps: "Included in handling fee",
    values: { basic: "$15", essential: "$15", plus: "$15", premium: "$15" },
  },
  {
    label: "Annual underwriting fee",
    checksOps: "None",
    values: { basic: "$299", essential: "$0", plus: "$0", premium: "$0" },
  },
  {
    label: "Business locations",
    checksOps: "Unlimited",
    values: { basic: "1", essential: "1", plus: "2", premium: "Unlimited" },
  },
  {
    label: "Digital endorsement + audit trail",
    checksOps: "Included",
    values: { basic: "Included", essential: "Included", plus: "Included", premium: "Included" },
  },
];

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

export interface SavingsInputs {
  // Prospect profile
  checksPerMonth: number;
  avgCheckAmount: number;
  /** % of monthly checks that carry a mortgage-company payee. */
  mortgagePctOfChecks: number;
  /** Average number of mortgage companies on those applicable checks. */
  avgMortgageCompanies: number;
  /** % of disbursed proceeds sent instantly (RTP / same-day). */
  rtpUsagePct: number;
  /** Disbursements per month sent next-day (ACH). */
  nextDayDisbursementsPerMonth: number;

  // iink term
  iinkAnnualBilling: boolean;

  // ChecksOps pricing (editable assumptions — reuses current app rates)
  coMonthlyFee: number;
  coPerCheckFee: number;
  coSameDayDisbursementFee: number;
  coNextDayDisbursementFee: number;
  coMortgageFee: number;
  coReferrals: number;
  coReferralCreditPerReferral: number;
  coReferralCreditCap: number;
  coSetupFee: number;
}

export const DEFAULT_SAVINGS: SavingsInputs = {
  checksPerMonth: 50,
  avgCheckAmount: 25_000,
  mortgagePctOfChecks: 20,
  avgMortgageCompanies: 1,
  rtpUsagePct: 25,
  nextDayDisbursementsPerMonth: 75,

  iinkAnnualBilling: false,

  coMonthlyFee: 100,
  coPerCheckFee: 4,
  coSameDayDisbursementFee: 1,
  coNextDayDisbursementFee: 0.75,
  coMortgageFee: 10,
  coReferrals: 0,
  coReferralCreditPerReferral: 5,
  coReferralCreditCap: 25,
  coSetupFee: 7500,
};

const nn = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);

/* ------------------------------------------------------------------ */
/* Cost breakdown                                                      */
/* ------------------------------------------------------------------ */

export interface CostBreakdown {
  /** Normal check-processing cost — subscription, per-check, disbursements. */
  subscription: number;
  perCheck: number;
  disbursement: number;
  otherRecurring: number; // e.g. amortized annual underwriting fee
  credits: number; // stored positive, subtracted from the total
  processingTotal: number;

  /** Mortgage / loss-draft-specific cost, kept apart for apples-to-apples. */
  mortgageBase: number;
  mortgageAdditionalCompanies: number;
  mortgageTotal: number;

  total: number;
  costPerCheck: number;
}

function finish(b: Omit<CostBreakdown, "processingTotal" | "mortgageTotal" | "total" | "costPerCheck">, checks: number): CostBreakdown {
  const processingTotal = Math.max(
    0,
    b.subscription + b.perCheck + b.disbursement + b.otherRecurring - b.credits,
  );
  const mortgageTotal = b.mortgageBase + b.mortgageAdditionalCompanies;
  const total = processingTotal + mortgageTotal;
  return { ...b, processingTotal, mortgageTotal, total, costPerCheck: checks > 0 ? total / checks : 0 };
}

/** Volume-derived counts, scaled when sweeping check volume for sensitivity. */
function volumes(i: SavingsInputs, checks: number) {
  const base = nn(i.checksPerMonth);
  const scale = base > 0 ? checks / base : 0;
  const mortgageChecks = checks * (Math.min(100, nn(i.mortgagePctOfChecks)) / 100);
  const extraCompanies = Math.max(0, nn(i.avgMortgageCompanies) - 1) * mortgageChecks;
  const nextDay = nn(i.nextDayDisbursementsPerMonth) * scale;
  const proceeds = checks * nn(i.avgCheckAmount);
  const rtpShare = Math.min(100, nn(i.rtpUsagePct)) / 100;
  const rtpAmount = proceeds * rtpShare;
  // Instant/same-day disbursements are modeled as the RTP share of check volume.
  const sameDay = checks * rtpShare;
  return { mortgageChecks, extraCompanies, nextDay, sameDay, rtpAmount };
}

/** Referral credit applied to the ChecksOps monthly fee ($5 each, capped). */
export function referralCredit(i: SavingsInputs): number {
  return Math.min(
    nn(i.coMonthlyFee),
    nn(i.coReferralCreditCap),
    nn(i.coReferrals) * nn(i.coReferralCreditPerReferral),
  );
}

export function checksOpsCost(i: SavingsInputs, checks: number): CostBreakdown {
  const v = volumes(i, checks);
  return finish(
    {
      subscription: nn(i.coMonthlyFee),
      perCheck: checks * nn(i.coPerCheckFee),
      disbursement:
        v.sameDay * nn(i.coSameDayDisbursementFee) + v.nextDay * nn(i.coNextDayDisbursementFee),
      otherRecurring: 0,
      credits: referralCredit(i),
      mortgageBase: v.mortgageChecks * nn(i.coMortgageFee),
      mortgageAdditionalCompanies: 0,
    },
    checks,
  );
}

export function iinkTierCost(tier: IinkTier, i: SavingsInputs, checks: number): CostBreakdown {
  const v = volumes(i, checks);
  const discount = i.iinkAnnualBilling ? 1 - IINK_ANNUAL_DISCOUNT_PCT / 100 : 1;
  const overage = Math.max(0, checks - tier.includedChecks);
  const perMortgageCheck = Math.min(tier.mortgageFeeCap, nn(i.avgCheckAmount) * (tier.mortgageFeePct / 100));
  return finish(
    {
      subscription: tier.monthlyFee * discount,
      perCheck: overage * tier.overageFee,
      disbursement: v.rtpAmount * (tier.rtpPct / 100),
      otherRecurring: tier.annualUnderwritingFee / 12,
      credits: 0,
      mortgageBase: v.mortgageChecks * perMortgageCheck,
      mortgageAdditionalCompanies: v.extraCompanies * tier.additionalMortgageCompanyFee,
    },
    checks,
  );
}

export interface TierComparison {
  tier: IinkTier;
  cost: CostBreakdown;
  /** False when the prospect's average check exceeds the published deposit limit. */
  eligible: boolean;
  monthlySavings: number;
  annualSavings: number;
  savingsPct: number;
  /** Smallest monthly check count where ChecksOps becomes cheaper than this tier. */
  breakEvenChecks: number | null;
}

export interface SavingsResult {
  checks: number;
  checksOps: CostBreakdown;
  tiers: TierComparison[];
  /** Cheapest eligible tier — the headline comparison. */
  best: TierComparison | null;
  /** True when no published tier supports the prospect's average check amount. */
  noEligibleTier: boolean;
}

function breakEvenFor(tier: IinkTier, i: SavingsInputs): number | null {
  for (let n = 1; n <= 2000; n++) {
    if (iinkTierCost(tier, i, n).total > checksOpsCost(i, n).total) return n;
  }
  return null;
}

export function computeSavings(i: SavingsInputs, checksOverride?: number): SavingsResult {
  const checks = nn(checksOverride ?? i.checksPerMonth);
  const co = checksOpsCost(i, checks);

  const tiers: TierComparison[] = IINK_TIERS.map((tier) => {
    const cost = iinkTierCost(tier, i, checks);
    const monthlySavings = cost.total - co.total;
    return {
      tier,
      cost,
      eligible: nn(i.avgCheckAmount) <= tier.depositLimit,
      monthlySavings,
      annualSavings: monthlySavings * 12,
      savingsPct: cost.total > 0 ? (monthlySavings / cost.total) * 100 : 0,
      breakEvenChecks: checksOverride === undefined ? breakEvenFor(tier, i) : null,
    };
  });

  const eligible = tiers.filter((t) => t.eligible);
  // Headline against the cheapest plan the prospect could actually buy.
  const best = eligible.length
    ? eligible.reduce((a, b) => (b.cost.total < a.cost.total ? b : a))
    : null;

  return { checks, checksOps: co, tiers, best, noEligibleTier: eligible.length === 0 };
}

export const SENSITIVITY_VOLUMES = [10, 25, 50, 100, 250, 500];

/* ------------------------------------------------------------------ */
/* Setup-fee payback                                                   */
/* ------------------------------------------------------------------ */

export interface PaybackRow {
  month: number;
  label: string;
  checksOpsCumulative: number;
  iinkCumulative: number;
  cumulativeSavings: number;
}

export function computeSavingsPayback(i: SavingsInputs, months = 24) {
  const r = computeSavings(i);
  const setupFee = nn(i.coSetupFee);
  const iinkMonthly = r.best?.cost.total ?? 0;
  const rows: PaybackRow[] = [];
  let co = setupFee;
  let ii = 0;
  let paybackMonth: number | null = null;

  for (let m = 1; m <= months; m++) {
    co += r.checksOps.total;
    ii += iinkMonthly;
    const cumulativeSavings = ii - co;
    if (paybackMonth === null && cumulativeSavings >= 0) paybackMonth = m;
    rows.push({ month: m, label: `M${m}`, checksOpsCumulative: co, iinkCumulative: ii, cumulativeSavings });
  }

  return {
    setupFee,
    monthlySavings: r.best?.monthlySavings ?? 0,
    rows,
    paybackMonth,
    twoYearNetSavings: rows.length ? rows[rows.length - 1].cumulativeSavings : -setupFee,
  };
}
