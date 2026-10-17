/**
 * Moov onboarding (Compliance & Docs + bank setup) execution switches.
 *
 * Staging: runs against Moov sandbox when AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED
 * is true, exactly like the other ported Moov functions.
 *
 * Production: the existing production guard (executionAllowed('moov')) keeps
 * refusing every onboarding function with production_execution_blocked unless
 * AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED is the string "true" as well. The flag
 * only opens onboarding; it never opens money movement or any other function.
 */
import { executionAllowed } from '../../provider-flags.mjs';
import { providerSandboxExecutionEnabled } from '../../sandbox-flags.mjs';
import { providerWebhookDryRun } from '../../provider-flags.mjs';

export const ONBOARDING_PRODUCTION_FLAG = 'AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED';

export const moovOnboardingProductionEnabled = () => (
  String(process.env[ONBOARDING_PRODUCTION_FLAG] || '') === 'true'
);

/** 'production' | 'sandbox' | null (disabled). Decided by server config only. */
export const onboardingDeployment = () => {
  if (executionAllowed('moov')) {
    return moovOnboardingProductionEnabled() ? 'production' : null;
  }
  return providerSandboxExecutionEnabled() ? 'sandbox' : null;
};

/** Production webhook apply for onboarding status, behind the same flag. */
export const productionOnboardingWebhookApplyEnabled = () => (
  executionAllowed('moov') && moovOnboardingProductionEnabled() && !providerWebhookDryRun()
);
