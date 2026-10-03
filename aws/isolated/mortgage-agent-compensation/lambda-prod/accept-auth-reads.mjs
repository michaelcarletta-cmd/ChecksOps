#!/usr/bin/env node
/**
 * Production-safe authenticated read/auth-gate proof.
 * Does not send OTP, create Cognito users, manufacture compensation,
 * or call Return/Adjust RPCs.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const FUNCTION_NAME = 'checksops-production-prep-api';
const POOL = 'us-east-1_h00WorYMT';
const ISSUER = `https://cognito-idp.us-east-1.amazonaws.com/${POOL}`;

function loadAwsEnv() {
  for (const line of fs.readFileSync('/tmp/macomp-aws.env', 'utf8').split('\n')) {
    const m = line.match(/^export ([A-Z0-9_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2];
  }
}

function awsJson(args) {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : {};
}

function invokeJson(payload) {
  const outFile = path.join(os.tmpdir(), `auth-accept-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  const raw = execFileSync(AWS, [
    '--region', REGION, 'lambda', 'invoke',
    '--function-name', FUNCTION_NAME,
    '--cli-binary-format', 'raw-in-base64-out',
    '--payload', JSON.stringify(payload),
    outFile,
  ], { encoding: 'utf8' });
  const body = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  let json = body;
  if (body && typeof body.body === 'string') {
    try { json = { ...body, json: JSON.parse(body.body) }; } catch { json = body; }
  }
  return {
    statusCode: body.statusCode,
    json: json.json || json,
    functionError: JSON.parse(raw).FunctionError || null,
  };
}

function httpEvent(rawPath, method, body, claims = null) {
  return {
    rawPath,
    rawQueryString: '',
    headers: { 'content-type': 'application/json' },
    requestContext: {
      stage: '$default',
      http: { method, path: rawPath, sourceIp: '127.0.0.1' },
      authorizer: claims ? { jwt: { claims } } : {},
    },
    body: body == null ? null : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

function claimsFor(user) {
  return { sub: user.sub, email: user.email || null, token_use: 'id', iss: ISSUER };
}

function listPoolUsers() {
  const users = [];
  let token;
  do {
    const args = ['cognito-idp', 'list-users', '--user-pool-id', POOL, '--limit', '60'];
    if (token) args.push('--pagination-token', token);
    const page = awsJson(args);
    for (const user of page.Users || []) {
      const attrs = Object.fromEntries((user.Attributes || []).map((a) => [a.Name, a.Value]));
      users.push({
        username: user.Username,
        sub: attrs.sub || null,
        email: attrs.email || null,
        status: user.UserStatus,
        enabled: user.Enabled !== false,
      });
    }
    token = page.PaginationToken;
  } while (token);
  return users;
}

loadAwsEnv();
const poolUsers = listPoolUsers().filter((u) => u.sub && u.enabled);
const classified = [];
for (const user of poolUsers) {
  const me = invokeJson(httpEvent('/identity/me', 'GET', null, claimsFor(user)));
  const body = me.json || {};
  classified.push({
    sub_prefix: String(user.sub).slice(0, 8),
    email_domain: user.email && user.email.includes('@') ? user.email.split('@')[1] : null,
    statusCode: me.statusCode,
    error: body.error || null,
    roles: body.roles || [],
    isMasterOwner: body.isMasterOwner === true,
    applicationUserId: body.applicationUserId || null,
    tenants: (body.tenants || []).map((t) => t.role),
    mortgageAgentStatus: body.mortgageAgentStatus || null,
    identitySource: body.identitySource || null,
  });
}

const admin = classified.find((row) =>
  row.statusCode === 200 && (row.isMasterOwner || row.roles.includes('admin')),
) || null;
const agent = classified.find((row) =>
  row.statusCode === 200
  && row.roles.includes('mortgage_agent')
  && !row.roles.includes('admin')
  && row.isMasterOwner !== true,
) || null;
const tenantOnly = classified.find((row) =>
  row.statusCode === 200
  && !row.roles.includes('admin')
  && !row.roles.includes('mortgage_agent')
  && row.isMasterOwner !== true
  && (row.tenants || []).length > 0,
) || null;

const adminUser = admin && poolUsers.find((u) => u.sub && admin.applicationUserId);
// Re-resolve full user objects by matching identity/me applicationUserId via another /identity/me is enough;
// we still need the cognito sub for later invokes. Recover it from poolUsers by probing again is wasteful;
// store sub on classified rows instead.
const classifiedWithSub = classified.map((row, i) => ({ ...row, sub: poolUsers[i].sub }));
const adminFull = classifiedWithSub.find((row) =>
  row.statusCode === 200 && (row.isMasterOwner || row.roles.includes('admin')),
);
const agentFull = classifiedWithSub.find((row) =>
  row.statusCode === 200
  && row.roles.includes('mortgage_agent')
  && !row.roles.includes('admin')
  && row.isMasterOwner !== true,
);

function compensation(action, extra = {}, user = null) {
  return invokeJson(httpEvent(
    '/functions/v1/mortgage-agent-compensation',
    'POST',
    { action, ...extra },
    user ? claimsFor(user) : null,
  ));
}

const api = {};
if (adminFull) {
  const adminClaimsUser = { sub: adminFull.sub, email: null };
  api.admin_roster = compensation('roster', {}, adminClaimsUser);
  api.admin_monthly = compensation('monthly', { period: '2026-10' }, adminClaimsUser);
  api.admin_entries = compensation('entries', { period: '2026-10' }, adminClaimsUser);
  api.admin_in_progress = compensation('in_progress', {}, adminClaimsUser);
  api.admin_return_missing_reason = compensation('return_to_queue', {
    request_id: '00000000-0000-0000-0000-000000000001',
  }, adminClaimsUser);
  api.admin_adjust_invalid = compensation('adjust', {
    parent_entry_id: '00000000-0000-0000-0000-000000000001',
    amount_cents: 0,
    reason: '',
  }, adminClaimsUser);
  api.admin_hire_missing_fields = invokeJson(httpEvent(
    '/functions/v1/hire-mortgage-agent',
    'POST',
    { email: '', full_name: '' },
    claimsFor(adminClaimsUser),
  ));
}
if (agentFull) {
  const agentClaimsUser = { sub: agentFull.sub, email: null };
  api.agent_roster = compensation('roster', {}, agentClaimsUser);
  api.agent_monthly = compensation('monthly', { period: '2026-10' }, agentClaimsUser);
  api.agent_return = compensation('return_to_queue', {
    request_id: '00000000-0000-0000-0000-000000000001',
    reason: 'do-not-exercise',
  }, agentClaimsUser);
  api.agent_adjust = compensation('adjust', {
    parent_entry_id: '00000000-0000-0000-0000-000000000001',
    amount_cents: -1,
    reason: 'do-not-exercise',
  }, agentClaimsUser);
  api.agent_hire = invokeJson(httpEvent(
    '/functions/v1/hire-mortgage-agent',
    'POST',
    { email: 'do-not-hire@example.invalid', full_name: 'Do Not Hire' },
    claimsFor(agentClaimsUser),
  ));
  api.agent_me = invokeJson(httpEvent('/identity/me', 'GET', null, claimsFor(agentClaimsUser)));
}

const summarize = (row) => {
  if (!row) return null;
  const j = row.json || {};
  return {
    statusCode: row.statusCode,
    error: j.error || null,
    ok: j.ok,
    agent_count: Array.isArray(j.agents) ? j.agents.length : undefined,
    agents_roles_only: Array.isArray(j.agents)
      ? j.agents.map((a) => ({
        application_user_id: a.application_user_id,
        queued_count: a.queued_count,
        in_progress_count: a.in_progress_count,
        completed_count: a.completed_count,
        account_status: a.account_status,
      }))
      : undefined,
    period: j.period,
    monthly_rows: Array.isArray(j.rows) ? j.rows.length : undefined,
    totals: j.totals,
    entry_count: Array.isArray(j.entries) ? j.entries.length : undefined,
    request_count: Array.isArray(j.requests) ? j.requests.length : undefined,
    roles: j.roles,
    mortgageAgentStatus: j.mortgageAgentStatus,
    tenants: Array.isArray(j.tenants) ? j.tenants.length : undefined,
    functionError: row.functionError,
  };
};

const failures = [];
if (!adminFull) failures.push('admin_identity_not_found');
if (!agentFull) failures.push('agent_identity_not_found');
if (api.admin_roster && api.admin_roster.statusCode !== 200) failures.push(`admin_roster_${api.admin_roster.statusCode}`);
if (api.admin_monthly && api.admin_monthly.statusCode !== 200) failures.push(`admin_monthly_${api.admin_monthly.statusCode}`);
if (api.admin_entries && api.admin_entries.statusCode !== 200) failures.push(`admin_entries_${api.admin_entries.statusCode}`);
if (api.admin_in_progress && api.admin_in_progress.statusCode !== 200) failures.push(`admin_in_progress_${api.admin_in_progress.statusCode}`);
if (api.admin_return_missing_reason && api.admin_return_missing_reason.statusCode !== 400) {
  failures.push(`admin_return_gate_${api.admin_return_missing_reason.statusCode}`);
}
if (api.admin_adjust_invalid && api.admin_adjust_invalid.statusCode !== 400) {
  failures.push(`admin_adjust_gate_${api.admin_adjust_invalid.statusCode}`);
}
if (api.admin_monthly?.json?.totals && Number(api.admin_monthly.json.totals.files_worked || 0) !== 0) {
  failures.push('monthly_not_zero');
}
if (api.admin_entries && Array.isArray(api.admin_entries.json?.entries) && api.admin_entries.json.entries.length !== 0) {
  failures.push('entries_not_empty');
}
for (const name of ['agent_roster', 'agent_monthly', 'agent_return', 'agent_adjust', 'agent_hire']) {
  if (api[name] && api[name].statusCode !== 403) failures.push(`${name}_${api[name].statusCode}`);
}
if (api.agent_me && api.agent_me.statusCode === 200) {
  const tenants = api.agent_me.json?.tenants || [];
  if (tenants.length !== 0) failures.push('agent_has_tenant_users');
  if (!(api.agent_me.json?.roles || []).includes('mortgage_agent')) failures.push('agent_missing_mortgage_agent_role');
}
if (api.admin_hire_missing_fields && ![400, 403].includes(api.admin_hire_missing_fields.statusCode)) {
  failures.push(`admin_hire_${api.admin_hire_missing_fields.statusCode}`);
}

const report = {
  ok: failures.length === 0,
  inspected_at: new Date().toISOString(),
  pool_user_count: poolUsers.length,
  classified_counts: {
    linked_200: classified.filter((r) => r.statusCode === 200).length,
    identity_not_linked: classified.filter((r) => r.error === 'identity_not_linked').length,
    admin: classified.filter((r) => r.statusCode === 200 && (r.isMasterOwner || r.roles.includes('admin'))).length,
    mortgage_agent_only: classified.filter((r) => r.statusCode === 200 && r.roles.includes('mortgage_agent') && !r.roles.includes('admin')).length,
  },
  admin: adminFull && {
    applicationUserId: adminFull.applicationUserId,
    roles: adminFull.roles,
    isMasterOwner: adminFull.isMasterOwner,
    identitySource: adminFull.identitySource,
    tenant_roles: adminFull.tenants,
  },
  agent: agentFull && {
    applicationUserId: agentFull.applicationUserId,
    roles: agentFull.roles,
    mortgageAgentStatus: agentFull.mortgageAgentStatus,
    identitySource: agentFull.identitySource,
    tenant_roles: agentFull.tenants,
  },
  api: Object.fromEntries(Object.entries(api).map(([k, v]) => [k, summarize(v)])),
  failures,
  notes: {
    return_rpc_called: false,
    adjust_rpc_called: false,
    compensation_created: false,
    cognito_modified: false,
    freedom_request_used: false,
  },
};
fs.writeFileSync('/opt/cursor/artifacts/prod-lambda-auth-accept.json', `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) process.exit(2);
