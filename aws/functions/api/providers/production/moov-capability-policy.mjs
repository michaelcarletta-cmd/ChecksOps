/**
 * Never re-request Moov capabilities when the family already exists.
 * Re-POST of send-funds / collect-funds / wallet / transfers re-opens billed KYC/KYB.
 */
import {
  capabilitiesStillNeeded,
  capabilityAlreadyPresent,
  capabilityEnabled,
  findCapability,
} from '../readiness.mjs';

export const REQUIRED_MERCHANT_CAPABILITIES = Object.freeze([
  'send-funds.ach',
  'wallet.balance',
]);

export const REQUIRED_RECIPIENT_CAPABILITIES = Object.freeze([
  'transfers',
]);

export const KYC_WRITE_PATH_RE = /\/(capabilities|representatives|files|underwriting|terms-of-service|tos)(?:\/|$)/i;

export const isKycOrCapabilityWrite = ({ method = 'GET', path } = {}) => {
  const verb = String(method || 'GET').toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(verb)) return false;
  return KYC_WRITE_PATH_RE.test(String(path || ''))
    || (verb === 'POST' && String(path || '') === '/accounts');
};

export const refuseKycOrCapabilityWrite = ({ method, path } = {}) => {
  if (!isKycOrCapabilityWrite({ method, path })) return null;
  return {
    ok: false,
    statusCode: 403,
    error: 'moov_kyc_rerequest_blocked',
    provider: 'moov',
    liveProviderCalled: false,
    productionExecution: false,
    method: String(method || '').toUpperCase(),
    path: path || null,
    message: 'This Moov account is already authorized. Re-requesting capabilities, KYC, KYB, or ToS is blocked because it is billed.',
  };
};

export const capabilitiesToRequest = (existingCaps, wanted = REQUIRED_MERCHANT_CAPABILITIES) => (
  capabilitiesStillNeeded(existingCaps, wanted)
);

export {
  capabilitiesStillNeeded,
  capabilityAlreadyPresent,
  capabilityEnabled,
  findCapability,
};
