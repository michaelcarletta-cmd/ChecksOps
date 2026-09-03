/** Financial pre-activation flags. Only the string `true` enables a flag. */

const isTrue = (value) => String(value || '') === 'true';

/**
 * Staging-only simulation of the financial architecture.
 * Writes aws_financial_* certification tables. Never calls CheckAlt/Moov/Plaid.
 */
export const financialSandboxSimulationEnabled = () =>
  isTrue(process.env.AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED);

/**
 * Production financial permission activation. Must stay false until a later
 * human-approved money-movement phase. Simulation does not require this.
 */
export const financialPermissionsActivated = () =>
  isTrue(process.env.AWS_FINANCIAL_PERMISSIONS_ACTIVATED);

export const financialFlagSnapshot = () => ({
  AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED: financialSandboxSimulationEnabled(),
  AWS_FINANCIAL_PERMISSIONS_ACTIVATED: financialPermissionsActivated(),
});
