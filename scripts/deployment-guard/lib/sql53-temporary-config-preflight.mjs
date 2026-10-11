import { CODES, fail, ok } from './errors.mjs';

const FUNCTION_NAME = 'checksops-production-prep-api';
const DEPLOYMENT_TYPE = 'lambda-sql53-temporary-config';

function sameJson(left, right) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export function evaluateSql53TemporaryConfigPreflight(input = {}) {
  const targetEnvironment = input.target_environment || input.environment;
  const targetComponent = input.target_component || input.component;
  const owned = input.owned_components || input.owned_members;
  const fingerprint = input.preflight_live_fingerprint || input.preflight;
  const errors = [];

  if (targetEnvironment !== 'production') {
    errors.push('target_environment must be production');
  }
  if (targetComponent !== FUNCTION_NAME || input.function_name !== FUNCTION_NAME) {
    errors.push('target_component and function_name must identify the production prep Lambda');
  }
  if (input.deployment_type !== DEPLOYMENT_TYPE) {
    errors.push('deployment_type must be the SQL53 temporary configuration writer type');
  }
  if (!Array.isArray(owned) || owned.length !== 1 || owned[0] !== FUNCTION_NAME) {
    errors.push('owned_components must contain only the production prep Lambda');
  }
  if (Object.hasOwn(input, 'owned_member_ops') && input.owned_member_ops != null) {
    errors.push('Lambda member operations are not part of a configuration receipt');
  }
  if (input.apply === true || input.execute === true) {
    errors.push('preflight is evaluate-only and must not request apply or execute');
  }
  const fingerprintKeys = ['code_sha256', 'configuration_sha256', 'function_name', 'revision_id'];
  if (!fingerprint || typeof fingerprint !== 'object'
    || !sameJson(Object.keys(fingerprint).sort(), fingerprintKeys)
    || fingerprint.function_name !== FUNCTION_NAME
    || typeof fingerprint.code_sha256 !== 'string' || !fingerprint.code_sha256
    || !/^[0-9a-f]{64}$/.test(String(fingerprint.configuration_sha256 || ''))
    || typeof fingerprint.revision_id !== 'string' || !fingerprint.revision_id) {
    errors.push('preflight_live_fingerprint must be a fresh pinned production Lambda configuration fingerprint');
  }
  if (!sameJson(input.production_fingerprint, fingerprint)
    || !sameJson(input.immediately_before_fingerprint, fingerprint)) {
    errors.push('production and immediately-before fingerprints must equal preflight_live_fingerprint');
  }
  if (errors.length) {
    return fail(CODES.INVALID_MANIFEST, 'SQL53 temporary Lambda configuration preflight is invalid', { errors });
  }
  return ok({
    target_environment: targetEnvironment,
    target_component: targetComponent,
    deployment_type: DEPLOYMENT_TYPE,
    owned_components: [FUNCTION_NAME],
    fingerprint,
    apply_executed: false,
  });
}
