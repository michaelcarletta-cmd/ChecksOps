/**
 * ChecksOps financial model — single source of truth for the internal P&L
 * model and the client-facing ChecksOps vs iink savings calculator.
 *
 * Pricing defaults below are seeded from what exists in the product today:
 *  - tenants.monthly_rate_cents        → $100 / tenant / month
 *  - tenants.per_check_rate_cents      → $4.00 per check
 *  - founding partners                 → $75 / month locked
 *  - disbursements                     → $1.00 pass-through (Actum/Moov cost $1.00)
 *  - CheckAlt (FinCapture) RDC deposit → $0.68 per check cost
 *  - bill-mortgage-handling            → $10 first check / $5 additional + shipping
 *
 * Every value is editable in the UI. Confirm against the current
 * Moov / CheckAlt / bank contracts before quoting.
 */

export interface PnlAssumptions {
  // Volume
  tenants: number;
  checksPerTenantPerMonth: number;
  disbursementsPerCheck: number;
  disbursementsAtHighRatePct: number; // share of disbursements billed at the $1.00 rate

  // Revenue (charged to tenant)
  perCheckFee: number;
  disbursementFeeHigh: number; // $1.00
  disbursementFeeLow: number; // $0.75
  monthlyMaintenanceFee: number;
  mortgageHandlingFee: number;
  mortgageChecksPerTenantPerMonth: number;
  setupFee: number;
  newTenantsPerMonth: number;

  // Cost structure
  checkDepositCost: number; // CheckAlt / RDC per check
  nextDayDisbursementCost: number;
  sameDayDisbursementCost: number;
  rtpCost: number;
  nextDayMixPct: number;
  sameDayMixPct: number; // remainder of the two is RTP
  walletPerTenantMonthly: number;

  // Fixed overhead (monthly)
  checkAltMonthlyFee: number;
  moovMonthlyMinimumFee: number;
  kybKycSetupCost: number;
  checkAltOnboardingFee: number;
}

export const DEFAULT_PNL: PnlAssumptions = {
  tenants: 5,
  checksPerTenantPerMonth: 40,
  disbursementsPerCheck: 2,
  disbursementsAtHighRatePct: 100,

  perCheckFee: 4,
  disbursementFeeHigh: 1,
  disbursementFeeLow: 0.75,
  monthlyMaintenanceFee: 100,
  mortgageHandlingFee: 10,
  mortgageChecksPerTenantPerMonth: 4,
  setupFee: 7500,
  newTenantsPerMonth: 1,

  checkDepositCost: 0.68,
  nextDayDisbursementCost: 0.5,
  sameDayDisbursementCost: 1,
  rtpCost: 0.5,
  nextDayMixPct: 80,
  sameDayMixPct: 15,
  walletPerTenantMonthly: 0,

  checkAltMonthlyFee: 0,
  moovMonthlyMinimumFee: 0,
  kybKycSetupCost: 0,
  checkAltOnboardingFee: 0,
};

export interface PnlResult {
  checks: number;
  disbursements: number;

  maintenanceRevenue: number;
  perCheckRevenue: number;
  disbursementRevenue: number;
  mortgageRevenue: number;
  setupRevenue: number;
  grossRevenue: number;

  depositCost: number;
  disbursementCost: number;
  walletCost: number;
  variableCost: number;

  grossProfit: number;
  grossMarginPct: number;
  fixedOverhead: number;
  netProfit: number;
  netMarginPct: number;

  revenuePerTenant: number;
  costPerTenant: number;
  profitPerTenant: number;
  contributionPerTenant: number;
  breakEvenTenants: number;
}

const nn = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);
const clampPct = (v: number) => Math.min(100, Math.max(0, Number.isFinite(v) ? v : 0));

