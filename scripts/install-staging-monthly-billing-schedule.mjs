#!/usr/bin/env node
/**
 * Staging-only EventBridge/Scheduler probe and install attempt.
 * Does not broaden ChecksOpsCursorCloudStaging. Does not touch production.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { assumeCursorRole } from './cognito-staging-token.mjs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const OUT = '/opt/cursor/artifacts/moov-monthly-billing-preprod';
const RULE = 'moov-monthly-tenant-billing';
const TARGET_URL = 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging/scheduled';

const awsTry = (args) => {
  try {
    const out = execFileSync(AWS, ['--region', 'us-east-1', '--output', 'json', ...args], { encoding: 'utf8' });
    return { ok: true, data: out.trim() ? JSON.parse(out) : {} };
  } catch (error) {
    const text = String(error.stderr || error.stdout || error.message || error);
    return {
      ok: false,
      denied: /AccessDenied|not authorized|explicit deny/i.test(text),
      action: (text.match(/not authorized to perform: ([A-Za-z0-9:]+)/) || [])[1] || `${args[0]}:${args[1]}`,
      error: text.replace(/\s+/g, ' ').trim().slice(0, 420),
    };
  }
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('moov-billing-eventbridge');
  const identity = awsTry(['sts', 'get-caller-identity']);
  const probe = {
    listStacks: awsTry(['cloudformation', 'list-stacks', '--stack-status-filter', 'CREATE_COMPLETE', 'UPDATE_COMPLETE']),
    describeStaging: awsTry(['cloudformation', 'describe-stacks', '--stack-name', 'checksops-staging']),
    listRules: awsTry(['events', 'list-rules', '--name-prefix', 'moov-monthly']),
    listClassA: awsTry(['events', 'list-rules', '--name-prefix', 'checksops']),
    listConnections: awsTry(['events', 'list-connections']),
    listSchedules: awsTry(['scheduler', 'list-schedules']),
    listApiDestinations: awsTry(['events', 'list-api-destinations']),
  };
  const attemptPutRule = awsTry([
    'events', 'put-rule',
    '--name', RULE,
    '--schedule-expression', 'cron(15 6 * * ? *)',
    '--state', 'ENABLED',
    '--description', 'Staging monthly tenant billing simulation only',
  ]);
  const attemptCreateSchedule = awsTry([
    'scheduler', 'create-schedule',
    '--name', RULE,
    '--schedule-expression', 'cron(15 6 * * ? *)',
    '--flexible-time-window', 'Mode=OFF',
    '--target', JSON.stringify({
      Arn: 'arn:aws:scheduler:::aws-sdk:http:invoke',
      RoleArn: 'arn:aws:iam::806168576068:role/checksops-staging-scheduler',
      Input: JSON.stringify({ job: RULE }),
    }),
  ]);
  const created = attemptPutRule.ok === true || attemptCreateSchedule.ok === true;
  const report = {
    generatedAt: new Date().toISOString(),
    identity: identity.data || identity,
    probe,
    attempts: {
      putRule: attemptPutRule,
      createSchedule: attemptCreateSchedule,
    },
    created,
    mechanism: attemptPutRule.ok
      ? 'events.put-rule'
      : (attemptCreateSchedule.ok ? 'scheduler.create-schedule' : null),
    existingApprovedMechanismFound: Boolean(
      probe.listClassA.ok || probe.listConnections.ok || probe.describeStaging.ok,
    ),
    operatorCommand: [
      '# No approved Cursor-role EventBridge/Scheduler write path exists.',
      '# Class A also never created a managed schedule from ChecksOpsCursorCloudStaging.',
      '# Run as the existing operator/deploy role that already owns staging scheduled jobs — not ChecksOpsCursorCloudStaging.',
      `aws events create-connection --name checksops-staging-scheduled --authorization-type API_KEY --auth-parameters ApiKeyAuthParameters={ApiKeyName=x-scheduled-job-secret,ApiKeyValue='$AWS_SCHEDULED_JOB_SECRET'}`,
      `aws events create-api-destination --name checksops-staging-scheduled --connection-arn <connection-arn> --invocation-endpoint ${TARGET_URL} --http-method POST`,
      `aws events put-rule --name ${RULE} --schedule-expression 'cron(15 6 * * ? *)' --state ENABLED --description 'Staging monthly tenant billing simulation'`,
      `aws events put-targets --rule ${RULE} --targets Id=monthly-billing-http,Arn=<api-destination-arn>,RoleArn=<events-invoke-api-dest-role>,HttpParameters='{"HeaderParameters":{"content-type":"application/json"}}',Input='{"job":"${RULE}"}'`,
    ].join('\n'),
    required: {
      rule: RULE,
      cadence: 'cron(15 6 * * ? *)',
      target: TARGET_URL,
      payload: { job: RULE },
      header: 'x-scheduled-job-secret',
    },
    productionTouched: false,
    iamNotBroadened: true,
  };
  await writeFile(`${OUT}/eventbridge-install.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
