/** Staging-only provider sandbox execution. Never reuse the production master flag. */

const isTrue = (value) => String(value || '') === 'true';

/**
 * Allows real HTTP to provider *sandbox/test* environments only.
 * Independent of AWS_PROVIDER_EXECUTION_ENABLED. Default false.
 */
export const providerSandboxExecutionEnabled = () =>
  isTrue(process.env.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED);

export const sandboxFlagSnapshot = () => ({
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: providerSandboxExecutionEnabled(),
});