/** Blended cost of a single disbursement across next-day / same-day / RTP rails. */
function blendedDisbursementCost(a: PnlAssumptions): number {
  const nextDay = clampPct(a.nextDayMixPct) / 100;
  const sameDay = clampPct(a.sameDayMixPct) / 100;
  const rtp = Math.max(0, 1 - nextDay - sameDay);
  return (
    nextDay * nn(a.nextDayDisbursementCost) +
    sameDay * nn(a.sameDayDisbursementCost) +
    rtp * nn(a.rtpCost)
  );
}

/** Blended price charged for a single disbursement ($1.00 / $0.75 mix). */
function blendedDisbursementFee(a: PnlAssumptions): number {
  const high = clampPct(a.disbursementsAtHighRatePct) / 100;
  return high * nn(a.disbursementFeeHigh) + (1 - high) * nn(a.disbursementFeeLow);
}

export function computePnl(a: PnlAssumptions, tenantOverride?: number): PnlResult {
  const tenants = nn(tenantOverride ?? a.tenants);
  const checks = tenants * nn(a.checksPerTenantPerMonth);
  const disbursements = checks * nn(a.disbursementsPerCheck);

  const maintenanceRevenue = tenants * nn(a.monthlyMaintenanceFee);
  const perCheckRevenue = checks * nn(a.perCheckFee);
  const disbursementRevenue = disbursements * blendedDisbursementFee(a);
  const mortgageChecks = tenants * nn(a.mortgageChecksPerTenantPerMonth);
  const mortgageRevenue = mortgageChecks * nn(a.mortgageHandlingFee);
  const setupRevenue = nn(a.newTenantsPerMonth) * nn(a.setupFee);
  const grossRevenue =
    maintenanceRevenue + perCheckRevenue + disbursementRevenue + mortgageRevenue + setupRevenue;

  const depositCost = checks * nn(a.checkDepositCost);
  const disbursementCost = disbursements * blendedDisbursementCost(a);
  const walletCost = tenants * nn(a.walletPerTenantMonthly);
  const variableCost = depositCost + disbursementCost + walletCost;

  const grossProfit = grossRevenue - variableCost;
  const fixedOverhead =
    nn(a.checkAltMonthlyFee) +
    nn(a.moovMonthlyMinimumFee) +
    nn(a.kybKycSetupCost) +
    nn(a.checkAltOnboardingFee);
  const netProfit = grossProfit - fixedOverhead;

  const one = computeContributionPerTenant(a);

  return {
    checks,
    disbursements,
    maintenanceRevenue,
    perCheckRevenue,
    disbursementRevenue,
    mortgageRevenue,
    setupRevenue,
    grossRevenue,
    depositCost,
    disbursementCost,
    walletCost,
    variableCost,
    grossProfit,
    grossMarginPct: grossRevenue > 0 ? (grossProfit / grossRevenue) * 100 : 0,
    fixedOverhead,
    netProfit,
    netMarginPct: grossRevenue > 0 ? (netProfit / grossRevenue) * 100 : 0,
    revenuePerTenant: tenants > 0 ? grossRevenue / tenants : 0,
    costPerTenant: tenants > 0 ? (variableCost + fixedOverhead) / tenants : 0,
    profitPerTenant: tenants > 0 ? netProfit / tenants : 0,
    contributionPerTenant: one,
    breakEvenTenants: one > 0 ? Math.ceil(fixedOverhead / one) : 0,
  };
}

/** Recurring gross profit generated by one additional tenant (excludes setup fee). */
function computeContributionPerTenant(a: PnlAssumptions): number {
  const checks = nn(a.checksPerTenantPerMonth);
  const disbursements = checks * nn(a.disbursementsPerCheck);
  const mortgageChecks = nn(a.mortgageChecksPerTenantPerMonth);

  const revenue =
    nn(a.monthlyMaintenanceFee) +
    checks * nn(a.perCheckFee) +
    disbursements * blendedDisbursementFee(a) +
    mortgageChecks * nn(a.mortgageHandlingFee);

  const cost =
    checks * nn(a.checkDepositCost) +
    disbursements * blendedDisbursementCost(a) +
    nn(a.walletPerTenantMonthly);

  return revenue - cost;
}

