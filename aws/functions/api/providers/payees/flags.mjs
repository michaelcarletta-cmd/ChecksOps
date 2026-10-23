/**
 * Moov payee setup (SQL 113) execution switches.
 *
 * Staging: runs against Moov sandbox (environment 'sandbox') when
 * AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED is true, like the other ported Moov
 * functions.
 *
 * Production: the production guard (executionAllowed('moov')) keeps refusing
 * every payee function with production_execution_blocked unless
 * AWS_MOOV_PAYEES_PRODUCTION_ENABLED is the string "true" as well (default off).
 * The flag only opens payee setup; it never opens money movement, onboarding or
 * any other function, and a production deployment never falls back to sandbox.
 */
import { executionAllowed } from '../../provider-flags.mjs';
import { providerSandboxExecutionEnabled } from '../../sandbox-flags.mjs';

export const PAYEES_PRODUCTION_FLAG = 'AWS_MOOV_PAYEES_PRODUCTION_ENABLED';

export const moovPayeesProductionEnabled = () => (
  String(process.env[PAYEES_PRODUCTION_FLAG] || '') === 'true'
);

/** 'production' | 'sandbox' | null (disabled). Decided by server config only. */
export const payeeDeployment = () => {
  if (executionAllowed('moov')) {
    return moovPayeesProductionEnabled() ? 'production' : null;
  }
  return providerSandboxExecutionEnabled() ? 'sandbox' : null;
};
