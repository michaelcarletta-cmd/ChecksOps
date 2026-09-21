export const PAYOUT_UX_STAGES = [
  "funding_required",
  "funding_pending",
  "funds_available",
  "ready_to_send",
  "payment_pending",
  "payment_completed",
] as const;

export type PayoutUxStage = (typeof PAYOUT_UX_STAGES)[number];

export const PAYOUT_UX_LABEL: Record<PayoutUxStage, string> = {
  funding_required: "Funding required",
  funding_pending: "Funding pending",
  funds_available: "Funds available",
  ready_to_send: "Ready to send",
  payment_pending: "Payment pending",
  payment_completed: "Payment completed",
};

export const PAYMENT_STATUS_LABEL: Record<PayoutUxStage, string> = {
  funding_required: "Funding",
  funding_pending: "Waiting for funds",
  funds_available: "Ready to send",
  ready_to_send: "Ready to send",
  payment_pending: "Sending",
  payment_completed: "Completed",
};

export type PayoutOrchestratorUx = {
  payout_requested: number;
  wallet_available: number;
  funding_required: number;
  funding_source: string;
  recipient: string;
  recipient_name?: string;
  stage: PayoutUxStage;
  stage_label: string;
  actions: {
    prepare_funding: boolean;
    prepare_payout: boolean;
    submit_funding: boolean;
    submit_payout: boolean;
    both_enabled: boolean;
  };
};

export type PayoutOrchestratorPlan = {
  ok?: boolean;
  environment?: "sandbox" | "production";
  decision: "FUND_FIRST" | "PAYOUT_READY";
  payout_cents: number;
  available_cents: number;
  shortfall_cents: number;
  funding_state: string | null;
  payout_state: string;
  ux_stage: PayoutUxStage;
  ux_label: string;
  payout_submittable: boolean;
  liveProviderPosted?: boolean;
  createdPaymentTransfer?: boolean;
  persistMoneyIntents?: boolean;
  totp_consumed?: boolean;
  ux: PayoutOrchestratorUx;
};

export const exclusivePayoutActions = (stage: PayoutUxStage) => {
  const prepare_funding = stage === "funding_required";
  const prepare_payout = stage === "ready_to_send" || stage === "funds_available";
  return {
    prepare_funding: prepare_funding && !prepare_payout,
    prepare_payout: prepare_payout && !prepare_funding,
    submit_funding: false,
    submit_payout: false,
    both_enabled: false,
  };
};

export const moneyCents = (cents: number) =>
  (Number(cents || 0) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
