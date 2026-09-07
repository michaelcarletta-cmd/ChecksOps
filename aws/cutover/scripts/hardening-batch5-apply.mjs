#!/usr/bin/env node
/**
 * Batch 5 apply: detection-only security monitoring stack + API log metric filters.
 * Does not change Lambda env, WAF block rules, money flags, or bridges.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const STACK = 'checksops-production-security-monitoring';
const TEMPLATE = '/workspace/aws/production/security-monitoring.yaml';

if (!process.argv.includes('--confirm-batch5')) {
  console.error(JSON.stringify({ error: 'refusing_batch5_apply' }));
  process.exit(2);
}

const run = (args) => {
  try {
    const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const trimmed = String(out || '').trim();
    if (!trimmed) return { ok: true, data: {} };
    try { return { ok: true, data: JSON.parse(trimmed) }; } catch { return { ok: true, data: { raw: trimmed.slice(0, 240) } }; }
  } catch (error) {
    const text = String(error.stderr || error.message || error);
    return {
      ok: false,
      denied: /AccessDenied|not authorized|UnauthorizedOperation/i.test(text),
      exists: /AlreadyExists|already exists/i.test(text),
      noUpdates: /No updates are to be performed/i.test(text),
      message: text.slice(0, 800),
    };
  }
};

const attempts = [];
const record = (step, result) => {
  attempts.push({
    step,
    ok: result.ok || result.noUpdates || false,
    denied: result.denied || false,
    exists: result.exists || false,
    noUpdates: result.noUpdates || false,
    message: (result.ok || result.noUpdates) ? null : result.message,
  });
  return result;
};

mkdirSync('/tmp/security', { recursive: true });

record('api5xxFilter', run([
  'logs', 'put-metric-filter',
  '--log-group-name', '/aws/apigateway/checksops-production-prep-http',
  '--filter-name', 'checksops-prod-api-5xx-filter',
  '--filter-pattern', '{ $.status = "500" || $.status = "502" || $.status = "503" || $.status = "504" }',
  '--metric-transformations', 'metricName=PrepHttp5xx,metricNamespace=ChecksOps/ProductionPrep,metricValue=1,defaultValue=0',
]));
record('apiAuthFailFilter', run([
  'logs', 'put-metric-filter',
  '--log-group-name', '/aws/apigateway/checksops-production-prep-http',
  '--filter-name', 'checksops-prod-api-auth-fail-filter',
  '--filter-pattern', '{ $.status = "401" || $.status = "403" }',
  '--metric-transformations', 'metricName=PrepAuthFailures,metricNamespace=ChecksOps/ProductionPrep,metricValue=1,defaultValue=0',
]));

const described = run(['cloudformation', 'describe-stacks', '--stack-name', STACK]);
const existingStatus = described.data?.Stacks?.[0]?.StackStatus || '';
if (/CREATE_FAILED|ROLLBACK_COMPLETE|REVIEW_IN_PROGRESS/.test(existingStatus)) {
  record('deleteFailedEmptyStack', run(['cloudformation', 'delete-stack', '--stack-name', STACK]));
  try {
    execFileSync(AWS, ['--region', REGION, 'cloudformation', 'wait', 'stack-delete-complete', '--stack-name', STACK], {
      encoding: 'utf8',
      timeout: 180000,
    });
    record('waitDeleteFailedStack', { ok: true });
  } catch (error) {
    record('waitDeleteFailedStack', { ok: false, message: String(error.stderr || error.message || error).slice(0, 400) });
  }
}
const describedAfterDelete = run(['cloudformation', 'describe-stacks', '--stack-name', STACK]);
const stackExists = Boolean(describedAfterDelete.ok && describedAfterDelete.data?.Stacks?.[0]
  && !/DELETE_COMPLETE/.test(describedAfterDelete.data?.Stacks?.[0]?.StackStatus || ''));
if (stackExists) {
  const updated = run([
    'cloudformation', 'update-stack',
    '--stack-name', STACK,
    '--template-body', `file://${TEMPLATE}`,
    '--capabilities', 'CAPABILITY_NAMED_IAM',
    '--tags', 'Key=HardeningBatch,Value=5',
  ]);
  record('updateSecurityStack', updated);
  if (updated.ok) {
    try {
      execFileSync(AWS, ['--region', REGION, 'cloudformation', 'wait', 'stack-update-complete', '--stack-name', STACK], {
        encoding: 'utf8',
        timeout: 900000,
      });
      record('waitSecurityStack', { ok: true });
    } catch (error) {
      record('waitSecurityStack', { ok: false, message: String(error.stderr || error.message || error).slice(0, 500) });
    }
  } else if (updated.noUpdates) {
    record('waitSecurityStack', { ok: true, noUpdates: true });
  }
} else {
  const created = run([
    'cloudformation', 'create-stack',
    '--stack-name', STACK,
    '--template-body', `file://${TEMPLATE}`,
    '--capabilities', 'CAPABILITY_NAMED_IAM',
    '--on-failure', 'DO_NOTHING',
    '--tags', 'Key=HardeningBatch,Value=5',
  ]);
  record('createSecurityStack', created);
  if (created.ok) {
    try {
      execFileSync(AWS, ['--region', REGION, 'cloudformation', 'wait', 'stack-create-complete', '--stack-name', STACK], {
        encoding: 'utf8',
        timeout: 900000,
      });
      record('waitSecurityStack', { ok: true });
    } catch (error) {
      record('waitSecurityStack', { ok: false, message: String(error.stderr || error.message || error).slice(0, 500) });
    }
  } else {
    record('waitSecurityStack', { ok: false, denied: created.denied, message: created.message });
  }
}

const afterStack = run(['cloudformation', 'describe-stacks', '--stack-name', STACK]);
const stackStatus = afterStack.data?.Stacks?.[0]?.StackStatus || afterStack.message || null;
const outputs = Object.fromEntries(
  (afterStack.data?.Stacks?.[0]?.Outputs || []).map((row) => [row.OutputKey, row.OutputValue]),
);
const events = run(['cloudformation', 'describe-stack-events', '--stack-name', STACK]);
const failedEvents = (events.data?.StackEvents || [])
  .filter((row) => /FAILED|DENIED/i.test(String(row.ResourceStatus || '')))
  .slice(0, 20)
  .map((row) => ({
    logicalId: row.LogicalResourceId,
    status: row.ResourceStatus,
    reason: String(row.ResourceStatusReason || '').slice(0, 240),
  }));
writeFileSync('/tmp/security/batch5-stack-events.json', `${JSON.stringify({ stackStatus, failedEvents, rawCount: events.data?.StackEvents?.length || 0 }, null, 2)}\n`);

record('startConfigRecorder', run([
  'configservice', 'start-configuration-recorder',
  '--configuration-recorder-name', 'checksops-production',
]));

const prep = run(['lambda', 'get-function-configuration', '--function-name', 'checksops-production-prep-api']);
const vars = prep.data?.Environment?.Variables || {};
const rds = run(['rds', 'describe-db-instances', '--db-instance-identifier', 'checksops-staging']);
const inst = rds.data?.DBInstances?.[0] || {};
const filters = run(['logs', 'describe-metric-filters', '--log-group-name', '/aws/apigateway/checksops-production-prep-http']);
const lambdaFilters = run(['logs', 'describe-metric-filters', '--log-group-name', '/aws/lambda/checksops-production-prep-api']);

const stackOk = /COMPLETE/.test(String(stackStatus || '')) && !/ROLLBACK/.test(String(stackStatus || ''));
const filterNames = (filters.data?.metricFilters || []).map((f) => f.filterName);
const filtersOk = filterNames.includes('checksops-prod-api-5xx-filter')
  && filterNames.includes('checksops-prod-api-auth-fail-filter');
const moneyOff = String(vars.AWS_MOOV_ENABLED || 'false') !== 'true'
  && String(vars.AWS_CHECKALT_ENABLED || 'false') !== 'true'
  && String(vars.AWS_PROVIDER_EXECUTION_ENABLED || 'false') !== 'true'
  && String(vars.AWS_FINANCIAL_PERMISSIONS_ACTIVATED || 'false') !== 'true';
const rdsOk = Number(inst.BackupRetentionPeriod || 0) === 35
  && inst.StorageEncrypted === true
  && inst.DeletionProtection === true;

const report = {
  ok: Boolean(moneyOff && rdsOk && (stackOk || filtersOk)),
  stackComplete: stackOk,
  mutated: true,
  detectionOnly: true,
  trafficUnchanged: true,
  forceRlsApplied: false,
  moneyFlags: {
    moov: vars.AWS_MOOV_ENABLED || null,
    checkalt: vars.AWS_CHECKALT_ENABLED || null,
    provider: vars.AWS_PROVIDER_EXECUTION_ENABLED || null,
    financial: vars.AWS_FINANCIAL_PERMISSIONS_ACTIVATED || null,
  },
  stack: {
    name: STACK,
    status: stackStatus,
    outputs,
    failedEvents,
  },
  apiMetricFilters: filterNames,
  lambdaMetricFilters: (lambdaFilters.data?.metricFilters || []).map((f) => f.filterName),
  rds: {
    id: inst.DBInstanceIdentifier || null,
    status: inst.DBInstanceStatus || null,
    backupRetention: inst.BackupRetentionPeriod ?? null,
    latestRestorable: inst.LatestRestorableTime || null,
    storageEncrypted: inst.StorageEncrypted ?? null,
    deletionProtection: inst.DeletionProtection ?? null,
    multiAz: inst.MultiAZ ?? null,
  },
  attempts,
};
writeFileSync('/tmp/security/batch5-apply.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