export interface ProjectionRow {
  month: number;
  label: string;
  tenants: number;
  revenue: number;
  cost: number;
  grossProfit: number;
  netProfit: number;
  netMarginPct: number;
}

export function projectTwelveMonths(a: PnlAssumptions, netNewTenantsPerMonth: number): ProjectionRow[] {
  const rows: ProjectionRow[] = [];
  let tenants = nn(a.tenants);
  for (let m = 1; m <= 12; m++) {
    if (m > 1) tenants += nn(netNewTenantsPerMonth);
    const r = computePnl({ ...a, newTenantsPerMonth: m === 1 ? a.newTenantsPerMonth : netNewTenantsPerMonth }, tenants);
    rows.push({
      month: m,
      label: `M${m}`,
      tenants: Math.round(tenants),
      revenue: r.grossRevenue,
      cost: r.variableCost + r.fixedOverhead,
      grossProfit: r.grossProfit,
      netProfit: r.netProfit,
      netMarginPct: r.netMarginPct,
    });
  }
  return rows;
}

export type ScenarioKey = "low" | "expected" | "high";

export const SCENARIOS: Record<ScenarioKey, { label: string; patch: Partial<PnlAssumptions> }> = {
  low: {
    label: "Low volume",
    patch: { tenants: 3, checksPerTenantPerMonth: 20, disbursementsPerCheck: 2, newTenantsPerMonth: 0 },
  },
  expected: {
    label: "Expected",
    patch: { tenants: 10, checksPerTenantPerMonth: 40, disbursementsPerCheck: 2, newTenantsPerMonth: 1 },
  },
  high: {
    label: "High volume",
    patch: { tenants: 30, checksPerTenantPerMonth: 100, disbursementsPerCheck: 3, newTenantsPerMonth: 3 },
  },
};


/* ------------------------------------------------------------------ */
/* ChecksOps vs iink comparison                                        */
/* ------------------------------------------------------------------ */

export interface ComparisonInputs {
  checksPerMonth: number;
  avgCheckAmount: number;
  disbursementsPerCheck: number;
  instantMixPct: number; // % of disbursements sent instant/RTP

  // ChecksOps pricing
  coMonthlyFee: number;
  coPerCheckFee: number;
  coPerDisbursementFee: number;
  coPercentFeePct: number;
  coInstantSurcharge: number;

  // iink comparison assumptions — CONFIRM against current iink pricing
  iinkMonthlyFee: number;
  iinkPerCheckFee: number;
  iinkPercentFeePct: number;
  iinkInstantFeePct: number; // extra % for instant funding
  iinkPerDisbursementFee: number;
}

export const DEFAULT_COMPARISON: ComparisonInputs = {
  checksPerMonth: 50,
  avgCheckAmount: 12000,
  disbursementsPerCheck: 2,
  instantMixPct: 15,

  coMonthlyFee: 100,
  coPerCheckFee: 4,
  coPerDisbursementFee: 1,
  coPercentFeePct: 0,
  coInstantSurcharge: 0.5,

  iinkMonthlyFee: 0,
  iinkPerCheckFee: 0,
  iinkPercentFeePct: 3,
  iinkInstantFeePct: 1,
  iinkPerDisbursementFee: 0,
};

export interface SideCost {
  monthlyFee: number;
  perCheck: number;
  perDisbursement: number;
  percentFee: number;
  instantFee: number;
  total: number;
  costPerCheck: number;
  percentOfVolume: number;
  basisPoints: number;
}

export interface ComparisonResult {
  volume: number;
  disbursements: number;
  instantDisbursements: number;
  checksOps: SideCost;
  iink: SideCost;
  monthlySavings: number;
  annualSavings: number;
  savingsPct: number;
  breakEvenChecks: number | null;
}

