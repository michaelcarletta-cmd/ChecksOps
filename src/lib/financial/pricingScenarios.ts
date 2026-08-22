/**
 * ChecksOps pricing optimization layer — SALES / ANALYSIS ONLY.
 *
 * Nothing in this file touches live billing. It models alternative ChecksOps
 * pricing structures (flat, tiered with declining overage rates) against the
 * published iink tiers so we can find a structure that is meaningfully cheaper
 * than iink while still holding a healthy gross margin over our provider costs.
 *
 * Provider cost defaults are seeded from the internal P&L model
 * (src/lib/financial/model.ts). Confirm against current CheckAlt / Moov
 * contracts before quoting — every value is editable in the UI.
 */

import {
  IinkTier,
  SavingsInputs,
  effectiveChecks,
  iinkTierCost,
  scaledVolumes,
} from "./iink";

const nn = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);

/* ------------------------------------------------------------------ */
/* Scenario definition                                                 */
/* ------------------------------------------------------------------ */

/** One declining-rate band. `upTo` is a cumulative monthly check count; null = unlimited. */
export interface PricingBand {
  upTo: number | null;
  rate: number;
}

export interface PricingScenario {
  key: string;
  label: string;
  description: string;
  /** True for the plan customers are on today — never auto-changed. */
  isCurrent?: boolean;
  monthlyFee: number;
  /** Checks bundled into the monthly fee before any per-check charge applies. */
  includedChecks: number;
  /** Declining per-check bands applied to checks beyond the included allowance. */
  bands: PricingBand[];
  sameDayFee: number;
  nextDayFee: number;
  rtpPct: number;
  rtpCap: number;
  /** Fee on a wallet / internal transfer job. */
  walletFee: number;
  mortgageFee: number;
  mortgageAdditionalCheckFee: number;
}

export const DEFAULT_SCENARIOS: PricingScenario[] = [
  {
    key: "current",
    label: "Current Plan",
    description: "What the platform bills today — $100/mo plus a flat $4.00 per check.",
    isCurrent: true,
    monthlyFee: 100,
    includedChecks: 0,
    bands: [{ upTo: null, rate: 4 }],
    sameDayFee: 1,
    nextDayFee: 0.75,
    rtpPct: 0.95,
    rtpCap: 5,
    walletFee: 0,
    mortgageFee: 10,
    mortgageAdditionalCheckFee: 5,
  },
  {
    key: "tiered",
    label: "Tiered Plan",
    description:
      "Same $99 entry point with 5 checks bundled, then declining per-check rates as volume grows.",
    monthlyFee: 99,
    includedChecks: 5,
    bands: [
      { upTo: 25, rate: 3.75 },
      { upTo: 100, rate: 3.25 },
      { upTo: null, rate: 2.75 },
    ],
    sameDayFee: 1,
    nextDayFee: 0.75,
    rtpPct: 0.95,
    rtpCap: 5,
    walletFee: 0,
    mortgageFee: 10,
    mortgageAdditionalCheckFee: 5,
  },
  {
    key: "recommended",
    label: "Recommended Plan",
    description:
      "Lower entry fee with 10 checks bundled and aggressive declining rates — targets 20–30% under the applicable iink tier at every volume band.",
    monthlyFee: 79,
    includedChecks: 10,
    bands: [
      { upTo: 50, rate: 3.25 },
      { upTo: 200, rate: 2.75 },
      { upTo: null, rate: 2.25 },
    ],
    sameDayFee: 1,
    nextDayFee: 0.75,
    rtpPct: 0.95,
    rtpCap: 5,
    walletFee: 0,
    mortgageFee: 10,
    mortgageAdditionalCheckFee: 5,
  },
];

/* ------------------------------------------------------------------ */
/* Provider cost assumptions (our side)                                */
/* ------------------------------------------------------------------ */

export interface ProviderCosts {
  /** CheckAlt / FinCapture RDC cost per deposited check. */
  depositCostPerCheck: number;
  /** Moov cost per same-day ACH disbursement. */
  sameDayCost: number;
  /** Moov cost per next-day ACH disbursement. */
  nextDayCost: number;
  /** Cost per instant RTP transfer. CONFIRM against the Moov contract. */
  rtpCostPerTransfer: number;
  /** Our cost to handle a mortgage / loss-draft check (labour + shipping). CONFIRM. */
  mortgageHandlingCost: number;
  /** Our cost per wallet / internal transfer. CONFIRM. */
  walletCost: number;
  /** Monthly platform/infra cost carried per tenant. */
  platformCostPerTenant: number;
}

