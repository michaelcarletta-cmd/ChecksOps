import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { summarizeValidation } from './staging-db-readonly-diagnostic.mjs';

export const REGION = 'us-east-1';
export const ROLE = 'ChecksOpsGitHubStagingDbInspect';
export const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-staging/checksops/1788286468693-b4U0Rn';
export const HOST = 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com';

class InspectionError extends Error {}
const refuse = (classification) => { throw new InspectionError(classification); };
const awsJson = (args) => JSON.parse(execFileSync('aws', [
  '--region', REGION, '--output', 'json', ...args,
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }));

export const inspect = async ({
  env = process.env,
  getIdentity = () => awsJson(['sts', 'get-caller-identity']),
  getSecret = () => awsJson(['secretsmanager', 'get-secret-value', '--secret-id', SECRET_ARN]),
  validate = async (options) => {
    const { validateReadonlyCoreTables } = await import('../aws/functions/api/db-readonly-validate.mjs');
    return validateReadonlyCoreTables(options);
  },
} = {}) => {
  if (env.GITHUB_REPOSITORY !== 'michaelcarletta-cmd/ChecksOps'
      || env.GITHUB_REF !== 'refs/heads/main'
      || env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
      || !/^[0-9a-f]{40}$/.test(env.GITHUB_SHA || '')
      || !/^[0-9]+$/.test(env.GITHUB_RUN_ID || '')) refuse('workflow_identity_rejected');
  let identity;
  try { identity = await getIdentity(); } catch { refuse('aws_identity_unavailable'); }
  if (identity?.Account !== '806168576068'
      || identity?.Arn !== `arn:aws:sts::806168576068:assumed-role/${ROLE}/checksops-staging-db-inspect-${env.GITHUB_RUN_ID}`) {
    refuse('aws_identity_rejected');
  }
  let secret;
  try {
    const response = await getSecret();
    if (response?.ARN !== SECRET_ARN || typeof response.SecretString !== 'string') {
      refuse('staging_secret_rejected');
    }
    secret = JSON.parse(response.SecretString);
  } catch { refuse('staging_secret_unavailable'); }
  if (secret?.host !== HOST || secret?.username !== 'checksops'
      || Number(secret.port || 5432) !== 5432
      || typeof secret.password !== 'string' || !secret.password
      || !['postgres', 'checksops'].includes(secret.dbname || secret.database)
      || (secret.dbname && secret.database && secret.dbname !== secret.database)) {
    refuse('staging_secret_rejected');
  }
  const credentials = {
    host: HOST, port: 5432, username: 'checksops', password: secret.password,
    database: 'checksops', secretDatabase: secret.dbname || secret.database,
  };
  const result = await validate({ loadCredentials: async () => credentials });
  if (!result || result.readOnly !== true || result.writesAttempted !== false
      || (result.ok && (result.transactionReadOnly !== 'on'
        || result.currentDatabase !== 'checksops' || result.currentUser !== 'checksops'))
      || (result.transactionReadOnly !== null && result.transactionReadOnly !== 'on')
      || (result.currentDatabase !== null && result.currentDatabase !== 'checksops')
      || (result.currentUser !== null && result.currentUser !== 'checksops')) {
    refuse('validation_identity_rejected');
  }
  const { status, issues } = summarizeValidation({
    ...result, service: 'checksops-api', environment: 'staging',
  }, result.ok ? 200 : 503);
  return { status, issues };
};

export const main = async ({
  writeOutput = console.log,
  writeSummary = (text) => {
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\`\`\`json\n${text}\n\`\`\`\n`);
  },
  ...options
} = {}) => {
  let summary;
  let code;
  try {
    summary = await inspect(options);
    code = summary.status === 'ok' ? 0 : 1;
  } catch (error) {
    summary = {
      status: 'inspection_failed',
      classification: error instanceof InspectionError ? error.message : 'inspection_failed',
    };
    code = 2;
  }
  const text = JSON.stringify(summary);
  writeOutput(text);
  writeSummary(text);
  return code;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
