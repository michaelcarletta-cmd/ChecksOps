/**
 * ChecksOps workflow / transaction-mix model — ANALYSIS AND PRESENTATION ONLY.
 *
 * Why this exists: a flat "cost per check" overstates what a tenant actually
 * pays us, because ChecksOps plays several different roles in the payment flow:
 *
 *   processor  — we process the insurance check AND disburse the funds
 *   disburser  — we only move money out (no check processing component)
 *   recipient  — the tenant receives funds someone else disbursed
 *
 * The mix is entered as SIMPLE MONTHLY COUNTS — no percentages:
 *
 *   checks per month          — insurance checks we process
 *   same-day payouts / month  — ACH payouts sent same-day
 *   next-day payouts / month  — ACH payouts sent next-day
 *   received funds / month    — jobs where the tenant only receives money
 *   RTP / month               — instant payouts
 *   wallet transfers / month  — internal wallet moves
 *
 * A processed check carries the per-check fee plus its ACH payouts. A
 * receive-funds-only job carries no check-processing component at all. The
 * primary metric is EFFECTIVE COST PER JOB / TRANSACTION, built from the
 * components each workflow actually consumes.
 *
 * Every rate below is supplied by the caller and is editable in the UI. Nothing
 * here reads or writes live billing.
 */

export type WorkflowKey = "check_ach" | "receive_only" | "wallet_transfer" | "rtp";

export interface WorkflowMeta {
  key: WorkflowKey;
  label: string;
  description: string;
  /** Does this workflow consume the check-processing component? */
  processesCheck: boolean;
}

export const WORKFLOW_META: WorkflowMeta[] = [
  {
    key: "check_ach",
    label: "Processed checks",
    description: "We process the insurance check and disburse the funds by ACH.",
    processesCheck: true,
  },
  {
    key: "receive_only",
    label: "Receive funds only",
    description: "Tenant receives funds — no check processing component at all.",
    processesCheck: false,
  },
  {
    key: "wallet_transfer",
    label: "Wallet / internal transfer",
    description: "Money moved inside the platform wallet. No check, no rail fee.",
    processesCheck: false,
  },
  {
    key: "rtp",
    label: "RTP / instant payment",
    description: "Instant payout with no check-processing component.",
    processesCheck: false,
  },
];

/* ------------------------------------------------------------------ */
/* Mix inputs — plain monthly counts, no percentages                   */
/* ------------------------------------------------------------------ */

export interface WorkflowMix {
  /** Processed checks per month (per tenant in the P&L model). */
  checksPerMonth: number;
  /** Same-day ACH payouts per month. */
  sameDayPayoutsPerMonth: number;
  /** Next-day ACH payouts per month. */
  nextDayPayoutsPerMonth: number;
  /** Receive-funds-only transactions per month (no check component). */
  receiveOnlyPerMonth: number;
  /** Instant RTP transfers per month. */
  rtpPerMonth: number;
  /** Wallet / internal transfers per month. */
  walletPerMonth: number;
}

export const DEFAULT_WORKFLOW_MIX: WorkflowMix = {
  checksPerMonth: 40,
  sameDayPayoutsPerMonth: 20,
  nextDayPayoutsPerMonth: 60,
  receiveOnlyPerMonth: 30,
  rtpPerMonth: 10,
  walletPerMonth: 5,
};

const nn = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);

export interface WorkflowVolumes {
  jobs: number;
  jobsByWorkflow: Record<WorkflowKey, number>;
  /** Checks actually processed. */
  checks: number;
  achPayouts: number;
  sameDay: number;
  nextDay: number;
  receiveOnly: number;
  rtpTransfers: number;
  walletTransfers: number;
}

/**
 * Volumes for the mix, optionally scaled by a multiplier (used by the
 * volume-sensitivity sweeps, which pin the processed-check count and scale
 * every other count with it).
 */
export function workflowVolumes(m: WorkflowMix, scale = 1): WorkflowVolumes {
  const k = nn(scale) || 0;
  const checks = nn(m.checksPerMonth) * k;
  const sameDay = nn(m.sameDayPayoutsPerMonth) * k;
  const nextDay = nn(m.nextDayPayoutsPerMonth) * k;
  const receiveOnly = nn(m.receiveOnlyPerMonth) * k;
  const rtpTransfers = nn(m.rtpPerMonth) * k;
  const walletTransfers = nn(m.walletPerMonth) * k;

  const jobsByWorkflow: Record<WorkflowKey, number> = {
    check_ach: checks,
    receive_only: receiveOnly,
    wallet_transfer: walletTransfers,
    rtp: rtpTransfers,
  };

  return {
    jobs: checks + receiveOnly + rtpTransfers + walletTransfers,
    jobsByWorkflow,
    checks,
    achPayouts: sameDay + nextDay,
    sameDay,
    nextDay,
    receiveOnly,
    rtpTransfers,
    walletTransfers,
  };
}

/** Checks per month implied by the mix. */
export const mixChecksPerMonth = (m: WorkflowMix) => workflowVolumes(m).checks;

/**
 * Volumes when a sweep pins the PROCESSED CHECK count (the iink comparison and
 * the volume sensitivity tables both sweep on checks). Every other count
 * scales proportionally so the shape of the book stays the same.
 */
