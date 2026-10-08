import { validateReadonlyCoreTables } from './db-readonly-validate.mjs';
import { projectValidation } from './staging-db-readonly-diagnostic-output.mjs';

const safeFailure = (classification) => ({
  schema: 'checksops-staging-db-readonly-diagnostic/v1',
  environment: 'staging',
  status: 'diagnostic_failed',
  classification,
  readOnly: true,
  writesAttempted: false,
});

export const createDiagnosticHandler = ({
  validate = validateReadonlyCoreTables,
  environment = () => process.env,
} = {}) => async () => {
  const env = environment();
  if (env.CHECKSOPS_ENV !== 'staging'
      || env.DATABASE_NAME !== 'checksops'
      || !/^arn:aws:secretsmanager:[^:]+:\d{12}:secret:rds-db-credentials\/checksops-staging\/checksops\/[^:]+$/.test(env.DATABASE_SECRET_ARN || '')) {
    return safeFailure('staging_configuration_unavailable');
  }

  let validation;
  try {
    validation = await validate();
  } catch {
    return safeFailure('validation_unavailable');
  }

  if (validation?.readOnly !== true || validation?.writesAttempted !== false
      || validation?.transactionReadOnly !== 'on'
      || validation?.defaultTransactionReadOnly !== 'on') {
    return safeFailure('readonly_boundary_unverified');
  }

  return projectValidation(validation);
};

export const handler = createDiagnosticHandler();
