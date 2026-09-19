/**
 * Production outgoing-payment sequence for Freedom bank → wallet → recipient.
 *
 * Moov Sweep (live API + docs) is a DAILY treasury job:
 *   transferAmount = availableBalance at sweep close - minimumBalance
 * Push pays excess wallet cash to the configured bank credit method.
 * Pull (ach-debit-fund only) remediates a negative wallet after a one-day
 * grace, or restores the configured minimum on that same daily close.
 * Sweep does NOT fund a specific outgoing payment in real time.
 *
 * Authoritative funding for a ChecksOps disbursement is therefore a single
 * ChecksOps-created BANK→WALLET payment_transfers row (leg_role wallet_funding).
 * Sweep must not be treated as a second funding intent for the same payment.
 */
export const AUTHORITATIVE_DISBURSEMENT_FUNDING = 'checksops_wallet_funding_transfer';
export const SWEEP_ROLE = 'treasury_idle_cash_and_negative_remediation';

export const OUTGOING_PAYMENT_SEQUENCE = Object.freeze({
  case1_wallet_sufficient: Object.freeze({
    id: 'CASE_1',
    when: 'wallet available_cents >= disbursement amount',
    steps: [
      'Do not create a BANK→WALLET funding transfer.',
      'Do not expect Sweep to move funds for this payment.',
      'Create exactly one WALLET→RECIPIENT payment_transfers intent.',
      'POST that intent only when AWS_MOOV_TRANSFER_POST_ENABLED is armed.',
    ],
    fundingMechanism: 'none_wallet_already_funded',
  }),
  case2_wallet_short_bank_has_funds: Object.freeze({
    id: 'CASE_2',
    when: 'wallet available is insufficient; linked bank can cover the shortage',
    steps: [
      'Create exactly one BANK→WALLET wallet_funding intent for the shortage (initiate-wallet-funding).',
      'GET-reconcile that funding row until provider status is completed and wallet available covers the payout.',
      'Only then create the WALLET→RECIPIENT intent.',
      'Do not create a second BANK→WALLET for the same disbursement.',
      'Do not rely on Sweep pull to fund this payment — Sweep is daily, not per-payment.',
    ],
    fundingMechanism: AUTHORITATIVE_DISBURSEMENT_FUNDING,
  }),
  case3_funding_pending: Object.freeze({
    id: 'CASE_3',
    when: 'BANK→WALLET exists but is submitted/pending (ACH not yet available)',
    steps: [
      'Leave the existing funding row as the sole funding intent.',
      'Do not POST another fund transfer (idempotency_key / existing row).',
      'Do not POST WALLET→RECIPIENT until wallet available covers the amount.',
      'Webhook + GET-only moov-transfer-status reconcile the funding row.',
    ],
    fundingMechanism: AUTHORITATIVE_DISBURSEMENT_FUNDING,
  }),
  case4_bank_debit_fails: Object.freeze({
    id: 'CASE_4',
    when: 'BANK→WALLET fails or ACH returns',
    steps: [
      'Mark the existing funding row failed/returned. Do not regress a later terminal state.',
      'Do not auto-retry with a new provider POST from webhook processing.',
      'Do not POST the recipient disbursement.',
      'Operator/retry creates a new funding intent only with a new idempotency key after review.',
    ],
    fundingMechanism: AUTHORITATIVE_DISBURSEMENT_FUNDING,
  }),
  case5_recipient_disbursement_fails: Object.freeze({
    id: 'CASE_5',
    when: 'WALLET→RECIPIENT fails or returns after funding succeeded',
    steps: [
      'Reconcile the disbursement row to failed/returned. Wallet may still hold the funds.',
      'Do not create another BANK→WALLET to "re-fund" the same payment.',
      'Idle cash may later be Sweep-pushed to checking (treasury). That is not a user payout intent.',
    ],
    fundingMechanism: 'none_wallet_already_funded',
  }),
});

export const DOUBLE_FUNDING_PREVENTION = Object.freeze({
  rule: 'one_authoritative_funding_mechanism_per_disbursement',
  checksops: 'wallet_funding_requests / payment_transfers.leg_role=wallet_funding keyed by disbursement/idempotency',
  sweep: 'observe-only; never INSERT payment_transfers for provider-created Sweep transfers',
  forbidden: [
    'Sweep pull AND a manual BANK→WALLET for the same shortage',
    'webhook/GET recon creating a new payment_transfers row',
    'blind retry POST of an already-submitted provider_transfer_id',
  ],
});
