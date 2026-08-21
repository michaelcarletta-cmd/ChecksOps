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
 *
 * MortgageOps handling is billed at cost (pass-through) and therefore does not
 * appear in the P&L model; it only shows up in the client savings comparison.
 *
 * Every value is editable in the UI. Confirm against the current
 * Moov / CheckAlt / bank contracts before quoting.
 */

export interface PnlAssumptions {
  // Volume
  tenants: number;
  checksPerTenantPerMonth: number;
  /** Same-day disbursements per tenant per month — billed at the $1.00 rate. */
  sameDayDisbursementsPerTenant: number;
  /** Next-day disbursements per tenant per month — billed at the $0.75 rate. */
  nextDayDisbursementsPerTenant: number;

  // Revenue (charged to tenant)
  perCheckFee: number;
  disbursementFeeHigh: number; // $1.00 — same day
  disbursementFeeLow: number; // $0.75 — next day
  monthlyMaintenanceFee: number;
  setupFee: number;
  newTenantsPerMonth: number;

  // Cost structure
  checkDepositCost: number; // CheckAlt / RDC per check
  nextDayDisbursementCost: number;
  sameDayDisbursementCost: number;
  walletPerTenantMonthly: number;

  // Fixed overhead (monthly)
  checkAltMonthlyFee: number;
  moovMonthlyMinimumFee: number;

  // One-time onboarding cost, charged per tenant (not monthly)
  kybKycSetupCost: number;
  checkAltOnboardingFee: number;
}

export const DEFAULT_PNL: PnlAssumptions = {
  tenants: 5,
  checksPerTenantPerMonth: 40,
  sameDayDisbursementsPerTenant: 20,
  nextDayDisbursementsPerTenant: 60,

  perCheckFee: 4,
  disbursementFeeHigh: 1,
  disbursementFeeLow: 0.75,
  monthlyMaintenanceFee: 100,
  setupFee: 7500,
  newTenantsPerMonth: 1,

  checkDepositCost: 0.68,
  nextDayDisbursementCost: 0.5,
  sameDayDisbursementCost: 1,
  walletPerTenantMonthly: 0,

  checkAltMonthlyFee: 0,
  moovMonthlyMinimumFee: 0,
  kybKycSetupCost: 0,
  checkAltOnboardingFee: 0,
};

export interface PnlResult {
  checks: number;
  disbursements: number;
  sameDayDisbursements: number;
  nextDayDisbursements: number;
  sameDayRevenue: number;
  nextDayRevenue: number;
  sameDayCost: number;
  nextDayCost: number;

  maintenanceRevenue: number;
  perCheckRevenue: number;
  disbursementRevenue: number;
  setupRevenue: number;
  /** One-time setup fee billed across the entire tenant base (tenants x setup fee). */
  setupRevenueAllTenants: number;
  grossRevenue: number;
  /** Recurring gross revenue only — excludes the one-time setup fee. */
  recurringRevenue: number;

