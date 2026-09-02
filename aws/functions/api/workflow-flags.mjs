/** Tranche 5 kill switch. Only the string `true` enables application-workflow writes.
 *  Independent of AWS_WRITES_ENABLED, T2/T3 check-workflow, and T3 storage flags.
 *  Default is false so T1–T4 and production continue if this is unset.
 */
export const applicationWorkflowWritesEnabled = () =>
  String(process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED || '') === 'true';

export const workflowFlagSnapshot = () => ({
  AWS_APPLICATION_WORKFLOW_WRITES_ENABLED: applicationWorkflowWritesEnabled(),
});
