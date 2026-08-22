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
 * A job that is "check processed + 1 ACH" carries the per-check fee plus one
 * disbursement fee. A receive-funds-only job carries no check-processing
 * component at all. Averaging every transaction against the check count makes
 * recipient-heavy tenants look far more expensive than they are, and understates
 * our gross margin on them.
 *
 * The primary metric is therefore EFFECTIVE COST PER JOB / TRANSACTION, built
 * from the components each workflow actually consumes.
 *
 * Every rate below is supplied by the caller and is editable in the UI. Nothing
 * here reads or writes live billing.
 */

export type WorkflowKey =
  | "check_ach_single"
  | "check_ach_multi"
  | "receive_only"
  | "wallet_transfer"
  | "rtp";

export interface WorkflowMeta {
  key: WorkflowKey;
  label: string;
  description: string;
  /** Does this workflow consume the check-processing component? */
  processesCheck: boolean;
}

export const WORKFLOW_META: WorkflowMeta[] = [
  {
    key: "check_ach_single",
    label: "Check processed + 1 ACH",
    description: "We process the insurance check and send one ACH disbursement.",
    processesCheck: true,
  },
  {
    key: "check_ach_multi",
    label: "Check processed + multiple ACH",
    description: "One processed check split across several ACH disbursements.",
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
/* Mix inputs                                                          */
/* ------------------------------------------------------------------ */

export interface WorkflowMix {
  /** When false, the caller's legacy explicit check / ACH / RTP counts are used. */
  useWorkflowMix: boolean;
  /** Total jobs / transactions per month across every workflow. */
  jobsPerMonth: number;

  /** Share of jobs, %. Normalised if they do not sum to 100. */
  pctCheckAchSingle: number;
  pctCheckAchMulti: number;
  pctReceiveOnly: number;
  pctWalletTransfer: number;
  pctRtp: number;

  /** ACH disbursements on a multi-ACH processed-check job. */
  avgAchOnMultiAchJob: number;
  /** Payouts on a receive-funds-only job (often 1, sometimes 0 for pure receipts). */
  avgPayoutsPerReceiveOnlyJob: number;
  /** Share of ACH payouts sent same-day rather than next-day, %. */
  pctPayoutsSameDay: number;
}

export const DEFAULT_WORKFLOW_MIX: WorkflowMix = {
  useWorkflowMix: true,
  jobsPerMonth: 100,
  pctCheckAchSingle: 40,
  pctCheckAchMulti: 10,
  pctReceiveOnly: 35,
  pctWalletTransfer: 5,
  pctRtp: 10,
  avgAchOnMultiAchJob: 3,
  avgPayoutsPerReceiveOnlyJob: 1,
  pctPayoutsSameDay: 25,
};

const nn = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);

/** Workflow shares as fractions of 1, normalised so they always sum to 1 (or all 0). */
export function workflowShares(m: WorkflowMix): Record<WorkflowKey, number> {
  const raw: Record<WorkflowKey, number> = {
    check_ach_single: nn(m.pctCheckAchSingle),
    check_ach_multi: nn(m.pctCheckAchMulti),
    receive_only: nn(m.pctReceiveOnly),
    wallet_transfer: nn(m.pctWalletTransfer),
    rtp: nn(m.pctRtp),
  };
  const total = Object.values(raw).reduce((a, b) => a + b, 0);
  if (total <= 0) {
    return { check_ach_single: 0, check_ach_multi: 0, receive_only: 0, wallet_transfer: 0, rtp: 0 };
  }
  return {
    check_ach_single: raw.check_ach_single / total,
    check_ach_multi: raw.check_ach_multi / total,
    receive_only: raw.receive_only / total,
    wallet_transfer: raw.wallet_transfer / total,
    rtp: raw.rtp / total,
  };
}

export interface WorkflowVolumes {
  jobs: number;
  jobsByWorkflow: Record<WorkflowKey, number>;
  /** Checks actually processed — only the two processed-check workflows. */
  checks: number;
  achPayouts: number;
  sameDay: number;
  nextDay: number;
  rtpTransfers: number;
  walletTransfers: number;
}

/** Volumes for an explicit job count (defaults to the mix's own jobsPerMonth). */
export function workflowVolumes(m: WorkflowMix, jobsOverride?: number): WorkflowVolumes {
  const jobs = nn(jobsOverride ?? m.jobsPerMonth);
  const s = workflowShares(m);
  const jobsByWorkflow: Record<WorkflowKey, number> = {
    check_ach_single: jobs * s.check_ach_single,
    check_ach_multi: jobs * s.check_ach_multi,
    receive_only: jobs * s.receive_only,
    wallet_transfer: jobs * s.wallet_transfer,
    rtp: jobs * s.rtp,
  };

  const checks = jobsByWorkflow.check_ach_single + jobsByWorkflow.check_ach_multi;
  const achPayouts =
    jobsByWorkflow.check_ach_single * 1 +
    jobsByWorkflow.check_ach_multi * nn(m.avgAchOnMultiAchJob) +
    jobsByWorkflow.receive_only * nn(m.avgPayoutsPerReceiveOnlyJob);

  const sameDayShare = Math.min(100, nn(m.pctPayoutsSameDay)) / 100;
  return {
    jobs,
    jobsByWorkflow,
    checks,
    achPayouts,
    sameDay: achPayouts * sameDayShare,
    nextDay: achPayouts * (1 - sameDayShare),
    rtpTransfers: jobsByWorkflow.rtp,
    walletTransfers: jobsByWorkflow.wallet_transfer,
  };
}

/** Checks per month implied by the mix at its own job volume. */
export const mixChecksPerMonth = (m: WorkflowMix) => workflowVolumes(m).checks;

/**
 * Volumes when a sweep pins the PROCESSED CHECK count (the iink comparison and
 * the volume sensitivity tables both sweep on checks). Jobs scale with checks so
 * the receive-only / wallet / RTP tail keeps its share of the book.
 */
export function workflowVolumesForChecks(m: WorkflowMix, checks: number): WorkflowVolumes {
  const base = mixChecksPerMonth(m);
  if (base <= 0) {
    // No processed-check workflows configured — the sweep cannot scale on checks.
    return workflowVolumes(m);
  }
  return workflowVolumes(m, nn(m.jobsPerMonth) * (nn(checks) / base));
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

const blendedAch = (r: WorkflowPriceRates, m: WorkflowMix) => {
  const sd = Math.min(100, nn(m.pctPayoutsSameDay)) / 100;
  return sd * nn(r.sameDayFee) + (1 - sd) * nn(r.nextDayFee);
};

const blendedAchCost = (c: WorkflowCostRates, m: WorkflowMix) => {
  const sd = Math.min(100, nn(m.pctPayoutsSameDay)) / 100;
  return sd * nn(c.sameDayCost) + (1 - sd) * nn(c.nextDayCost);
};

const achPerJobFor = (key: WorkflowKey, m: WorkflowMix) => {
  if (key === "check_ach_single") return 1;
  if (key === "check_ach_multi") return nn(m.avgAchOnMultiAchJob);
  if (key === "receive_only") return nn(m.avgPayoutsPerReceiveOnlyJob);
  return 0;
};

/** Price components for a single job of each workflow. */
export function workflowPriceComponents(
  m: WorkflowMix,
  r: WorkflowPriceRates,
  jobsOverride?: number,
): WorkflowComponents[] {
  const v = workflowVolumes(m, jobsOverride);
  const s = workflowShares(m);
  const achUnit = blendedAch(r, m);
  const rtpUnit = Math.min(nn(r.rtpCap), nn(r.avgRtpAmount) * (nn(r.rtpPct) / 100));

  return WORKFLOW_META.map((meta) => {
    const achPerJob = achPerJobFor(meta.key, m);
    const checkProcessing = meta.processesCheck ? nn(r.perCheckFee) : 0;
    const ach = achPerJob * achUnit;
    const rtp = meta.key === "rtp" ? rtpUnit : 0;
    const wallet = meta.key === "wallet_transfer" ? nn(r.walletFee) : 0;
    return {
      key: meta.key,
      label: meta.label,
      description: meta.description,
      share: s[meta.key],
      jobs: v.jobsByWorkflow[meta.key],
      achPerJob,
      checkProcessing,
      ach,
      rtp,
      wallet,
      total: checkProcessing + ach + rtp + wallet,
    };
  });
}

/** Variable provider cost for a single job of each workflow. */
export function workflowCostComponents(
  m: WorkflowMix,
  c: WorkflowCostRates,
  jobsOverride?: number,
): WorkflowComponents[] {
  const v = workflowVolumes(m, jobsOverride);
  const s = workflowShares(m);
  const achUnit = blendedAchCost(c, m);

  return WORKFLOW_META.map((meta) => {
    const achPerJob = achPerJobFor(meta.key, m);
    const checkProcessing = meta.processesCheck ? nn(c.depositCostPerCheck) : 0;
    const ach = achPerJob * achUnit;
    const rtp = meta.key === "rtp" ? nn(c.rtpCostPerTransfer) : 0;
    const wallet = meta.key === "wallet_transfer" ? nn(c.walletCost) : 0;
    return {
      key: meta.key,
      label: meta.label,
      description: meta.description,
      share: s[meta.key],
      jobs: v.jobsByWorkflow[meta.key],
      achPerJob,
      checkProcessing,
      ach,
      rtp,
      wallet,
      total: checkProcessing + ach + rtp + wallet,
    };
  });
}

/** Share-weighted average across the mix — the headline "per job" number. */
export const weightedPerJob = (rows: WorkflowComponents[]) =>
  rows.reduce((a, row) => a + row.share * row.total, 0);

export const COST_PER_JOB_NOTE =
  "Cost per check is not the right comparison on its own — ChecksOps can be the check processor, the disburser, or only the recipient of funds. Receive-funds-only and wallet jobs carry no check-processing component, so the primary metric here is effective cost per job / transaction.";