  depositCost: number;
  disbursementCost: number;
  walletCost: number;
  variableCost: number;
  /** One-time KYB/KYC + CheckAlt onboarding cost for a single tenant. */
  onboardingCostPerTenant: number;
  /** One-time onboarding cost across the whole tenant base. */
  onboardingCostAllTenants: number;

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

export function computePnl(a: PnlAssumptions, tenantOverride?: number): PnlResult {
  const tenants = nn(tenantOverride ?? a.tenants);
  const checks = tenants * nn(a.checksPerTenantPerMonth);
  const sameDayDisbursements = tenants * nn(a.sameDayDisbursementsPerTenant);
  const nextDayDisbursements = tenants * nn(a.nextDayDisbursementsPerTenant);
  const disbursements = sameDayDisbursements + nextDayDisbursements;

  const maintenanceRevenue = tenants * nn(a.monthlyMaintenanceFee);
  const perCheckRevenue = checks * nn(a.perCheckFee);
  const sameDayRevenue = sameDayDisbursements * nn(a.disbursementFeeHigh);
  const nextDayRevenue = nextDayDisbursements * nn(a.disbursementFeeLow);
  const disbursementRevenue = sameDayRevenue + nextDayRevenue;
  // One-time $7,500 setup fee is charged per tenant — every tenant in the base counts.
  const setupRevenueAllTenants = tenants * nn(a.setupFee);
  const setupRevenue = setupRevenueAllTenants;
  const recurringRevenue = maintenanceRevenue + perCheckRevenue + disbursementRevenue;
  const grossRevenue = recurringRevenue + setupRevenueAllTenants;


  const depositCost = checks * nn(a.checkDepositCost);
  const sameDayCost = sameDayDisbursements * nn(a.sameDayDisbursementCost);
  const nextDayCost = nextDayDisbursements * nn(a.nextDayDisbursementCost);
  const disbursementCost = sameDayCost + nextDayCost;
  const walletCost = tenants * nn(a.walletPerTenantMonthly);
  const onboardingCostPerTenant = nn(a.kybKycSetupCost) + nn(a.checkAltOnboardingFee);
  const onboardingCostAllTenants = tenants * onboardingCostPerTenant;
  // One-time onboarding sits alongside the one-time setup revenue it offsets.
  const variableCost = depositCost + disbursementCost + walletCost + onboardingCostAllTenants;

  const grossProfit = grossRevenue - variableCost;
  const fixedOverhead = nn(a.checkAltMonthlyFee) + nn(a.moovMonthlyMinimumFee);
  const netProfit = grossProfit - fixedOverhead;

  const one = computeContributionPerTenant(a);

  return {
    checks,
    disbursements,
    sameDayDisbursements,
    nextDayDisbursements,
    sameDayRevenue,
    nextDayRevenue,
    sameDayCost,
    nextDayCost,
    maintenanceRevenue,
    perCheckRevenue,
    disbursementRevenue,
    setupRevenue,
    setupRevenueAllTenants,
    grossRevenue,
    recurringRevenue,

    depositCost,
    disbursementCost,
    walletCost,
    variableCost,
    onboardingCostPerTenant,
    onboardingCostAllTenants,
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
  const sameDay = nn(a.sameDayDisbursementsPerTenant);
  const nextDay = nn(a.nextDayDisbursementsPerTenant);

  const revenue =
    nn(a.monthlyMaintenanceFee) +
    checks * nn(a.perCheckFee) +
    sameDay * nn(a.disbursementFeeHigh) +
    nextDay * nn(a.disbursementFeeLow);

  const cost =
    checks * nn(a.checkDepositCost) +
    sameDay * nn(a.sameDayDisbursementCost) +
    nextDay * nn(a.nextDayDisbursementCost) +
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
    const r = computePnl(a, tenants);
    // Setup fee and onboarding cost are one-time per tenant: month 1 covers the
    // whole existing base, later months only the tenants added that month.
    const newThisMonth = m === 1 ? tenants : nn(netNewTenantsPerMonth);
    const setupThisMonth = newThisMonth * nn(a.setupFee);
    const onboardingThisMonth = newThisMonth * r.onboardingCostPerTenant;
    const revenue = r.recurringRevenue + setupThisMonth;
    const recurringVariableCost = r.variableCost - r.onboardingCostAllTenants;
    const variable = recurringVariableCost + onboardingThisMonth;
    const cost = variable + r.fixedOverhead;
    const grossProfit = revenue - variable;
    const netProfit = revenue - cost;
    rows.push({
      month: m,
      label: `M${m}`,
      tenants: Math.round(tenants),
      revenue,
      cost,
      grossProfit,
      netProfit,
      netMarginPct: revenue > 0 ? (netProfit / revenue) * 100 : 0,
    });
  }
  return rows;
}


export type ScenarioKey = "low" | "expected" | "high";

export const SCENARIOS: Record<ScenarioKey, { label: string; patch: Partial<PnlAssumptions> }> = {
  low: {
    label: "Low volume",
    patch: {
      tenants: 3,
      checksPerTenantPerMonth: 20,
      sameDayDisbursementsPerTenant: 10,
      nextDayDisbursementsPerTenant: 30,
      newTenantsPerMonth: 0,
    },
  },
  expected: {
    label: "Expected",
    patch: {
      tenants: 10,
      checksPerTenantPerMonth: 40,
      sameDayDisbursementsPerTenant: 20,
      nextDayDisbursementsPerTenant: 60,
      newTenantsPerMonth: 1,
    },
  },
  high: {
    label: "High volume",
    patch: {
      tenants: 30,
      checksPerTenantPerMonth: 100,
      sameDayDisbursementsPerTenant: 60,
      nextDayDisbursementsPerTenant: 240,
      newTenantsPerMonth: 3,
    },
  },
};


// ChecksOps vs iink comparison lives in src/lib/financial/iink.ts


export const money = (v: number, decimals = 0) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(Number.isFinite(v) ? v : 0);

export const pct = (v: number, decimals = 1) =>
  `${(Number.isFinite(v) ? v : 0).toFixed(decimals)}%`;
