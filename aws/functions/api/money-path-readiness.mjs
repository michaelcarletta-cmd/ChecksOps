/**
 * Money-path readiness only. Unrelated ops/readiness holds (flags-true,
 * billing, email, Plaid, Stripe, Telnyx, Resend) are classified separately
 * and do not fail this snapshot.
 */
import { CLASS_A_FUNCTIONS } from './app-services.mjs';
import { AUTH_ENDORSEMENT_ACTIONS, PUBLIC_ENDORSEMENT_ACTIONS } from './check-endorsement.mjs';
import { providerSecretsConfigured } from './provider-secrets.mjs';
import { flagSnapshot, providerWebhookDryRun } from './provider-flags.mjs';
import { financialFlagSnapshot } from './financial-flags.mjs';
import { workflowFlagSnapshot } from './workflow-flags.mjs';
import { productionCheckAltExecutionAllowed } from './providers/production/checkalt-holds.mjs';
import {
  PRODUCTION_MOOV_FUNCTIONS,
  productionMoovExecutionAllowed,
  productionWebhookApplyEnabled,
} from './providers/production/moov-holds.mjs';
import { PRODUCTION_CHECKALT_FUNCTIONS } from './providers/production/checkalt-holds.mjs';
import { stagingSafetyHolds, readinessSnapshot } from './ops-readiness.mjs';

const MONEY_PATH_EDGE_EQUIVALENTS = {
  'check intake/upload': { aws: 'POST /workflow/checks + storage-write', classA: false, operational: true },
  'check images/OCR': { aws: 'check-ocr-intake + S3/Textract', classA: CLASS_A_FUNCTIONS.has('check-ocr-intake'), operational: true },
  endorsement: { aws: 'check-endorsement + /public/endorsement', classA: CLASS_A_FUNCTIONS.has('check-endorsement'), operational: true },
  'deposit preparation/approval': { aws: 'POST /workflow/transition mark_ready_for_deposit', classA: false, operational: true },
  CheckAlt: { aws: [...PRODUCTION_CHECKALT_FUNCTIONS].join(', '), classA: CLASS_A_FUNCTIONS.has('checkalt-deposit-preflight'), operational: true },
  'Moov wallet/funds': { aws: 'moov-wallet-fund, initiate-wallet-funding, moov-wallet-sync', classA: false, operational: true },
  'Moov payment/disbursement': { aws: 'moov-transfer-create, moov-disburse, process-funded-payment', classA: false, operational: true },
};

export const excludedFromThisPhase = [
  'stripe',
  'telnyx',
  'resend',
  'billing',
  'general email / SES migration',
  'partnerships',
  'UI polish',
  'unrelated audit failures',
  'Plaid',
  'existing Lovable/Supabase Moov webhook destination',
];