export const DEFAULT_PROVIDER_COSTS: ProviderCosts = {
  depositCostPerCheck: 0.68,
  sameDayCost: 1,
  nextDayCost: 0.5,
  rtpCostPerTransfer: 0.5,
  mortgageHandlingCost: 8,
  walletCost: 0,
  platformCostPerTenant: 15,
};

/* ------------------------------------------------------------------ */
/* Scenario costing                                                    */
/* ------------------------------------------------------------------ */

/** Per-check revenue for `checks` monthly checks under a scenario's banded rates. */
export function bandedCheckRevenue(s: PricingScenario, checks: number): number {
  const billable = Math.max(0, nn(checks) - nn(s.includedChecks));
  if (billable === 0) return 0;
  const bands = s.bands.length ? s.bands : [{ upTo: null, rate: 0 }];
  let remaining = billable;
  // Bands are expressed as cumulative TOTAL monthly check counts.
  let consumedTotal = nn(s.includedChecks);
  let total = 0;
  for (const band of bands) {
    if (remaining <= 0) break;
    const cap = band.upTo === null ? Infinity : Math.max(0, band.upTo - consumedTotal);
    const take = Math.min(remaining, cap);
    total += take * nn(band.rate);
    remaining -= take;
    consumedTotal += take;
  }
  return total;
}

export interface ScenarioCost {
  subscription: number;
  perCheck: number;
  disbursement: number;
  wallet: number;
  credits: number;
  processingTotal: number;
  mortgageTotal: number;
  total: number;
  costPerCheck: number;
  /** Jobs / transactions behind the cost — the workflow-mix denominator. */
  jobs: number;
  /** Primary metric: effective cost per job / transaction. */
  costPerJob: number;
}

export interface ScenarioMargin {
  revenue: number;
  providerCost: number;
  grossProfit: number;
  grossMarginPct: number;
}

export function scenarioCost(
  s: PricingScenario,
  i: SavingsInputs,
  checks: number,
  referralCredits = 0,
): ScenarioCost {
  const v = scaledVolumes(i, checks);
  const subscription = nn(s.monthlyFee);
  const perCheck = bandedCheckRevenue(s, checks);
  const disbursement =
    v.sameDay * nn(s.sameDayFee) +
    v.nextDay * nn(s.nextDayFee) +
    v.rtpTransfers * Math.min(nn(s.rtpCap), nn(i.avgRtpTransferAmount) * (nn(s.rtpPct) / 100));
  const wallet = v.walletTransfers * nn(s.walletFee);
  const credits = Math.min(subscription, nn(referralCredits));
  const processingTotal = Math.max(0, subscription + perCheck + disbursement + wallet - credits);
  const mortgageTotal = v.usesMortgage
    ? v.mortgageChecks * nn(s.mortgageFee) + v.extraMortgageChecks * nn(s.mortgageAdditionalCheckFee)
    : 0;
  const total = processingTotal + mortgageTotal;
  return {
    subscription,
    perCheck,
    disbursement,
    wallet,
    credits,
    processingTotal,
    mortgageTotal,
    total,
    costPerCheck: checks > 0 ? total / checks : 0,
    jobs: v.jobs,
    costPerJob: v.jobs > 0 ? total / v.jobs : 0,
  };
}

export function scenarioMargin(
  cost: ScenarioCost,
  c: ProviderCosts,
  i: SavingsInputs,
  checks: number,
): ScenarioMargin {
  const v = scaledVolumes(i, checks);
  const providerCost =
    checks * nn(c.depositCostPerCheck) +
    v.sameDay * nn(c.sameDayCost) +
    v.nextDay * nn(c.nextDayCost) +
    v.rtpTransfers * nn(c.rtpCostPerTransfer) +
    v.walletTransfers * nn(c.walletCost) +
    (v.usesMortgage ? (v.mortgageChecks + v.extraMortgageChecks) * nn(c.mortgageHandlingCost) : 0) +
    nn(c.platformCostPerTenant);
  const revenue = cost.total;
  const grossProfit = revenue - providerCost;
  return {
    revenue,
    providerCost,
    grossProfit,
    grossMarginPct: revenue > 0 ? (grossProfit / revenue) * 100 : 0,
  };
}

/* ------------------------------------------------------------------ */
/* Scenario vs iink                                                    */
/* ------------------------------------------------------------------ */

export interface ScenarioVsTier {
  tier: IinkTier;
  eligible: boolean;
  iinkTotal: number;
  monthlySavings: number;
  savingsPct: number;
  /** Smallest monthly volume where this scenario beats the tier (null = never ≤ 2,000). */
  breakEvenChecks: number | null;
}

