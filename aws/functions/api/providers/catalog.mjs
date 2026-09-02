/**
 * Inventory of provider-dependent Edge Functions and related payment routes.
 * Classes:
 * 1 read/status-only
 * 2 identity/KYC/KYB setup
 * 3 bank/account connection
 * 4 webhook ingestion
 * 5 deposit submission
 * 6 money movement
 * 7 disbursement
 * 8 provider configuration/admin
 * 9 notification side effect
 */

export const OP_CLASS = {
  READ_STATUS: 1,
  IDENTITY_KYC: 2,
  BANK_CONNECTION: 3,
  WEBHOOK: 4,
  DEPOSIT: 5,
  MONEY_MOVEMENT: 6,
  DISBURSEMENT: 7,
  CONFIG_ADMIN: 8,
  NOTIFICATION: 9,
};

const fn = (name, provider, opClass, aws, notes) => ({
  name,
  provider,
  class: opClass,
  aws,
  notes,
});

export const PROVIDER_FUNCTIONS = [
  fn('moov-account-create', 'moov', OP_CLASS.IDENTITY_KYC, 'disabled', 'Creates a real Moov account. Execution left disabled.'),
  fn('moov-account-discover', 'moov', OP_CLASS.READ_STATUS, 'disabled', 'Hits Moov to discover accounts. Live reads stay off.'),
  fn('moov-account-onboard', 'moov', OP_CLASS.IDENTITY_KYC, 'disabled', 'Creates/changes Moov account + capabilities.'),
  fn('moov-account-files', 'moov', OP_CLASS.IDENTITY_KYC, 'disabled', 'Lists/uploads KYC files at Moov.'),
  fn('moov-account-file-upload', 'moov', OP_CLASS.IDENTITY_KYC, 'disabled', 'Uploads KYC documents to Moov.'),
  fn('moov-account-file-view', 'moov', OP_CLASS.READ_STATUS, 'disabled', 'Fetches KYC file bytes from Moov.'),
  fn('moov-onboarding-link', 'moov', OP_CLASS.IDENTITY_KYC, 'disabled', 'Creates hosted onboarding session.'),
  fn('moov-readiness', 'moov', OP_CLASS.READ_STATUS, 'db_status', 'AWS serves local payment_provider_accounts snapshot only.'),
  fn('moov-selftest', 'moov', OP_CLASS.CONFIG_ADMIN, 'disabled', 'Calls Moov with platform credentials.'),
  fn('moov-sync', 'moov', OP_CLASS.IDENTITY_KYC, 'disabled', 'Pulls Moov state and writes local provider rows.'),
  fn('moov-wallet-sync', 'moov', OP_CLASS.MONEY_MOVEMENT, 'disabled', 'Syncs wallet balances from Moov.'),
  fn('moov-wallet-fund', 'moov', OP_CLASS.MONEY_MOVEMENT, 'disabled', 'Creates a real funding transfer.'),
  fn('moov-bank-account-add', 'moov', OP_CLASS.BANK_CONNECTION, 'disabled', 'Adds a bank account at Moov.'),
  fn('moov-bank-link-token', 'moov', OP_CLASS.BANK_CONNECTION, 'disabled', 'Creates a bank-link token.'),
  fn('moov-micro-deposit-initiate', 'moov', OP_CLASS.BANK_CONNECTION, 'disabled', 'Initiates micro-deposits (money movement).'),
  fn('moov-micro-deposit-confirm', 'moov', OP_CLASS.BANK_CONNECTION, 'disabled', 'Confirms micro-deposits.'),
  fn('moov-plaid-bridge', 'moov', OP_CLASS.BANK_CONNECTION, 'disabled', 'Links Plaid items into Moov.'),
  fn('moov-platform-bank', 'moov', OP_CLASS.CONFIG_ADMIN, 'disabled', 'Platform treasury bank admin.'),
  fn('moov-tos-token', 'moov', OP_CLASS.IDENTITY_KYC, 'disabled', 'Creates Platform Agreement / TOS token at Moov.'),
  fn('moov-tos-accept', 'moov', OP_CLASS.IDENTITY_KYC, 'disabled', 'Records TOS acceptance at Moov.'),
  fn('moov-underwriting', 'moov', OP_CLASS.IDENTITY_KYC, 'disabled', 'Submits underwriting answers.'),
  fn('moov-recipient-create', 'moov', OP_CLASS.IDENTITY_KYC, 'disabled', 'Creates stakeholder/recipient Moov account.'),
  fn('moov-recipient-session', 'moov', OP_CLASS.IDENTITY_KYC, 'disabled', 'Hosted recipient onboarding session.'),
  fn('moov-recipient-tos-accept', 'moov', OP_CLASS.IDENTITY_KYC, 'disabled', 'Recipient Platform Agreement.'),
  fn('moov-recipient-kyc-update', 'moov', OP_CLASS.IDENTITY_KYC, 'disabled', 'Mutates recipient KYC at Moov.'),
  fn('moov-recipient-bank-add', 'moov', OP_CLASS.BANK_CONNECTION, 'disabled', 'Adds recipient bank.'),
  fn('moov-recipient-disconnect', 'moov', OP_CLASS.IDENTITY_KYC, 'disabled', 'Disconnects recipient account.'),
  fn('moov-transfer-create', 'moov', OP_CLASS.MONEY_MOVEMENT, 'disabled', 'Creates ACH/RTP/wallet transfer.'),
  fn('moov-transfer-status', 'moov', OP_CLASS.READ_STATUS, 'db_status', 'AWS reads payment_transfers under RLS only.'),
  fn('moov-transfer-group-create', 'moov', OP_CLASS.MONEY_MOVEMENT, 'disabled', 'Creates grouped transfers.'),
  fn('moov-disburse', 'moov', OP_CLASS.DISBURSEMENT, 'disabled', 'Executes disbursement splits.'),
  fn('moov-tenant-fee-charge', 'moov', OP_CLASS.MONEY_MOVEMENT, 'disabled', 'Charges tenant fees via Moov.'),
  fn('moov-fee-schedule-upsert', 'moov', OP_CLASS.CONFIG_ADMIN, 'disabled', 'Mutates fee schedules.'),
  fn('moov-fee-schedule-cancel', 'moov', OP_CLASS.CONFIG_ADMIN, 'disabled', 'Cancels fee schedules.'),
  fn('moov-fee-rollup', 'moov', OP_CLASS.CONFIG_ADMIN, 'disabled', 'Fee reporting against provider state.'),
  fn('moov-sweep-config', 'moov', OP_CLASS.CONFIG_ADMIN, 'disabled', 'Configures sweeps.'),
  fn('moov-invoice', 'moov', OP_CLASS.NOTIFICATION, 'disabled', 'Invoice generation / send.'),
  fn('moov-bulk-import-preview', 'moov', OP_CLASS.CONFIG_ADMIN, 'disabled', 'Bulk import preview; may call Moov.'),
  fn('moov-webhook', 'moov', OP_CLASS.WEBHOOK, 'webhook', 'AWS POST /webhooks/moov. Dry-run default.'),

  fn('checkalt-submit-deposit', 'checkalt', OP_CLASS.DEPOSIT, 'disabled', 'Submits a live check deposit. Integer-cents userAmount preserved in adapter, not executed.'),
  fn('checkalt-approve-deposit', 'checkalt', OP_CLASS.DEPOSIT, 'disabled', 'Approves a pending CheckAlt deposit.'),
  fn('checkalt-poll-status', 'checkalt', OP_CLASS.READ_STATUS, 'disabled', 'Calls CheckAlt and UPDATES checkalt_deposits.'),
  fn('checkalt-deposit-history', 'checkalt', OP_CLASS.READ_STATUS, 'db_status', 'AWS reads local checkalt_deposits only.'),
  fn('checkalt-account-status', 'checkalt', OP_CLASS.READ_STATUS, 'db_status', 'AWS reads local checkalt_tenant_accounts; no FinCapture GET.'),
  fn('checkalt-test-connection', 'checkalt', OP_CLASS.CONFIG_ADMIN, 'disabled', 'Authenticates against CheckAlt.'),
  fn('checkalt-register-account', 'checkalt', OP_CLASS.BANK_CONNECTION, 'disabled', 'Registers a depositor at CheckAlt.'),
  fn('checkalt-verify-account', 'checkalt', OP_CLASS.BANK_CONNECTION, 'disabled', 'Verifies a CheckAlt account.'),
  fn('checkalt-prepare-image', 'checkalt', OP_CLASS.DEPOSIT, 'disabled', 'Prepares deposit images; kept disabled so it cannot feed a live submit.'),

  fn('plaid-link-token-create', 'plaid', OP_CLASS.BANK_CONNECTION, 'disabled', 'Creates a Plaid Link token.'),
  fn('plaid-link-token-create-public', 'plaid', OP_CLASS.BANK_CONNECTION, 'disabled', 'Public/homeowner Link token.'),
  fn('plaid-exchange', 'plaid', OP_CLASS.BANK_CONNECTION, 'disabled', 'Exchanges a public token for an Item.'),
  fn('plaid-disburse', 'plaid', OP_CLASS.DISBURSEMENT, 'disabled', 'Plaid Transfer disbursement.'),
  fn('plaid-transfer-webhook', 'plaid', OP_CLASS.WEBHOOK, 'webhook', 'AWS POST /webhooks/plaid. Dry-run default.'),

  fn('quickbooks-auth', 'quickbooks', OP_CLASS.CONFIG_ADMIN, 'disabled', 'OAuth connect/refresh only. Interface + secrets.'),
  fn('quickbooks-payment', 'quickbooks', OP_CLASS.MONEY_MOVEMENT, 'disabled', 'Creates QuickBooks payments.'),

  fn('initiate-wallet-funding', 'moov', OP_CLASS.MONEY_MOVEMENT, 'disabled', 'Queues/creates wallet funding.'),
  fn('cancel-wallet-funding', 'moov', OP_CLASS.MONEY_MOVEMENT, 'disabled', 'Cancels funding; provider-adjacent.'),
  fn('calculate-payment-funding', 'moov', OP_CLASS.MONEY_MOVEMENT, 'disabled', 'Funding plan used immediately before execution.'),
  fn('process-funded-payment', 'moov', OP_CLASS.MONEY_MOVEMENT, 'disabled', 'Executes a funded payment.'),
  fn('wallet-fund-on-clear', 'moov', OP_CLASS.MONEY_MOVEMENT, 'disabled', 'Auto-fund after check clear.'),
  fn('platform-treasury', 'moov', OP_CLASS.CONFIG_ADMIN, 'disabled', 'Platform treasury operations.'),
  fn('homeowner-deductible-pay', 'moov', OP_CLASS.MONEY_MOVEMENT, 'disabled', 'Charges a homeowner deductible.'),
  fn('homeowner-bank-link-send', 'plaid', OP_CLASS.NOTIFICATION, 'disabled', 'Sends bank-link email + Plaid setup.'),
  fn('stakeholder-resend-verification', 'moov', OP_CLASS.NOTIFICATION, 'disabled', 'Resends stakeholder KYC/verification email.'),
  fn('public-invoice', 'moov', OP_CLASS.NOTIFICATION, 'disabled', 'Public invoice fetch/pay.'),
];

export const ACTUM_BOUNDARY = {
  name: 'actum',
  provider: 'actum',
  class: OP_CLASS.MONEY_MOVEMENT,
  aws: 'interface_only',
  notes: 'No dedicated supabase/functions/actum-* on current main. actum_transactions table + frontend remnants only. AWS exposes config/health boundary. No live charges.',
};

export const FUNCTION_BY_NAME = Object.fromEntries(PROVIDER_FUNCTIONS.map((item) => [item.name, item]));

export const dbStatusFunctions = () => PROVIDER_FUNCTIONS.filter((item) => item.aws === 'db_status').map((item) => item.name);

export const webhookFunctions = () => PROVIDER_FUNCTIONS.filter((item) => item.aws === 'webhook').map((item) => item.name);

export const classifyFunction = (name) => FUNCTION_BY_NAME[name] || null;
