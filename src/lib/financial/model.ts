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
    // Setup fee is one-time: month 1 bills the whole existing base, later months
    // only bill the tenants added that month.
    const setupThisMonth =
      m === 1 ? tenants * nn(a.setupFee) : nn(netNewTenantsPerMonth) * nn(a.setupFee);
    const revenue = r.recurringRevenue + setupThisMonth;
    const cost = r.variableCost + r.fixedOverhead;
    const grossProfit = revenue - r.variableCost;
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

/**
 * iink published pricing (iink.com/pricing, monthly term). Each plan is a flat
 * monthly fee that includes a set number of check submissions; anything beyond
 * that is charged per additional check. Checks with a mortgage-company payee
 * carry a capped 1% fee on the check amount.
 */
export type IinkPlanKey = "starter" | "essentials" | "professional" | "premier";

export interface IinkPlan {
  key: IinkPlanKey;
  label: string;
  monthlyFee: number;
  includedChecks: number;
  overageFee: number;
}

export const IINK_PLANS: IinkPlan[] = [
  { key: "starter", label: "Starter — $45 / 2 checks", monthlyFee: 45, includedChecks: 2, overageFee: 22.5 },
  { key: "essentials", label: "Essentials — $96 / 8 checks", monthlyFee: 96, includedChecks: 8, overageFee: 12 },
  { key: "professional", label: "Professional — $225 / 25 checks", monthlyFee: 225, includedChecks: 25, overageFee: 9 },
  { key: "premier", label: "Premier — $375 / 50 checks", monthlyFee: 375, includedChecks: 50, overageFee: 7.5 },
];

/** Cheapest published iink plan for a given monthly check volume. */
export function bestIinkPlan(checks: number): IinkPlan {
  let best = IINK_PLANS[0];
  let bestCost = Infinity;
  for (const p of IINK_PLANS) {
    const cost = p.monthlyFee + Math.max(0, checks - p.includedChecks) * p.overageFee;
    if (cost < bestCost) {
      bestCost = cost;
      best = p;
    }
  }
  return best;
}

export interface ComparisonInputs {
  checksPerMonth: number;
  disbursementsPerCheck: number;
  mortgageChecksPerMonth: number; // checks requiring mortgage-company endorsement handling
  avgCheckAmount: number; // drives iink's capped 1% mortgage-payee fee

  // ChecksOps pricing
  coMonthlyFee: number;
  coPerCheckFee: number;
  coSameDayDisbursementFee: number;
  coNextDayDisbursementFee: number;
  coSameDayMixPct: number; // share of disbursements sent same day; remainder next day
  coMortgageFee: number; // MortgageOps handling per mortgage check (pass-through)
  coReferrals: number; // active referrals — $5 off each, capped
  coReferralCreditPerReferral: number;
  coReferralCreditCap: number;
  coSetupFee: number; // one-time onboarding / implementation fee


  // iink pricing (iink.com/pricing)
  iinkPlan: IinkPlanKey | "auto";
  iinkMonthlyFee: number;
  iinkIncludedChecks: number;
  iinkOverageFee: number; // charged only on checks above the included allowance
  iinkMortgageFeePct: number; // 1% of the check amount
  iinkMortgageFeeCap: number; // per-check cap on that 1% fee
}

export const DEFAULT_COMPARISON: ComparisonInputs = {
  checksPerMonth: 50,
  disbursementsPerCheck: 2,
  mortgageChecksPerMonth: 10,
  avgCheckAmount: 25000,

  coMonthlyFee: 100,
  coPerCheckFee: 4,
  coSameDayDisbursementFee: 1,
  coNextDayDisbursementFee: 0.75,
  coSameDayMixPct: 50,
  coMortgageFee: 10,
  coReferrals: 0,
  coReferralCreditPerReferral: 5,
  coReferralCreditCap: 25,
  coSetupFee: 7500,


  iinkPlan: "auto",
  iinkMonthlyFee: 375,
  iinkIncludedChecks: 50,
  iinkOverageFee: 7.5,
  iinkMortgageFeePct: 1,
  iinkMortgageFeeCap: 299,
};

export interface SideCost {
  monthlyFee: number;
  perCheck: number;
  perDisbursement: number;
  mortgageFee: number;
  referralCredit: number; // negative-going discount, stored positive
  total: number;
  costPerCheck: number;
}

export interface ComparisonResult {
  disbursements: number;
  checksOps: SideCost;
  iink: SideCost;
  iinkPlan: IinkPlan;
  iinkOverageChecks: number;
  monthlySavings: number;
  annualSavings: number;
  savingsPct: number;
  breakEvenChecks: number | null;
}

function sideTotals(
  parts: Omit<SideCost, "total" | "costPerCheck">,
  checks: number,
): SideCost {
  const total = Math.max(
    0,
    parts.monthlyFee + parts.perCheck + parts.perDisbursement + parts.mortgageFee - parts.referralCredit,
  );
  return { ...parts, total, costPerCheck: checks > 0 ? total / checks : 0 };
}

/** Referral credit applied to the ChecksOps monthly fee ($5 each, capped, never more than the fee). */
export function referralCredit(i: ComparisonInputs): number {
  return Math.min(
    nn(i.coMonthlyFee),
    nn(i.coReferralCreditCap),
    nn(i.coReferrals) * nn(i.coReferralCreditPerReferral),
  );
}

/** Blended ChecksOps price per disbursement across same-day / next-day. */
function coDisbursementFee(i: ComparisonInputs): number {
  const sameDay = clampPct(i.coSameDayMixPct) / 100;
  return sameDay * nn(i.coSameDayDisbursementFee) + (1 - sameDay) * nn(i.coNextDayDisbursementFee);
}