export interface ScenarioAtVolume {
  checks: number;
  cost: ScenarioCost;
  margin: ScenarioMargin;
  /** Cheapest iink tier the prospect could actually buy at this check size. */
  bestTier: IinkTier | null;
  bestTierTotal: number;
  savings: number;
  savingsPct: number;
  wins: boolean;
  /** True when savings land in the 20–30% target corridor and margin clears the floor. */
  inTargetCorridor: boolean;
  /** Cheaper than iink by MORE than the target — room to raise price. */
  aboveCorridor: boolean;
  marginHealthy: boolean;
}

export interface ScenarioAnalysis {
  scenario: PricingScenario;
  atProspectVolume: ScenarioAtVolume;
  byVolume: ScenarioAtVolume[];
  vsTiers: ScenarioVsTier[];
  /** Volumes (from the sweep) where the scenario beats the best eligible iink tier. */
  winningVolumes: number[];
  /** Volumes where savings land inside the target discount corridor with healthy margin. */
  targetVolumes: number[];
  /** Mean savings % across the sweep — used for ranking. */
  avgSavingsPct: number;
  /** Mean gross margin % across the sweep. */
  avgMarginPct: number;
  score: number;
}

export interface OptimizationTargets {
  /** Lower bound of the desired discount vs iink. */
  minDiscountPct: number;
  /** Upper bound — going past this gives away margin unnecessarily. */
  maxDiscountPct: number;
  /** Gross margin floor we refuse to price below. */
  minGrossMarginPct: number;
}

export const DEFAULT_TARGETS: OptimizationTargets = {
  minDiscountPct: 20,
  maxDiscountPct: 30,
  minGrossMarginPct: 55,
};

export const OPTIMIZATION_VOLUMES = [5, 10, 25, 50, 100, 250, 500];

function bestEligibleTier(i: SavingsInputs, checks: number, tiers: IinkTier[]) {
  const eligible = tiers.filter((t) => nn(i.avgCheckAmount) <= t.depositLimit);
  if (!eligible.length) return null;
  return eligible.reduce((a, b) =>
    iinkTierCost(b, i, checks).total < iinkTierCost(a, i, checks).total ? b : a,
  );
}

function atVolume(
  s: PricingScenario,
  i: SavingsInputs,
  c: ProviderCosts,
  t: OptimizationTargets,
  tiers: IinkTier[],
  checks: number,
  referralCredits: number,
): ScenarioAtVolume {
  const cost = scenarioCost(s, i, checks, referralCredits);
  const margin = scenarioMargin(cost, c, i, checks);
  const tier = bestEligibleTier(i, checks, tiers);
  const bestTierTotal = tier ? iinkTierCost(tier, i, checks).total : 0;
  const savings = bestTierTotal - cost.total;
  const savingsPct = bestTierTotal > 0 ? (savings / bestTierTotal) * 100 : 0;
  const marginHealthy = margin.grossMarginPct >= t.minGrossMarginPct;
  return {
    checks,
    cost,
    margin,
    bestTier: tier,
    bestTierTotal,
    savings,
    savingsPct,
    wins: savings > 0,
    inTargetCorridor:
      savingsPct >= t.minDiscountPct && savingsPct <= t.maxDiscountPct && marginHealthy,
    aboveCorridor: savings > 0 && savingsPct > t.maxDiscountPct,
    marginHealthy,
  };
}

function breakEven(s: PricingScenario, i: SavingsInputs, tier: IinkTier, referralCredits: number) {
  for (let n = 1; n <= 2000; n++) {
    if (iinkTierCost(tier, i, n).total > scenarioCost(s, i, n, referralCredits).total) return n;
  }
  return null;
}

export function analyzeScenario(
  scenario: PricingScenario,
  i: SavingsInputs,
  c: ProviderCosts,
  t: OptimizationTargets,
  tiers: IinkTier[],
  referralCredits = 0,
): ScenarioAnalysis {
  const byVolume = OPTIMIZATION_VOLUMES.map((n) =>
    atVolume(scenario, i, c, t, tiers, n, referralCredits),
  );
  const atProspectVolume = atVolume(
    scenario,
    i,
    c,
    t,
    tiers,
    effectiveChecks(i),
    referralCredits,
  );

  const vsTiers: ScenarioVsTier[] = tiers.map((tier) => {
    const iinkTotal = iinkTierCost(tier, i, effectiveChecks(i)).total;
    const prospectTotal = atProspectVolume.cost.total;
    const monthlySavings = iinkTotal - prospectTotal;
    return {
      tier,
      eligible: nn(i.avgCheckAmount) <= tier.depositLimit,
      iinkTotal,
      monthlySavings,
      savingsPct: iinkTotal > 0 ? (monthlySavings / iinkTotal) * 100 : 0,
      breakEvenChecks: breakEven(scenario, i, tier, referralCredits),
    };
  });

  const winningVolumes = byVolume.filter((v) => v.wins).map((v) => v.checks);
  const targetVolumes = byVolume.filter((v) => v.inTargetCorridor).map((v) => v.checks);
  const avgSavingsPct = byVolume.reduce((a, v) => a + v.savingsPct, 0) / (byVolume.length || 1);
  const avgMarginPct = byVolume.reduce((a, v) => a + v.margin.grossMarginPct, 0) / (byVolume.length || 1);

  // Rank on corridor hits first, then wins, then margin quality.
  const score = targetVolumes.length * 100 + winningVolumes.length * 20 + avgMarginPct / 10;

  return {
    scenario,
    atProspectVolume,
    byVolume,
    vsTiers,
    winningVolumes,
    targetVolumes,
    avgSavingsPct,
    avgMarginPct,
    score,
  };
}