function sideTotals(parts: Omit<SideCost, "total" | "costPerCheck" | "percentOfVolume" | "basisPoints">, checks: number, volume: number): SideCost {
  const total = parts.monthlyFee + parts.perCheck + parts.perDisbursement + parts.percentFee + parts.instantFee;
  return {
    ...parts,
    total,
    costPerCheck: checks > 0 ? total / checks : 0,
    percentOfVolume: volume > 0 ? (total / volume) * 100 : 0,
    basisPoints: volume > 0 ? (total / volume) * 10000 : 0,
  };
}

export function compareCosts(i: ComparisonInputs, checksOverride?: number): ComparisonResult {
  const checks = nn(checksOverride ?? i.checksPerMonth);
  const volume = checks * nn(i.avgCheckAmount);
  const disbursements = checks * nn(i.disbursementsPerCheck);
  const instantShare = clampPct(i.instantMixPct) / 100;
  const instantDisbursements = disbursements * instantShare;

  const checksOps = sideTotals(
    {
      monthlyFee: nn(i.coMonthlyFee),
      perCheck: checks * nn(i.coPerCheckFee),
      perDisbursement: disbursements * nn(i.coPerDisbursementFee),
      percentFee: volume * (clampPct(i.coPercentFeePct) / 100),
      instantFee: instantDisbursements * nn(i.coInstantSurcharge),
    },
    checks,
    volume,
  );

  const iink = sideTotals(
    {
      monthlyFee: nn(i.iinkMonthlyFee),
      perCheck: checks * nn(i.iinkPerCheckFee),
      perDisbursement: disbursements * nn(i.iinkPerDisbursementFee),
      percentFee: volume * (clampPct(i.iinkPercentFeePct) / 100),
      instantFee: volume * instantShare * (clampPct(i.iinkInstantFeePct) / 100),
    },
    checks,
    volume,
  );

  const monthlySavings = iink.total - checksOps.total;

  return {
    volume,
    disbursements,
    instantDisbursements,
    checksOps,
    iink,
    monthlySavings,
    annualSavings: monthlySavings * 12,
    savingsPct: iink.total > 0 ? (monthlySavings / iink.total) * 100 : 0,
    breakEvenChecks: findBreakEvenChecks(i),
  };
}

/** Monthly savings at a given check count, without recursing into break-even search. */
function savingsAt(i: ComparisonInputs, checks: number): number {
  const volume = checks * nn(i.avgCheckAmount);
  const disbursements = checks * nn(i.disbursementsPerCheck);
  const instantShare = clampPct(i.instantMixPct) / 100;

  const co =
    nn(i.coMonthlyFee) +
    checks * nn(i.coPerCheckFee) +
    disbursements * nn(i.coPerDisbursementFee) +
    volume * (clampPct(i.coPercentFeePct) / 100) +
    disbursements * instantShare * nn(i.coInstantSurcharge);

  const ii =
    nn(i.iinkMonthlyFee) +
    checks * nn(i.iinkPerCheckFee) +
    disbursements * nn(i.iinkPerDisbursementFee) +
    volume * (clampPct(i.iinkPercentFeePct) / 100) +
    volume * instantShare * (clampPct(i.iinkInstantFeePct) / 100);

  return ii - co;
}

/** Smallest whole check count where ChecksOps becomes cheaper than iink. */
export function findBreakEvenChecks(i: ComparisonInputs): number | null {
  for (let n = 1; n <= 2000; n++) {
    if (savingsAt(i, n) > 0) return n;
  }
  return null;
}

export const SENSITIVITY_VOLUMES = [25, 50, 100, 250, 500, 1000];

export const money = (v: number, decimals = 0) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(Number.isFinite(v) ? v : 0);

export const pct = (v: number, decimals = 1) =>
  `${(Number.isFinite(v) ? v : 0).toFixed(decimals)}%`;
