/**
 * Application authorization is not provider execution authorization.
 *
 * A valid Cognito-mapped tenant user may read local provider status under RLS.
 * That user does not automatically have authority to create financial/provider
 * actions. Tranche 4 documents the required permissions but does not grant them.
 */

export const PROVIDER_EXECUTION_PERMISSIONS = {
  deposit_submission: {
    operation: 'deposit_submission',
    providers: ['checkalt'],
    required: [
      'Authenticated tenant member (Cognito → identity_accounts → auth.uid())',
      'Tenant owns the check_intake_item (RLS)',
      'has_permission(deposit.submit) or tenant admin — NOT ACTIVATED',
      'AWS_PROVIDER_EXECUTION_ENABLED=true AND AWS_CHECKALT_ENABLED=true',
      'CheckAlt tenant account registered and enabled',
      'Idempotency key unique per check + amount_cents',
    ],
    activated: false,
  },
  disbursement: {
    operation: 'disbursement',
    providers: ['moov', 'plaid'],
    required: [
      'Authenticated tenant member',
      'Tenant owns the disbursement batch/splits',
      'has_permission(disbursement.execute) or tenant admin — NOT ACTIVATED',
      'Moov readiness canMoveMoney from provider (not local cache alone)',
      'AWS_PROVIDER_EXECUTION_ENABLED=true AND matching provider flag',
      'Idempotency key on payment_idempotency_keys / payment_transfers',
    ],
    activated: false,
  },
  ach: {
    operation: 'ach',
    providers: ['moov'],
    required: [
      'Same as disbursement',
      'send-funds.ach capability enabled on the tenant Moov account',
      'Verified bank or wallet source owned by the tenant',
      'AWS_MOOV_ENABLED=true',
    ],
    activated: false,
  },
  rtp: {
    operation: 'rtp',
    providers: ['moov'],
    required: [
      'Same as ACH',
      'RTP capability enabled',
      'Amount within RTP limit',
      'Explicit requested_speed=instant — NOT ACTIVATED',
    ],
    activated: false,
  },
  wallet_transfer: {
    operation: 'wallet_transfer',
    providers: ['moov'],
    required: [
      'Authenticated tenant member',
      'Tenant owns source and destination wallet/provider_wallet_id',
      'has_permission(wallet.transfer) — NOT ACTIVATED',
      'AWS_PROVIDER_EXECUTION_ENABLED=true AND AWS_MOOV_ENABLED=true',
    ],
    activated: false,
  },
  stakeholder_payment: {
    operation: 'stakeholder_payment',
    providers: ['moov'],
    required: [
      'Authenticated tenant member',
      'Recipient/stakeholder provider_account_id mapped to this tenant',
      'Recipient KYC/TOS/bank gates satisfied',
      'has_permission(stakeholder.pay) — NOT ACTIVATED',
      'AWS_PROVIDER_EXECUTION_ENABLED=true AND AWS_MOOV_ENABLED=true',
    ],
    activated: false,
  },
  provider_configuration: {
    operation: 'provider_configuration',
    providers: ['moov', 'checkalt', 'plaid', 'actum', 'quickbooks'],
    required: [
      'Platform admin (user_roles.admin) or tenant admin — NOT ACTIVATED on AWS',
      'AWS_PROVIDER_EXECUTION_ENABLED=true AND matching provider flag',
      'Never accept provider credentials from the browser',
    ],
    activated: false,
  },
};

export const providerPermissionSnapshot = () => (
  Object.fromEntries(
    Object.entries(PROVIDER_EXECUTION_PERMISSIONS).map(([key, value]) => [
      key,
      { ...value, activated: false },
    ]),
  )
);

export const denyProviderPermission = (operation, extra = {}) => ({
  ok: false,
  statusCode: 403,
  error: 'provider_execution_unauthorized',
  operation,
  activated: false,
  message: 'Application login is not provider execution authority. This permission is documented and not activated.',
  requirements: PROVIDER_EXECUTION_PERMISSIONS[operation] || null,
  ...extra,
});