export function workflowVolumesForChecks(m: WorkflowMix, checks: number): WorkflowVolumes {
  const base = mixChecksPerMonth(m);
  if (base <= 0) return workflowVolumes(m);
  return workflowVolumes(m, nn(checks) / base);
}

/** Share of monthly jobs for each workflow, 0–1. */
export function workflowShares(m: WorkflowMix): Record<WorkflowKey, number> {
  const v = workflowVolumes(m);
  const total = v.jobs;
  const share = (n: number) => (total > 0 ? n / total : 0);
  return {
    check_ach: share(v.jobsByWorkflow.check_ach),
    receive_only: share(v.jobsByWorkflow.receive_only),
    wallet_transfer: share(v.jobsByWorkflow.wallet_transfer),
    rtp: share(v.jobsByWorkflow.rtp),
  };
}

/* ------------------------------------------------------------------ */
/* Per-workflow unit economics                                         */
/* ------------------------------------------------------------------ */

/** What we charge. */
export interface WorkflowPriceRates {
  perCheckFee: number;
  sameDayFee: number;
  nextDayFee: number;
  rtpPct: number;
  rtpCap: number;
  walletFee: number;
  avgRtpAmount: number;
}

/** What it costs us. */
export interface WorkflowCostRates {
  depositCostPerCheck: number;
  sameDayCost: number;
  nextDayCost: number;
  rtpCostPerTransfer: number;
  walletCost: number;
}

export interface WorkflowComponents {
  key: WorkflowKey;
  label: string;
  description: string;
  /** Share of monthly jobs, 0–1. */
  share: number;
  jobs: number;
  /** ACH payouts on one job of this type. */
  achPerJob: number;
  checkProcessing: number;
  ach: number;
  rtp: number;
  wallet: number;
  /** Total for one job of this workflow. */
  total: number;
}

/** Payout-weighted average ACH fee across the same-day / next-day counts. */
const blendedAch = (sameDayFee: number, nextDayFee: number, m: WorkflowMix) => {
  const sd = nn(m.sameDayPayoutsPerMonth);
  const nd = nn(m.nextDayPayoutsPerMonth);
  const total = sd + nd;
  if (total <= 0) return nn(nextDayFee);
  return (sd * nn(sameDayFee) + nd * nn(nextDayFee)) / total;
};

/** Average ACH payouts per processed check. */
const achPerCheckJob = (m: WorkflowMix) => {
  const checks = nn(m.checksPerMonth);
  return checks > 0 ? (nn(m.sameDayPayoutsPerMonth) + nn(m.nextDayPayoutsPerMonth)) / checks : 0;
};

function buildComponents(
  m: WorkflowMix,
  unit: { check: number; ach: number; rtp: number; wallet: number },
  scale?: number,
): WorkflowComponents[] {
  const v = workflowVolumes(m, scale);
  const s = workflowShares(m);
  const achPerJob = achPerCheckJob(m);

  return WORKFLOW_META.map((meta) => {
    const checkProcessing = meta.processesCheck ? unit.check : 0;
    const ach = meta.key === "check_ach" ? achPerJob * unit.ach : 0;
    const rtp = meta.key === "rtp" ? unit.rtp : 0;
    const wallet = meta.key === "wallet_transfer" ? unit.wallet : 0;
    return {
      key: meta.key,
      label: meta.label,
      description: meta.description,
      share: s[meta.key],
      jobs: v.jobsByWorkflow[meta.key],
      achPerJob: meta.key === "check_ach" ? achPerJob : 0,
      checkProcessing,
      ach,
      rtp,
      wallet,
      total: checkProcessing + ach + rtp + wallet,
    };
  });
}

/** Price components for a single job of each workflow. */
export function workflowPriceComponents(
  m: WorkflowMix,
  r: WorkflowPriceRates,
  scale?: number,
): WorkflowComponents[] {
  return buildComponents(
    m,
    {
      check: nn(r.perCheckFee),
      ach: blendedAch(r.sameDayFee, r.nextDayFee, m),
      rtp: Math.min(nn(r.rtpCap), nn(r.avgRtpAmount) * (nn(r.rtpPct) / 100)),
      wallet: nn(r.walletFee),
    },
    scale,
  );
}

/** Variable provider cost for a single job of each workflow. */
export function workflowCostComponents(
  m: WorkflowMix,
  c: WorkflowCostRates,
  scale?: number,
): WorkflowComponents[] {
  return buildComponents(
    m,
    {
      check: nn(c.depositCostPerCheck),
      ach: blendedAch(c.sameDayCost, c.nextDayCost, m),
      rtp: nn(c.rtpCostPerTransfer),
      wallet: nn(c.walletCost),
    },
    scale,
  );
}

/** Share-weighted average across the mix — the headline "per job" number. */
export const weightedPerJob = (rows: WorkflowComponents[]) =>
  rows.reduce((a, row) => a + row.share * row.total, 0);

export const COST_PER_JOB_NOTE =
  "Cost per check is not the right comparison on its own — ChecksOps can be the check processor, the disburser, or only the recipient of funds. Receive-funds-only and wallet jobs carry no check-processing component, so the primary metric here is effective cost per job / transaction.";