/** Resolve the iink plan in play — either the picked plan or the cheapest for the volume. */
export function resolveIinkPlan(i: ComparisonInputs, checks: number): IinkPlan {
  if (i.iinkPlan === "auto") return bestIinkPlan(checks);
  const found = IINK_PLANS.find((p) => p.key === i.iinkPlan);
  if (found) return found;
  return {
    key: "premier",
    label: "Custom",
    monthlyFee: nn(i.iinkMonthlyFee),
    includedChecks: nn(i.iinkIncludedChecks),
    overageFee: nn(i.iinkOverageFee),
  };
}

/** iink's capped 1% fee on checks with a mortgage-company payee. */
function iinkMortgageCost(i: ComparisonInputs, mortgageChecks: number): number {
  const perCheck = Math.min(
    nn(i.iinkMortgageFeeCap),
    nn(i.avgCheckAmount) * (nn(i.iinkMortgageFeePct) / 100),
  );
  return mortgageChecks * perCheck;
}

function iinkSide(i: ComparisonInputs, checks: number, mortgageChecks: number) {
  const plan = resolveIinkPlan(i, checks);
  const overageChecks = Math.max(0, checks - nn(plan.includedChecks));
  return {
    plan,
    overageChecks,
    monthlyFee: nn(plan.monthlyFee),
    perCheck: overageChecks * nn(plan.overageFee),
    mortgageFee: iinkMortgageCost(i, mortgageChecks),
  };
}

export function compareCosts(i: ComparisonInputs, checksOverride?: number): ComparisonResult {
  const checks = nn(checksOverride ?? i.checksPerMonth);
  const disbursements = checks * nn(i.disbursementsPerCheck);
  // Scale mortgage checks with volume when sweeping the sensitivity table.
  const mortgageChecks =
    checksOverride !== undefined && nn(i.checksPerMonth) > 0
      ? (nn(i.mortgageChecksPerMonth) / nn(i.checksPerMonth)) * checks
      : nn(i.mortgageChecksPerMonth);

  const checksOps = sideTotals(
    {
      monthlyFee: nn(i.coMonthlyFee),
      perCheck: checks * nn(i.coPerCheckFee),
      perDisbursement: disbursements * coDisbursementFee(i),
      mortgageFee: mortgageChecks * nn(i.coMortgageFee),
      referralCredit: referralCredit(i),
    },
    checks,
  );

  const ii = iinkSide(i, checks, mortgageChecks);
  const iink = sideTotals(
    {
      monthlyFee: ii.monthlyFee,
      perCheck: ii.perCheck,
      perDisbursement: 0,
      mortgageFee: ii.mortgageFee,
      referralCredit: 0,
    },
    checks,
  );

  const monthlySavings = iink.total - checksOps.total;

  return {
    disbursements,
    checksOps,
    iink,
    iinkPlan: ii.plan,
    iinkOverageChecks: ii.overageChecks,
    monthlySavings,
    annualSavings: monthlySavings * 12,
    savingsPct: iink.total > 0 ? (monthlySavings / iink.total) * 100 : 0,
    breakEvenChecks: findBreakEvenChecks(i),
  };
}

/** Monthly savings at a given check count, without recursing into break-even search. */
function savingsAt(i: ComparisonInputs, checks: number): number {
  const disbursements = checks * nn(i.disbursementsPerCheck);
  const mortgageChecks =
    nn(i.checksPerMonth) > 0 ? (nn(i.mortgageChecksPerMonth) / nn(i.checksPerMonth)) * checks : 0;

  const co = Math.max(
    0,
    nn(i.coMonthlyFee) +
      checks * nn(i.coPerCheckFee) +
      disbursements * coDisbursementFee(i) +
      mortgageChecks * nn(i.coMortgageFee) -
      referralCredit(i),
  );

  const s = iinkSide(i, checks, mortgageChecks);
  return s.monthlyFee + s.perCheck + s.mortgageFee - co;
}

/** Smallest whole check count where ChecksOps becomes cheaper than iink. */
export function findBreakEvenChecks(i: ComparisonInputs): number | null {
  for (let n = 1; n <= 2000; n++) {
    if (savingsAt(i, n) > 0) return n;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Setup-fee payback (one-time $7,500 vs iink's ongoing subscription)  */
/* ------------------------------------------------------------------ */

export interface PaybackRow {
  month: number;
  label: string;
  checksOpsCumulative: number; // includes the one-time setup fee in month 1
  iinkCumulative: number;
  cumulativeSavings: number;
}

export interface PaybackResult {
  setupFee: number;
  monthlySavings: number;
  rows: PaybackRow[];
  /** First month where cumulative ChecksOps spend (incl. setup) drops below iink. */
  paybackMonth: number | null;
  /** Cumulative savings at month 24, net of the setup fee. */
  twoYearNetSavings: number;
}

export function computePayback(i: ComparisonInputs, months = 24): PaybackResult {
  const r = compareCosts(i);
  const setupFee = nn(i.coSetupFee);
  const rows: PaybackRow[] = [];
  let co = setupFee;
  let ii = 0;
  let paybackMonth: number | null = null;

  for (let m = 1; m <= months; m++) {
    co += r.checksOps.total;
    ii += r.iink.total;
    const cumulativeSavings = ii - co;
    if (paybackMonth === null && cumulativeSavings >= 0) paybackMonth = m;
    rows.push({ month: m, label: `M${m}`, checksOpsCumulative: co, iinkCumulative: ii, cumulativeSavings });
  }

  return {
    setupFee,
    monthlySavings: r.monthlySavings,
    rows,
    paybackMonth,
    twoYearNetSavings: rows.length ? rows[rows.length - 1].cumulativeSavings : -setupFee,
  };
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
