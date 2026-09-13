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
  fn('moov-account-create', 'moov', OP_CLASS.IDENTITY_KYC, 'sandbox_parity', 'Creates a real Moov account. Execution left disabled.'),
  fn('moov-account-discover', 'moov', OP_CLASS.READ_STATUS, 'sandbox_parity', 'Hits Moov to discover accounts. Live reads stay off.'),
  fn('moov-account-onboard', 'moov', OP_CLASS.IDENTITY_KYC, 'sandbox_parity', 'Creates/changes Moov account + capabilities.'),
  fn('moov-account-files', 'moov', OP_CLASS.IDENTITY_KYC, 'sandbox_parity', 'Lists/uploads KYC files at Moov.'),
  fn('moov-account-file-upload', 'moov', OP_CLASS.IDENTITY_KYC, 'sandbox_parity', 'Uploads KYC documents to Moov.'),
  fn('moov-account-file-view', 'moov', OP_CLASS.READ_STATUS, 'sandbox_parity', 'Fetches KYC file bytes from Moov.'),
  fn('moov-onboarding-link', 'moov', OP_CLASS.IDENTITY_KYC, 'sandbox_parity', 'Creates hosted onboarding session.'),
  fn('moov-readiness', 'moov', OP_CLASS.READ_STATUS, 'sandbox_parity', 'Live GET /accounts/{id} + capabilities + banks + fee-plans. Sandbox credentials only.'),
  fn('moov-selftest', 'moov', OP_CLASS.CONFIG_ADMIN, 'sandbox_parity', 'Calls Moov with sandbox platform credentials.'),
  fn('moov-sync', 'moov', OP_CLASS.IDENTITY_KYC, 'sandbox_parity', 'Pulls Moov state and writes sandbox payment_provider_accounts.'),
  fn('moov-wallet-sync', 'moov', OP_CLASS.MONEY_MOVEMENT, 'sandbox_parity', 'syncWallet port: provisions/refreshes payment_wallets + ledger.'),
  fn('moov-wallet-fund', 'moov', OP_CLASS.MONEY_MOVEMENT, 'sandbox_parity', 'BANK→WALLET. Production (dark): fail-closed AWS writer; never re-KYC. Unreachable while money holds remain on.'),
  fn('moov-bank-account-add', 'moov', OP_CLASS.BANK_CONNECTION, 'sandbox_parity', 'Adds a bank account at Moov.'),
  fn('moov-bank-link-token', 'moov', OP_CLASS.BANK_CONNECTION, 'sandbox_parity', 'Creates a bank-link token.'),
  fn('moov-micro-deposit-initiate', 'moov', OP_CLASS.BANK_CONNECTION, 'sandbox_parity', 'Initiates micro-deposits (money movement).'),
  fn('moov-micro-deposit-confirm', 'moov', OP_CLASS.BANK_CONNECTION, 'sandbox_parity', 'Confirms micro-deposits.'),
  fn('moov-plaid-bridge', 'moov', OP_CLASS.BANK_CONNECTION, 'sandbox_parity', 'Links Plaid items into Moov.'),
  fn('moov-platform-bank', 'moov', OP_CLASS.CONFIG_ADMIN, 'sandbox_parity', 'Platform treasury bank admin.'),
  fn('moov-tos-token', 'moov', OP_CLASS.IDENTITY_KYC, 'sandbox_parity', 'Creates Platform Agreement / TOS token at Moov.'),
  fn('moov-tos-accept', 'moov', OP_CLASS.IDENTITY_KYC, 'sandbox_parity', 'Records TOS acceptance at Moov.'),
  fn('moov-underwriting', 'moov', OP_CLASS.IDENTITY_KYC, 'sandbox_parity', 'Submits underwriting answers.'),
  fn('moov-recipient-create', 'moov', OP_CLASS.IDENTITY_KYC, 'sandbox_parity', 'Creates stakeholder/recipient Moov account.'),
  fn('moov-recipient-session', 'moov', OP_CLASS.IDENTITY_KYC, 'sandbox_parity', 'Hosted recipient onboarding session.'),
  fn('moov-recipient-tos-accept', 'moov', OP_CLASS.IDENTITY_KYC, 'sandbox_parity', 'Recipient Platform Agreement.'),
  fn('moov-recipient-kyc-update', 'moov', OP_CLASS.IDENTITY_KYC, 'sandbox_parity', 'Mutates recipient KYC at Moov.'),
  fn('moov-recipient-bank-add', 'moov', OP_CLASS.BANK_CONNECTION, 'sandbox_parity', 'Adds recipient bank.'),
  fn('moov-recipient-bank-verify', 'moov', OP_CLASS.BANK_CONNECTION, 'sandbox_parity', 'Recipient instant micro-deposit verify. Not a transfer.'),
  fn('moov-recipient-disconnect', 'moov', OP_CLASS.IDENTITY_KYC, 'sandbox_parity', 'Disconnects recipient account.'),
  fn('moov-transfer-create', 'moov', OP_CLASS.MONEY_MOVEMENT, 'sandbox_parity', 'Creates ACH/RTP/wallet transfer.'),
  fn('moov-transfer-status', 'moov', OP_CLASS.READ_STATUS, 'sandbox_parity', 'Live GET facilitator transfer + payment_transfers write-back for sandbox rows.'),
  fn('moov-transfer-group-create', 'moov', OP_CLASS.MONEY_MOVEMENT, 'sandbox_parity', 'Creates grouped transfers.'),
  fn('moov-disburse', 'moov', OP_CLASS.DISBURSEMENT, 'sandbox_parity', 'WALLET→RECIPIENT only on AWS production (dark). Bank fallback and internal bypass refused. Unreachable while money holds remain on.'),
  fn('moov-tenant-fee-charge', 'moov', OP_CLASS.MONEY_MOVEMENT, 'sandbox_parity', 'Charges tenant fees via Moov.'),
  fn('moov-fee-schedule-upsert', 'moov', OP_CLASS.CONFIG_ADMIN, 'sandbox_parity', 'Mutates fee schedules.'),
  fn('moov-fee-schedule-cancel', 'moov', OP_CLASS.CONFIG_ADMIN, 'sandbox_parity', 'Cancels fee schedules.'),
  fn('moov-fee-rollup', 'moov', OP_CLASS.CONFIG_ADMIN, 'sandbox_parity', 'Fee reporting against provider state.'),
  fn('moov-sweep-config', 'moov', OP_CLASS.CONFIG_ADMIN, 'sandbox_parity', 'Configures sweeps.'),
  fn('moov-invoice', 'moov', OP_CLASS.NOTIFICATION, 'sandbox_parity', 'Invoice generation / send.'),
  fn('moov-bulk-import-preview', 'moov', OP_CLASS.CONFIG_ADMIN, 'sandbox_parity', 'Bulk import preview; may call Moov.'),
  fn('moov-webhook', 'moov', OP_CLASS.WEBHOOK, 'webhook', 'AWS POST /webhooks/moov. Dry-run default.'),

  fn('checkalt-submit-deposit', 'checkalt', OP_CLASS.DEPOSIT, 'sandbox_parity', 'UAT: isolated sandbox rows. Production (dark): checkalt_deposits writer + durable idempotency before FinCapture HTTP. Unreachable while money holds remain on.'),
  fn('checkalt-approve-deposit', 'checkalt', OP_CLASS.DEPOSIT, 'sandbox_parity', 'POST /fincapture/deposit/approve action 1/2. Accepts deposit_id like production.'),
  fn('checkalt-poll-status', 'checkalt', OP_CLASS.READ_STATUS, 'sandbox_parity', 'UAT: isolated rows. Production (dark): locates existing checkalt_deposits, never INSERTs, updates status. Unreachable while holds remain on.'),
  fn('checkalt-deposit-history', 'checkalt', OP_CLASS.READ_STATUS, 'sandbox_parity', 'Live POST /fincapture/deposit/history with UAT ssoKey.'),
  fn('checkalt-account-status', 'checkalt', OP_CLASS.READ_STATUS, 'sandbox_parity', 'Live getUserAccountInformation for isolated UAT depositor.'),
  fn('checkalt-test-connection', 'checkalt', OP_CLASS.CONFIG_ADMIN, 'sandbox_parity', 'POST /public/fincapture/authenticate { userName, password }.'),
  fn('checkalt-register-account', 'checkalt', OP_CLASS.BANK_CONNECTION, 'sandbox_parity', 'Register UAT depositor into aws_provider_sandbox_objects, not production checkalt_tenant_accounts.'),
  fn('checkalt-verify-account', 'checkalt', OP_CLASS.BANK_CONNECTION, 'sandbox_parity', 'getUserAccountInformation with tenant sso_user_id, never API login.'),
  fn('checkalt-prepare-image', 'checkalt', OP_CLASS.DEPOSIT, 'sandbox_parity', 'Fast-path prepared_path when source is under 450KB. ImageScript re-encode not ported.'),

  fn('plaid-link-token-create', 'plaid', OP_CLASS.BANK_CONNECTION, 'disabled', 'Creates a Plaid Link token.'),
  fn('plaid-link-token-create-public', 'plaid', OP_CLASS.BANK_CONNECTION, 'disabled', 'Public/homeowner Link token.'),
  fn('plaid-exchange', 'plaid', OP_CLASS.BANK_CONNECTION, 'disabled', 'Exchanges a public token for an Item.'),
  fn('plaid-disburse', 'plaid', OP_CLASS.DISBURSEMENT, 'disabled', 'Plaid Transfer disbursement.'),
  fn('plaid-transfer-webhook', 'plaid', OP_CLASS.WEBHOOK, 'webhook', 'AWS POST /webhooks/plaid. Dry-run default.'),

  fn('quickbooks-auth', 'quickbooks', OP_CLASS.CONFIG_ADMIN, 'disabled', 'OAuth connect/refresh only. Interface + secrets.'),
  fn('quickbooks-payment', 'quickbooks', OP_CLASS.MONEY_MOVEMENT, 'disabled', 'Creates QuickBooks payments.'),

  fn('initiate-wallet-funding', 'moov', OP_CLASS.MONEY_MOVEMENT, 'sandbox_parity', 'Refused on AWS production: couples funding + auto-send. Use moov-wallet-fund then a separate disbursement.'),
  fn('cancel-wallet-funding', 'moov', OP_CLASS.MONEY_MOVEMENT, 'sandbox_parity', 'Cancels funding; provider-adjacent.'),
  fn('calculate-payment-funding', 'moov', OP_CLASS.MONEY_MOVEMENT, 'sandbox_parity', 'Funding plan used immediately before execution.'),
  fn('process-funded-payment', 'moov', OP_CLASS.MONEY_MOVEMENT, 'sandbox_parity', 'Executes a funded payment.'),
  fn('wallet-fund-on-clear', 'moov', OP_CLASS.MONEY_MOVEMENT, 'sandbox_parity', 'Auto-fund after check clear.'),
  fn('platform-treasury', 'moov', OP_CLASS.CONFIG_ADMIN, 'sandbox_parity', 'Platform treasury operations.'),
  fn('homeowner-deductible-pay', 'moov', OP_CLASS.MONEY_MOVEMENT, 'sandbox_parity', 'Charges a homeowner deductible.'),
  fn('homeowner-bank-link-send', 'plaid', OP_CLASS.NOTIFICATION, 'disabled', 'Sends bank-link email + Plaid setup.'),
  fn('stakeholder-resend-verification', 'moov', OP_CLASS.NOTIFICATION, 'sandbox_parity', 'Resends stakeholder KYC/verification email.'),
  fn('public-invoice', 'moov', OP_CLASS.NOTIFICATION, 'sandbox_parity', 'Public invoice fetch/pay.'),
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