export interface OptimizationResult {
  analyses: ScenarioAnalysis[];
  /** Best structure for the prospect's actual volume. */
  bestFit: ScenarioAnalysis | null;
  /** Reasoning shown on the Best Fit card. */
  bestFitReason: string;
}

export function optimizePricing(
  scenarios: PricingScenario[],
  i: SavingsInputs,
  c: ProviderCosts,
  t: OptimizationTargets,
  tiers: IinkTier[],
  referralCredits = 0,
): OptimizationResult {
  const analyses = scenarios.map((s) => analyzeScenario(s, i, c, t, tiers, referralCredits));

  // At the prospect's own volume: prefer in-corridor + healthy margin, then the
  // healthiest-margin winner, then whatever is cheapest for the customer.
  const ranked = [...analyses].sort((a, b) => {
    const av = a.atProspectVolume;
    const bv = b.atProspectVolume;
    if (av.inTargetCorridor !== bv.inTargetCorridor) return av.inTargetCorridor ? -1 : 1;
    if (av.marginHealthy !== bv.marginHealthy) return av.marginHealthy ? -1 : 1;
    if (av.wins !== bv.wins) return av.wins ? -1 : 1;
    return bv.margin.grossProfit - av.margin.grossProfit;
  });

  const bestFit = ranked[0] ?? null;
  let bestFitReason = "No scenario configured.";
  if (bestFit) {
    const v = bestFit.atProspectVolume;
    const tierLabel = v.bestTier ? `iink ${v.bestTier.label}` : "iink";
    if (v.inTargetCorridor) {
      bestFitReason = `At ${effectiveChecks(i).toLocaleString()} checks/mo this lands ${v.savingsPct.toFixed(0)}% under ${tierLabel} — inside the ${t.minDiscountPct}–${t.maxDiscountPct}% target — while holding a ${v.margin.grossMarginPct.toFixed(0)}% gross margin.`;
    } else if (v.aboveCorridor && v.marginHealthy) {
      bestFitReason = `Beats ${tierLabel} by ${v.savingsPct.toFixed(0)}% at a ${v.margin.grossMarginPct.toFixed(0)}% gross margin — that is well past the ${t.minDiscountPct}–${t.maxDiscountPct}% target, so there is headroom to price higher and still win the deal.`;
    } else if (v.wins && v.marginHealthy) {
      bestFitReason = `Beats ${tierLabel} by ${v.savingsPct.toFixed(0)}% with a ${v.margin.grossMarginPct.toFixed(0)}% gross margin, though that sits outside the ${t.minDiscountPct}–${t.maxDiscountPct}% target corridor.`;
    } else if (v.wins) {
      bestFitReason = `Beats ${tierLabel} by ${v.savingsPct.toFixed(0)}%, but gross margin is only ${v.margin.grossMarginPct.toFixed(0)}% — below the ${t.minGrossMarginPct}% floor. Raise the per-check band or the monthly fee.`;
    } else {
      bestFitReason = `No configured scenario beats ${tierLabel} at ${effectiveChecks(i).toLocaleString()} checks/mo. This is the closest — ${v.savingsPct.toFixed(0)}% vs ${tierLabel}. Lower the monthly fee or the per-check bands.`;
    }
  }

  return { analyses, bestFit, bestFitReason };
}

export const describeBands = (s: PricingScenario) => {
  const parts: string[] = [];
  if (s.includedChecks > 0) parts.push(`${s.includedChecks} incl.`);
  let from = s.includedChecks + 1;
  for (const b of s.bands) {
    const to = b.upTo === null ? "+" : `–${b.upTo}`;
    parts.push(`${from}${to}: $${b.rate.toFixed(2)}`);
    if (b.upTo === null) break;
    from = b.upTo + 1;
  }
  return parts.join(" · ");
};
