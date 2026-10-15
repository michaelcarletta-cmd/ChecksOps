/**
 * POST /financial/checkalt-dual-control
 *
 * Check Alt dual control (second-person approval) has been removed. Every
 * production Check Alt submit requires the submitter's own deposit.submit
 * step-up; a second approval never substitutes for it. This route stays
 * registered so callers get an explicit refusal: it never opens a database
 * connection, never writes financial_stepup_log, and never calls Check Alt.
 */
export async function handleCheckAltDualControl() {
  return {
    ok: false,
    statusCode: 410,
    error: 'dual_control_removed',
    message: 'Check Alt dual-control approval has been removed. Each submitter must complete their own two-factor step-up.',
    liveProviderCalled: false,
    productionExecution: false,
  };
}
