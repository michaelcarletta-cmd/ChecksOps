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
  avgCheckValue: number;
  disbursementsPerCheck: number;
  achMixPct: number; // 0-100, remainder is instant/RTP

  // Revenue (charged to tenant)
  monthlyPlatformFee: number;
  perCheckFee: number;
  perDisbursementFee: number;
  percentFeePct: number; // % of payment volume, 0 by default
  mortgageHandlingFee: number;
  mortgageChecksPerTenantPerMonth: number;
  setupFee: number;
  newTenantsPerMonth: number;

  // Variable costs
  checkDepositCost: number; // CheckAlt / RDC per check
  achCost: number; // per ACH disbursement
  instantCost: number; // per RTP / instant push
  ocrCost: number; // AI/OCR + storage per check
  mortgageShippingCost: number;

  // Per-tenant fixed costs
  kycPerTenantMonthly: number;
  walletPerTenantMonthly: number;
  supportPerTenantMonthly: number;

  // Company fixed overhead (monthly)
  payroll: number;
  software: number;
  compliance: number;
  otherOverhead: number;
}

export const DEFAULT_PNL: PnlAssumptions = {
  tenants: 5,
  checksPerTenantPerMonth: 40,
  avgCheckValue: 12000,
  disbursementsPerCheck: 2,
  achMixPct: 85,

  monthlyPlatformFee: 100,
  perCheckFee: 4,
  perDisbursementFee: 1,
  percentFeePct: 0,
  mortgageHandlingFee: 10,
  mortgageChecksPerTenantPerMonth: 4,
  setupFee: 7500,
  newTenantsPerMonth: 1,

  checkDepositCost: 0.68,
  achCost: 1,
  instantCost: 1.5,
  ocrCost: 0.15,
  mortgageShippingCost: 30,

  kycPerTenantMonthly: 0,
  walletPerTenantMonthly: 0,
  supportPerTenantMonthly: 5,

  payroll: 0,
  software: 500,
  compliance: 250,
  otherOverhead: 250,
};

export interface PnlResult {
  checks: number;
  disbursements: number;
  paymentVolume: number;

  subscriptionRevenue: number;
  perCheckRevenue: number;
  disbursementRevenue: number;
  percentFeeRevenue: number;
  mortgageRevenue: number;
  setupRevenue: number;
  grossRevenue: number;

  depositCost: number;
  disbursementCost: number;
  ocrCostTotal: number;
  mortgageCostTotal: number;
  perTenantCost: number;
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

export function computePnl(a: PnlAssumptions, tenantOverride?: number): PnlResult {
  const tenants = nn(tenantOverride ?? a.tenants);
  const checks = tenants * nn(a.checksPerTenantPerMonth);
  const disbursements = checks * nn(a.disbursementsPerCheck);
  const paymentVolume = checks * nn(a.avgCheckValue);
  const achShare = clampPct(a.achMixPct) / 100;

  const subscriptionRevenue = tenants * nn(a.monthlyPlatformFee);
  const perCheckRevenue = checks * nn(a.perCheckFee);
  const disbursementRevenue = disbursements * nn(a.perDisbursementFee);
  const percentFeeRevenue = paymentVolume * (clampPct(a.percentFeePct) / 100);
  const mortgageChecks = tenants * nn(a.mortgageChecksPerTenantPerMonth);
  const mortgageRevenue = mortgageChecks * (nn(a.mortgageHandlingFee) + nn(a.mortgageShippingCost));
  const setupRevenue = nn(a.newTenantsPerMonth) * nn(a.setupFee);
  const grossRevenue =
    subscriptionRevenue + perCheckRevenue + disbursementRevenue + percentFeeRevenue + mortgageRevenue + setupRevenue;

  const depositCost = checks * nn(a.checkDepositCost);
  const disbursementCost =
    disbursements * achShare * nn(a.achCost) + disbursements * (1 - achShare) * nn(a.instantCost);
  const ocrCostTotal = checks * nn(a.ocrCost);
  const mortgageCostTotal = mortgageChecks * nn(a.mortgageShippingCost);
  const perTenantCost =
    tenants * (nn(a.kycPerTenantMonthly) + nn(a.walletPerTenantMonthly) + nn(a.supportPerTenantMonthly));
  const variableCost = depositCost + disbursementCost + ocrCostTotal + mortgageCostTotal + perTenantCost;

  const grossProfit = grossRevenue - variableCost;
  const fixedOverhead = nn(a.payroll) + nn(a.software) + nn(a.compliance) + nn(a.otherOverhead);
  const netProfit = grossProfit - fixedOverhead;

  const one = computeContributionPerTenant(a);

  return {
    checks,
    disbursements,
    paymentVolume,
    subscriptionRevenue,
    perCheckRevenue,
    disbursementRevenue,
    percentFeeRevenue,
    mortgageRevenue,
    setupRevenue,
    grossRevenue,
    depositCost,
    disbursementCost,
    ocrCostTotal,
    mortgageCostTotal,
    perTenantCost,
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
  const noSetup: PnlAssumptions = { ...a, tenants: 1, newTenantsPerMonth: 0 };
  const checks = nn(noSetup.checksPerTenantPerMonth);
  const disbursements = checks * nn(noSetup.disbursementsPerCheck);
  const achShare = clampPct(noSetup.achMixPct) / 100;
  const mortgageChecks = nn(noSetup.mortgageChecksPerTenantPerMonth);

  const revenue =
    nn(noSetup.monthlyPlatformFee) +
    checks * nn(noSetup.perCheckFee) +
    disbursements * nn(noSetup.perDisbursementFee) +
    checks * nn(noSetup.avgCheckValue) * (clampPct(noSetup.percentFeePct) / 100) +
    mortgageChecks * (nn(noSetup.mortgageHandlingFee) + nn(noSetup.mortgageShippingCost));

  const cost =
    checks * nn(noSetup.checkDepositCost) +
    disbursements * achShare * nn(noSetup.achCost) +
    disbursements * (1 - achShare) * nn(noSetup.instantCost) +
    checks * nn(noSetup.ocrCost) +
    mortgageChecks * nn(noSetup.mortgageShippingCost) +
    nn(noSetup.kycPerTenantMonthly) +
    nn(noSetup.walletPerTenantMonthly) +
    nn(noSetup.supportPerTenantMonthly);

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

/** Smallest whole check count where ChecksOps becomes cheaper than iink. */
export function findBreakEvenChecks(i: ComparisonInputs): number | null {
  for (let n = 1; n <= 2000; n++) {
    const r = compareCosts(i, n);
    if (r.monthlySavings > 0) return n;
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