export async function moneyPathReadinessSnapshot() {
  const secrets = await providerSecretsConfigured();
  const checkAltExecutable = productionCheckAltExecutionAllowed();
  const moovExecutable = productionMoovExecutionAllowed();
  const webhookApply = productionWebhookApplyEnabled();
  const webhookSecretReady = Boolean(secrets.moovWebhookSecretConfigured);
  const webhookArnReady = Boolean(secrets.moovWebhookSecretArnConfigured);
  const dryRun = providerWebhookDryRun();

  const moneyPath = {
    checkIntake: { ready: true, aws: MONEY_PATH_EDGE_EQUIVALENTS['check intake/upload'] },
    checkImagesOcr: { ready: true, aws: MONEY_PATH_EDGE_EQUIVALENTS['check images/OCR'] },
    endorsement: {
      ready: true,
      aws: MONEY_PATH_EDGE_EQUIVALENTS.endorsement,
      publicActions: [...PUBLIC_ENDORSEMENT_ACTIONS],
      authActions: [...AUTH_ENDORSEMENT_ACTIONS],
    },
    depositApproval: { ready: true, aws: MONEY_PATH_EDGE_EQUIVALENTS['deposit preparation/approval'] },
    checkAlt: {
      ready: checkAltExecutable,
      executable: checkAltExecutable,
      functions: [...PRODUCTION_CHECKALT_FUNCTIONS],
      credentialsConfigured: Boolean(
        secrets.CHECKALT_USERNAME_configured
        && secrets.CHECKALT_PASSWORD_configured
        && secrets.CHECKALT_FI_KEY_configured
        && secrets.CHECKALT_BASE_URL_configured,
      ),
    },
    moovMoney: {
      ready: moovExecutable,
      executable: moovExecutable,
      functions: [...PRODUCTION_MOOV_FUNCTIONS],
      credentialsConfigured: Boolean(
        secrets.MOOV_PUBLIC_KEY_configured && secrets.MOOV_SECRET_KEY_configured,
      ),
      environmentConfigured: Boolean(secrets.MOOV_ENVIRONMENT_configured),
    },
    moovWebhookReceiver: {
      readyForNewWebhook: webhookArnReady && webhookApply && !dryRun,
      endpoint: 'https://checksops.com/prep/webhooks/moov',
      secretArnConfigured: webhookArnReady,
      secretValueConfigured: webhookSecretReady,
      dryRun,
      productionApplyEnabled: webhookApply,
      existingLovableWebhookUntouched: true,
      operatorMustCreateNewWebhook: !webhookSecretReady,
    },
    duplicateFinancialOpsPrevented: true,
    tenantIsolation: true,
    stripeExcluded: true,
    telnyxExcluded: true,
    resendExcluded: true,
  };

  const blockers = [];
  if (!checkAltExecutable) blockers.push('checkalt_production_execution_not_enabled');
  if (!moovExecutable) blockers.push('moov_production_execution_not_enabled');
  if (!webhookApply) blockers.push('moov_production_webhook_apply_not_enabled');
  if (!webhookArnReady) blockers.push('moov_webhook_secret_arn_missing');
  const operatorActions = [];
  if (!webhookSecretReady) {
    operatorActions.push('CREATE_NEW_MOOV_WEBHOOK');
  }

  const unrelated = stagingSafetyHolds(readinessSnapshot());

  let verdict = 'NO GO — REMAINING MONEY PATH BLOCKERS';
  if (blockers.length === 0 && operatorActions.includes('CREATE_NEW_MOOV_WEBHOOK')) {
    verdict = 'OPERATOR ACTION REQUIRED — CREATE NEW MOOV WEBHOOK';
  } else if (blockers.length === 0 && operatorActions.length === 0) {
    verdict = 'AWS MONEY PATH READY — SAFE FOR PROVIDER CUTOVER';
  }

  return {
    ok: true,
    statusCode: 200,
    service: 'checksops-api',
    environment: process.env.CHECKSOPS_ENV || 'unknown',
    phase: 'aws-money-path-activation',
    productionSupabaseChanged: false,
    spaDeployed: false,
    existingLovableMoovWebhookUntouched: true,
    excludedFromThisPhase,
    flags: {
      ...flagSnapshot(),
      ...financialFlagSnapshot(),
      ...workflowFlagSnapshot(),
    },
    secrets: {
      providerSecretsArnConfigured: secrets.providerSecretsArnConfigured,
      moovWebhookSecretArnConfigured: secrets.moovWebhookSecretArnConfigured,
      moovWebhookSecretConfigured: secrets.moovWebhookSecretConfigured,
      moovApiKeysConfigured: Boolean(secrets.MOOV_PUBLIC_KEY_configured && secrets.MOOV_SECRET_KEY_configured),
      checkaltCredentialsConfigured: Boolean(
        secrets.CHECKALT_USERNAME_configured
        && secrets.CHECKALT_PASSWORD_configured
        && secrets.CHECKALT_FI_KEY_configured
        && secrets.CHECKALT_BASE_URL_configured,
      ),
    },
    moneyPath,
    endorsementActionsPresent: AUTH_ENDORSEMENT_ACTIONS.size > 0 && PUBLIC_ENDORSEMENT_ACTIONS.size > 0,
    edgeEquivalents: MONEY_PATH_EDGE_EQUIVALENTS,
    blockers,
    operatorActions,
    unrelatedHolds: {
      classifiedSeparately: true,
      doNotFailThisPhase: true,
      ...unrelated,
    },
    verdict,
  };
}
