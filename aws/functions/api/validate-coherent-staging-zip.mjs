#!/usr/bin/env node
/**
 * Import/load validation against the unzipped coherent staging artifact.
 * Does not send email, deploy, or mutate AWS.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const PKG = process.env.COHERENT_PKG || '/tmp/coherent-package/pkg';
const OUT = process.env.IMPORT_LOAD_OUT || '/tmp/coherent-package/import-load.json';
const require = createRequire(`${PKG}/package.json`);

const checks = [];
const fail = (name, detail) => {
  checks.push({ name, ok: false, detail });
};
const pass = (name, detail) => {
  checks.push({ name, ok: true, detail });
};

process.env.AWS_EMAIL_MODE = 'ses-identity';
process.env.CHECKSOPS_ENV = 'staging';
process.env.AWS_EMAIL_SES_LOCK_RECIPIENT = 'mcarletta@freedomadj.com';
process.env.AWS_TENANT_EMAIL_DOMAIN_ENABLED = 'true';
process.env.AWS_EMAIL_SINK_ADDRESS = 'staging-sink@checksops.invalid';
delete process.env.AWS_EMAIL_FROM;

const load = async (rel) => import(pathToFileURL(`${PKG}/${rel}`).href);

try {
  if (!existsSync(`${PKG}/index.mjs`)) throw new Error('missing index.mjs');
  if (!existsSync(`${PKG}/node_modules`)) throw new Error('missing node_modules');
  pass('artifact_layout', 'index.mjs + node_modules present');

  const pkgJson = JSON.parse(readFileSync(`${PKG}/package.json`, 'utf8'));
  pass('package_json', `main=${pkgJson.main} sesv2Listed=${Boolean(pkgJson.dependencies['@aws-sdk/client-sesv2'])}`);
  const sesv2OnDisk = existsSync(`${PKG}/node_modules/@aws-sdk/client-sesv2`);
  if (sesv2OnDisk) fail('sesv2_node_modules', 'unexpected client-sesv2 directory');
  else pass('sesv2_node_modules', 'absent — same as live (dynamic import only)');

  const policy = await load('email-policy.mjs');
  if (policy.emailMode() !== 'ses-identity') fail('email_mode', policy.emailMode());
  else pass('email_mode', 'ses-identity');
  if (policy.sesOutboundSendEnabled() !== false) fail('ses_outbound_disabled', 'SendEmail would be enabled');
  else pass('ses_outbound_disabled', 'ses-identity never SendEmail');
  if (policy.sesIdentityApisEnabled() !== true) fail('ses_identity_apis', 'identity APIs disabled');
  else pass('ses_identity_apis', 'Create/Get/Delete EmailIdentity allowed');

  const recipients = policy.applyRecipientPolicy(['mcarletta@freedomadj.com', 'someone@example.com']);
  const allSink = recipients.every((r) => r.delivery === 'sink' && r.policy === 'staging_ses_identity');
  if (!allSink) fail('recipient_policy', recipients);
  else pass('recipient_policy', 'ses-identity rewrites every recipient to sink');

  let sesSendCalled = 0;
  const email = await load('email.mjs');
  const sendResult = await email.sendViaSesOrSink({
    to: 'mcarletta@freedomadj.com',
    subject: 'import-load probe — must sink',
    html: '<p>no send</p>',
    text: 'no send',
    sesSend: async () => {
      sesSendCalled += 1;
      throw new Error('SES SendEmail must not run during import-load');
    },
  });
  if (sesSendCalled !== 0) fail('send_via_ses_or_sink', `sesSend called ${sesSendCalled}`);
  else if (sendResult.deliveredCount !== 0 || sendResult.sunkCount < 1) fail('send_via_ses_or_sink', sendResult);
  else pass('send_via_ses_or_sink', { mode: sendResult.mode, deliveredCount: sendResult.deliveredCount, sunkCount: sendResult.sunkCount });

  if (typeof email.deliverAuditedEmail !== 'function') fail('deliverAuditedEmail', 'missing');
  else pass('deliverAuditedEmail', 'exported from email.mjs');

  const audited = await load('email-audited.mjs');
  const unified = email.deliverAuditedEmail === audited.deliverAuditedEmail;
  if (!unified) fail('email_audited_barrel', 're-export is not the same function');
  else pass('email_audited_barrel', 'email-audited.mjs re-exports email.mjs');

  const publicLedger = await load('homeowner-ledger-public.mjs');
  const claimUrl = publicLedger.homeownerLedgerTrackingUrl('https://staging.checksops.com', 'tok', 'claim-id');
  const preUrl = publicLedger.homeownerLedgerTrackingUrl('https://staging.checksops.com', 'tok', null);
  if (claimUrl !== 'https://staging.checksops.com/ledger/tok') fail('ledger_claim_url', claimUrl);
  else pass('ledger_claim_url', claimUrl);
  if (preUrl !== 'https://staging.checksops.com/start-claim/tok') fail('ledger_preclaim_url', preUrl);
  else pass('ledger_preclaim_url', preUrl);

  const homeowner = await load('homeowner.mjs');
  if (typeof homeowner.runHomeownerLedgerSend !== 'function') fail('homeowner_ledger_send', 'missing');
  else pass('homeowner_ledger_send', 'runHomeownerLedgerSend present');
  const homeownerSrc = readFileSync(`${PKG}/homeowner.mjs`, 'utf8');
  if (!homeownerSrc.includes("senderOverride: 'checksops'") || !homeownerSrc.includes('homeownerLedgerTrackingUrl(origin, tokenRow.token, claimId)')) {
    fail('homeowner_tracking_markers', 'missing tracking URL helper or send-file override');
  } else if (homeownerSrc.includes("resolveEmailBranding(client, {\n      tenantId,\n      senderOverride: 'checksops'")) {
    fail('homeowner_tracking_markers', 'ledger invite still forces checksops sender');
  } else {
    pass('homeowner_tracking_markers', 'tenant branding on ledger invite; /ledger/{token} helper');
  }

  const identityLink = await load('identity-link.mjs');
  const bad = identityLink.validateExplicitLink({
    applicationUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cognitoSub: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });
  if (bad.ok) fail('identity_link_refuse_sub', bad);
  else pass('identity_link_refuse_sub', bad.error);

  const linked = await identityLink.linkIdentityAccount({
    query: async () => ({ rows: [] }),
  }, {
    applicationUserId: '11111111-1111-4111-8111-111111111111',
    cognitoSub: 'sub-not-a-uuid-value',
    email: 'a@b.c',
    allowCreate: true,
  });
  if (!linked.ok) fail('identity_link_null_safe', linked);
  else pass('identity_link_null_safe', 'SELECT-after-upsert empty row does not throw');

  const workflow = await load('workflow-override.mjs');
  if (typeof workflow.canAdminOverrideCheck !== 'function') fail('workflow_override', Object.keys(workflow));
  else pass('workflow_override', 'canAdminOverrideCheck present');

  const cleanup = await load('workflow-cleanup.mjs');
  pass('workflow_cleanup', Object.keys(cleanup).slice(0, 8));

  const queue = await load('check-queue-totals.mjs');
  pass('check_queue_totals', Object.keys(queue).slice(0, 8));

  const stage = await load('check-status-stage.mjs');
  pass('check_status_stage', Object.keys(stage).slice(0, 8));

  const platform = await load('platform-authz.mjs');
  pass('platform_authz', Object.keys(platform).slice(0, 8));

  const index = await load('index.mjs');
  if (typeof index.handler !== 'function') fail('index_handler', typeof index.handler);
  else pass('index_handler', 'index.handler is a function');

  const health = await index.handler({
    requestContext: { http: { method: 'GET', path: '/health' }, stage: 'staging' },
    rawPath: '/staging/health',
  });
  const healthBody = JSON.parse(health.body || '{}');
  if (health.statusCode !== 200 || healthBody.service !== 'checksops-api') fail('health_route', healthBody);
  else pass('health_route', { statusCode: health.statusCode, environment: healthBody.environment });

  const appServices = readFileSync(`${PKG}/app-services.mjs`, 'utf8');
  if (!appServices.includes("'homeowner-ledger-send'")) fail('class_a_ledger_send', 'action missing');
  else pass('class_a_ledger_send', 'homeowner-ledger-send registered');

  const tenantAdmin = readFileSync(`${PKG}/tenant-admin.mjs`, 'utf8');
  if (tenantAdmin.includes('ON CONFLICT (cognito_sub)')) fail('hire_identity_link', 'hire still upserts by cognito_sub');
  else if (!tenantAdmin.includes('linkIdentityAccount(client')) fail('hire_identity_link', 'linkIdentityAccount not called');
  else pass('hire_identity_link', 'invite + hire use linkIdentityAccount');

  const tenantDomain = await load('tenant-email-domain.mjs');
  if (typeof tenantDomain.requireAuthorizedTenant !== 'function') fail('tenant_isolation', 'requireAuthorizedTenant missing');
  else pass('tenant_isolation', 'requireAuthorizedTenant present');
} catch (error) {
  fail('uncaught', String(error?.stack || error).slice(0, 1200));
}

const report = {
  pkg: PKG,
  ok: checks.every((c) => c.ok),
  passed: checks.filter((c) => c.ok).length,
  failed: checks.filter((c) => !c.ok).length,
  sesSendAttempted: false,
  deploy: false,
  checks,
};
writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
