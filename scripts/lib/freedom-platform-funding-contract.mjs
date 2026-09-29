/**
 * Freedom → ChecksOps production funding contract.
 * Evaluates fixtures only. Does not call AWS, Moov, or SQL.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadJson, repoRootFrom, ISO_TIMESTAMP_RE } from './release-locks.mjs';

export const FUNDING_CONTRACT_REL = 'ops/release-locks/contracts/freedom-platform-funding-contract.json';
export const FUNDING_CONTRACT_TEST_REL = 'ops/release-locks/tests/freedom-platform-funding-contract.test.mjs';
export const FUNDING_CONTRACT_ID = 'freedom-platform-funding';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FALLBACK_SELECTIONS = new Set([
  'first_available_payment_method',
  'first_wallet',
  'first_bank',
  'other_tenant_source',
  'platform_bank_as_source',
  'sandbox_in_production',
]);

export function fundingContractPath(root = repoRootFrom(import.meta.url)) {
  return path.join(root, FUNDING_CONTRACT_REL);
}

export function loadFundingContract(root = repoRootFrom(import.meta.url)) {
  return loadJson(fundingContractPath(root));
}

export function isFundingWatchedPath(relPath, contract = null) {
  const normalized = String(relPath || '').split(path.sep).join('/');
  const watched = contract?.watched_runtime_paths || [];
  return watched.includes(normalized);
}

export function candidateChangedPaths(candidate = {}, extraPaths = []) {
  const rows = [
    ...(Array.isArray(candidate.changed_paths) ? candidate.changed_paths : []),
    ...(Array.isArray(candidate.changedFiles) ? candidate.changedFiles : []),
    ...extraPaths,
  ];
  return [...new Set(rows.map((row) => String(row || '').split(path.sep).join('/')).filter(Boolean))];
}

export function candidateTouchesFundingPath(candidate = {}, extraPaths = [], contract = null) {
  if (candidate.funding_paths_changed === true) return true;
  return candidateChangedPaths(candidate, extraPaths).some((rel) => isFundingWatchedPath(rel, contract));
}

function missingLookup(lookup = {}, key) {
  const value = lookup[key];
  return value === undefined || value === null || value === false || value === 'missing' || value === 'ambiguous';
}

export function evaluateFundingOperation(operation, contract) {
  const errors = [];
  if (!operation || typeof operation !== 'object') {
    return { ok: false, errors: ['funding operation is missing'] };
  }
  const ids = contract?.identities || {};
  const known = contract?.known_good_transfer || {};
  const source = operation.source || {};
  const destination = operation.destination || {};
  const lookup = operation.lookup || {};
  const provider = operation.provider || {};
  const local = operation.local || {};
  const gates = operation.gates || {};
  const env = String(operation.environment || '').toLowerCase();

  if (env === 'production' && (source.sandbox === true || destination.sandbox === true || operation.moovEnvironment === 'sandbox')) {
    errors.push('F: production funding used sandbox Moov resources');
  }
  if (operation.tenantId && operation.tenantId !== ids.freedom_tenant_id && source.accountId === ids.freedom_moov_account_id) {
    errors.push('G: another tenant resolved Freedom source account');
  }
  if (operation.tenantId === ids.freedom_tenant_id && source.accountId && source.accountId !== ids.freedom_moov_account_id) {
    errors.push('A/B: Freedom funding did not resolve Freedom Moov account');
  }
  if (operation.tenantId === ids.freedom_tenant_id && source.tenantId && source.tenantId !== ids.freedom_tenant_id) {
    errors.push('A/G: Freedom resolved another tenant funding source');
  }
  if (source.accountId === ids.checksops_platform_account_id) {
    errors.push('E: ChecksOps platform account used as source');
  }
  if (destination.accountId === ids.freedom_moov_account_id) {
    errors.push('E: Freedom account used as destination');
  }
  if (source.accountId && destination.accountId && source.accountId === destination.accountId) {
    errors.push('E: source and destination accounts are the same');
  }
  if (operation.direction && operation.direction !== 'freedom_to_checksops') {
    errors.push(`E: money direction must remain freedom_to_checksops, got ${operation.direction}`);
  }
  if (source.accountId && source.accountId !== ids.freedom_moov_account_id) {
    errors.push('B: source account is not the authorized Freedom Moov account');
  }
  if (source.bankLast4 && source.bankLast4 !== ids.freedom_bank_last4) {
    errors.push('C: source bank last4 is not the authorized Freedom Wells Fargo 4573');
  }
  if (source.paymentMethodId && source.paymentMethodId !== ids.freedom_ach_debit_fund_method_id) {
    errors.push('C: source payment method is not the authorized Freedom ach-debit-fund method');
  }
  if (source.rail && source.rail !== 'ach-debit-fund') {
    errors.push('C: source rail is not ach-debit-fund');
  }
  if (FALLBACK_SELECTIONS.has(source.selection)) {
    errors.push(`C: forbidden source selection ${source.selection}`);
  }
  if (destination.accountId && destination.accountId !== ids.checksops_platform_account_id) {
    errors.push('D: destination account is not the ChecksOps platform merchant');
  }
  if (destination.walletId && destination.walletId !== ids.checksops_platform_wallet_id) {
    errors.push('D: destination wallet is not the ChecksOps platform wallet');
  }
  if (destination.paymentMethodId && destination.paymentMethodId !== ids.checksops_platform_wallet_payment_method_id) {
    errors.push('D: destination payment method is not the ChecksOps platform wallet method');
  }
  if (FALLBACK_SELECTIONS.has(destination.selection)) {
    errors.push(`D: forbidden destination selection ${destination.selection}`);
  }
  if (!operation.idempotencyKey) {
    errors.push('H: idempotency key is missing');
  }
  if (operation.retry === true && operation.existingProviderTransferId) {
    errors.push('H: retry of an already-created provider transfer is forbidden');
  }
  if (operation.createProviderTransfer === true && operation.existingProviderTransferId) {
    errors.push('H: second provider transfer would be created for the same logical operation');
  }
  if (provider.transferId && local.providerTransferId && provider.transferId !== local.providerTransferId) {
    errors.push('I: provider transfer ID does not match the persisted local row');
  }
  if (provider.amountCents != null && local.amountCents != null && Number(provider.amountCents) !== Number(local.amountCents)) {
    errors.push('I: provider and local amounts disagree');
  }
  if (known.amount_cents != null && local.amountCents != null && Number(local.amountCents) !== Number(known.amount_cents)
    && operation.kind === 'billing_verification') {
    errors.push('I: local amount does not match the known-good funding amount');
  }
  if (operation.post === true) {
    if (String(gates.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED) === 'false'
      && operation.kind === 'billing_verification') {
      errors.push('J: verification POST attempted while AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED is false');
    }
    if (String(gates.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST) === 'false'
      && operation.kind === 'monthly_billing') {
      errors.push('J: monthly billing POST attempted while AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST is false');
    }
  }
  for (const key of ['tenant', 'account', 'bank', 'wallet', 'environment', 'authorization', 'providerConfig']) {
    if (missingLookup(lookup, key)) {
      errors.push(`J: ${key} lookup is missing or ambiguous; transfer must fail closed`);
    }
  }
  if (lookup.fallbackAfterFailure === true) {
    errors.push('J: silent fallback after account lookup failure is forbidden');
  }
  if (source.accountId && !UUID_RE.test(source.accountId)) {
    errors.push('B: source account id is not a UUID');
  }
  if (destination.accountId && !UUID_RE.test(destination.accountId)) {
    errors.push('D: destination account id is not a UUID');
  }

  return { ok: errors.length === 0, errors };
}

export function knownGoodFundingOperation(contract) {
  const ids = contract.identities;
  const known = contract.known_good_transfer;
  return {
    kind: 'billing_verification',
    environment: 'production',
    moovEnvironment: 'production',
    tenantId: ids.freedom_tenant_id,
    direction: 'freedom_to_checksops',
    idempotencyKey: known.idempotency_key,
    retry: false,
    createProviderTransfer: false,
    existingProviderTransferId: null,
    post: false,
    source: {
      tenantId: ids.freedom_tenant_id,
      accountId: ids.freedom_moov_account_id,
      paymentMethodId: ids.freedom_ach_debit_fund_method_id,
      bankLast4: ids.freedom_bank_last4,
      rail: 'ach-debit-fund',
      selection: 'authorized_freedom_debit_fund',
      sandbox: false,
    },
    destination: {
      accountId: ids.checksops_platform_account_id,
      walletId: ids.checksops_platform_wallet_id,
      paymentMethodId: ids.checksops_platform_wallet_payment_method_id,
      selection: 'explicit_platform_wallet',
      sandbox: false,
    },
    provider: {
      transferId: known.provider_transfer_id,
      status: known.provider_status_at_freeze,
      amountCents: known.amount_cents,
      currency: known.currency,
    },
    local: {
      paymentId: known.local_payment_id,
      providerTransferId: known.provider_transfer_id,
      amountCents: known.amount_cents,
      currency: known.currency,
    },
    gates: { ...contract.monthly_billing_separation },
    lookup: {
      tenant: ids.freedom_tenant_id,
      account: ids.freedom_moov_account_id,
      bank: ids.freedom_bank_last4,
      wallet: ids.checksops_platform_wallet_id,
      environment: 'production',
      authorization: true,
      providerConfig: true,
    },
  };
}

export function runFundingContractTests(root = repoRootFrom(import.meta.url)) {
  const result = spawnSync(process.execPath, ['--test', FUNDING_CONTRACT_TEST_REL], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FREEDOM_FUNDING_CONTRACT_INNER: '1' },
  });
  if (result.status !== 0) {
    const tail = String(result.stderr || result.stdout || '').trim().split('\n').slice(-8).join(' | ');
    return [`funding contract tests failed closed (exit ${result.status})${tail ? `: ${tail}` : ''}`];
  }
  return [];
}

export function fundingDeployGuardErrors(candidate, root = repoRootFrom(import.meta.url), extraPaths = []) {
  const errors = [];
  if (!candidate || typeof candidate !== 'object') return errors;
  const contract = loadFundingContract(root);
  const paths = candidateChangedPaths(candidate, extraPaths);
  const touches = candidateTouchesFundingPath(candidate, extraPaths, contract);
  const overlay = candidate.overlay === true || candidate.production_overlay === true;
  const attestation = candidate.funding_contract || {};

  if (candidate.restore_from_older_artifact === true) {
    errors.push('funding path: old repository ZIP or Lambda package restore over newer production is forbidden');
  }
  if (
    candidate.deploy_lambda_code_sha
    && candidate.live_lambda_code_sha
    && candidate.deploy_lambda_code_sha !== candidate.live_lambda_code_sha
    && (touches || overlay)
    && attestation.explicit_funding_delta_approved !== true
  ) {
    errors.push('funding path: candidate Lambda SHA differs from CURRENT live production without explicit funding-delta revalidation');
  }
  if (candidate.unexplained_funding_drift === true) {
    errors.push('funding path: unexplained funding-path drift; STOP');
  }

  const monthly = candidate.env?.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST
    ?? candidate.flags?.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST;
  const verification = candidate.env?.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED
    ?? candidate.flags?.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED;
  if (String(monthly) === 'true' && attestation.monthly_billing_activation_authorized !== true) {
    errors.push('monthly billing PRODUCTION_POST cannot flip true from a funding-path safeguard');
  }
  if (String(verification) === 'true' && attestation.verification_post_activation_authorized !== true) {
    errors.push('billing verification POST cannot flip true from a funding-path safeguard');
  }

  if (overlay || touches) {
    if (attestation.validated !== true || attestation.tests_passed !== true) {
      errors.push('funding path changed: financial contract must be explicitly revalidated (validated=true and tests_passed=true)');
    }
    if (attestation.contract_id && attestation.contract_id !== FUNDING_CONTRACT_ID) {
      errors.push(`funding contract id mismatch: ${attestation.contract_id}`);
    }
    if (attestation.revalidated_at && !ISO_TIMESTAMP_RE.test(String(attestation.revalidated_at))) {
      errors.push('funding contract revalidated_at must be an ISO timestamp');
    }
    if (overlay) {
      if (attestation.current_live_production_read !== true) {
        errors.push('overlay rule: CURRENT live production must be downloaded/read before touching the funding path');
      }
      if (attestation.invariants_compared !== true) {
        errors.push('overlay rule: protected funding invariants must be compared');
      }
      if (attestation.intended_narrow_delta !== true) {
        errors.push('overlay rule: apply only the intended narrow delta');
      }
      if (attestation.toctou_recorded !== true) {
        errors.push('overlay rule: TOCTOU immediately before deployment is required');
      }
    }
    if (!process.env.FREEDOM_FUNDING_CONTRACT_INNER && !process.env.NODE_TEST_CONTEXT) {
      errors.push(...runFundingContractTests(root));
    }
  }

  if (candidate.funding_operation) {
    const evaluated = evaluateFundingOperation(candidate.funding_operation, contract);
    errors.push(...evaluated.errors);
  }

  if (paths.includes('ops/release-locks/contracts/freedom-platform-funding-contract.json')
    && attestation.validated !== true) {
    errors.push('funding contract file changed without explicit revalidation');
  }

  return errors;
}

export function parseChangedFilesArg(argv = [], root = repoRootFrom(import.meta.url)) {
  const idx = argv.indexOf('--changed-files');
  if (idx < 0) return [];
  const file = argv[idx + 1];
  if (!file) return [];
  const abs = path.resolve(root, file);
  if (!fs.existsSync(abs)) return [];
  return fs.readFileSync(abs, 'utf8').split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const root = repoRootFrom(import.meta.url);
  const contract = loadFundingContract(root);
  const evaluated = evaluateFundingOperation(knownGoodFundingOperation(contract), contract);
  process.stdout.write(`${JSON.stringify({ ok: evaluated.ok, errors: evaluated.errors }, null, 2)}\n`);
  process.exitCode = evaluated.ok ? 0 : 1;
}
