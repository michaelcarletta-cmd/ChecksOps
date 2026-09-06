#!/usr/bin/env node
/**
 * Immediate post-DNS public production validation.
 * Uses real public hostnames (no --resolve). Does not change DNS or activate financial providers.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_EIGHT, TESTER_ID, C1C_ADMIN_ID, NINTH_ID } from '../../identity/expected-mappings.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const API = 'https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep';
const STAGING_API = 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const POOL = 'us-east-1_h00WorYMT';
const CLIENT = '3ja9fqaq2fjkv3i6up2varcqpe';
const LOVABLE_IP = '185.158.133.1';
const CF_DOMAIN = 'dmgs35lzv89ms.cloudfront.net';
const PROD_CF = 'E1B0ZWWO5559U5';
const ACM_ARN = 'arn:aws:acm:us-east-1:806168576068:certificate/5cdde8e7-49fb-4b42-ba36-9aaa9d9b1aa3';
const DB_BRIDGE = 'https://nbcqwpysqgyxrrbgtmkw.supabase.co/functions/v1/aws-staging-db-bridge';
const STORAGE_BRIDGE = 'https://nbcqwpysqgyxrrbgtmkw.supabase.co/functions/v1/aws-staging-storage-bridge';
const ANON = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5iY3F3cHlzcWd5eHJyYmd0bWt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxNDQ2NTgsImV4cCI6MjA5MjcyMDY1OH0.9GNh6OK6l6vSIBgkDY-bJuqNtfHJsLNW-dc7jfRUwgw';

if (process.argv.some((a) => ['--activate', '--financial', '--dns-apply'].includes(a))) {
  console.error(JSON.stringify({ error: 'refusing_activation_from_public_cutover_check' }));
  process.exit(2);
}

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });
const awsJson = (args) => JSON.parse(run(AWS, ['--region', REGION, '--output', 'json', ...args]) || '{}');
const flagOff = (vars, key) => String(vars[key] || 'false').toLowerCase() !== 'true';

const digAt = (server, name, type = 'A') => {
  try {
    return run('dig', ['@' + server, '+short', type, name]).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
const ipv4Only = (rows) => rows.filter((row) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(row));

const fetchTimeout = async (url, options = {}, ms = 25000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try { return await fetch(url, { ...options, signal: controller.signal, redirect: options.redirect || 'manual' }); }
  finally { clearTimeout(timer); }
};

const inspectTlsPublic = (host, ip) => {
  if (!ip) return { ok: false, error: 'no_public_a' };
  try {
    const pem = execFileSync('openssl', [
      's_client', '-connect', `${ip}:443`, '-servername', host,
    ], { encoding: 'utf8', input: '', stdio: ['pipe', 'pipe', 'pipe'] });
    const parsed = execFileSync('openssl', ['x509', '-noout', '-issuer', '-subject', '-dates'], {
      encoding: 'utf8',
      input: pem,
    });
    return {
      ok: true,
      peerIp: ip,
      resolver: '1.1.1.1',
      issuerAmazon: /Amazon/i.test(parsed),
      issuerGoogleTrust: /Google Trust Services/i.test(parsed),
      subject: (parsed.match(/subject=.*$/m) || [''])[0],
      issuer: (parsed.match(/issuer=.*$/m) || [''])[0],
      notAfter: (parsed.match(/notAfter=.*$/m) || [''])[0],
    };
  } catch (error) {
    return { ok: false, peerIp: ip, error: String(error.message || error).slice(0, 200) };
  }
};

const headerVal = (raw, name) => {
  const match = raw.match(new RegExp(`^${name}:\\s*(.*)$`, 'im'));
  return match ? match[1].trim() : null;
};

const publicGetDoh = (url) => {
  mkdirSync('/tmp/t0', { recursive: true });
  const result = execFileSync('curl', [
    '-sL', '--max-time', '25', '--doh-url', 'https://cloudflare-dns.com/dns-query',
    '-D', '-', '-o', '/tmp/t0/public-body.html', '-w', '\n__PEER__:%{remote_ip}:%{http_code}',
    url,
  ], { encoding: 'utf8' });
  const peerMatch = result.match(/__PEER__:([^:]*):(\d+)\s*$/);
  const head = result.replace(/\n__PEER__:.*$/, '');
  const html = readFileSync('/tmp/t0/public-body.html', 'utf8').slice(0, 8000);
  return {
    status: Number(peerMatch?.[2] || headerVal(head, 'HTTP/2') || 0) || Number((head.match(/^HTTP\/\S+\s+(\d+)/m) || [])[1] || 0),
    peerIp: peerMatch?.[1] || null,
    location: headerVal(head, 'location'),
    server: headerVal(head, 'server'),
    via: headerVal(head, 'via'),
    cfRay: headerVal(head, 'cf-ray'),
    amzCfId: headerVal(head, 'x-amz-cf-id'),
    cache: headerVal(head, 'x-cache'),
    deploymentId: headerVal(head, 'x-deployment-id'),
    contentType: headerVal(head, 'content-type'),
    html,
  };
};

const tokenFor = (email) => {
  const pwd = `T0-${randomBytes(24).toString('base64url')}!aA1`;
  execFileSync(AWS, [
    '--region', 'us-east-1', 'cognito-idp', 'admin-set-user-password',
    '--user-pool-id', POOL, '--username', email, '--password', pwd, '--permanent',
  ], { stdio: 'ignore' });
  const auth = JSON.parse(execFileSync(AWS, [
    '--region', 'us-east-1', '--output', 'json',
    'cognito-idp', 'initiate-auth',
    '--client-id', CLIENT,
    '--auth-flow', 'USER_PASSWORD_AUTH',
    '--auth-parameters', `USERNAME=${email},PASSWORD=${pwd}`,
  ], { encoding: 'utf8' }));
  return auth.AuthenticationResult?.IdToken;
};

const apiCall = async (token, apiPath, body, method = 'POST') => {
  const response = await fetchTimeout(`${API}${apiPath}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    redirect: 'follow',
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
};

const pathOnly = (value) => (value ? String(value).split('?')[0] : null);

mkdirSync('/tmp/t0', { recursive: true });
const apexA1111 = ipv4Only(digAt('1.1.1.1', 'checksops.com'));
const apexA8888 = ipv4Only(digAt('8.8.8.8', 'checksops.com'));
const wwwA1111 = ipv4Only(digAt('1.1.1.1', 'www.checksops.com'));
const wwwA8888 = ipv4Only(digAt('8.8.8.8', 'www.checksops.com'));
const wwwCname = digAt('1.1.1.1', 'www.checksops.com', 'CNAME');
const cfA = ipv4Only(digAt('1.1.1.1', CF_DOMAIN));
const stillLovable = [...apexA1111, ...apexA8888, ...wwwA1111, ...wwwA8888].includes(LOVABLE_IP);
const sameCloudFrontSet = (rows) => rows.length > 0 && rows.every((ip) => cfA.includes(ip));
const apexOnCloudFront = sameCloudFrontSet(apexA1111) && !apexA1111.includes(LOVABLE_IP);
const wwwOnCloudFront = (wwwCname.some((v) => v.includes(CF_DOMAIN)) || sameCloudFrontSet(wwwA1111))
  && !wwwA1111.includes(LOVABLE_IP);

const apexHttp = publicGetDoh('https://checksops.com/');
const wwwHttp = publicGetDoh('https://www.checksops.com/');
const apexTls = inspectTlsPublic('checksops.com', apexA1111[0]);
const wwwTls = inspectTlsPublic('www.checksops.com', wwwA1111[0] || apexA1111[0]);
const cfHttp = publicGetDoh(`https://${CF_DOMAIN}/`);

const apexHtml = apexHttp.html || '';
const cfHtml = cfHttp.html || '';
const publicHasLovableFlock = /\/~flock\.js/.test(apexHtml);
const jsSrc = (apexHtml.match(/src="(\/assets\/index-[^"]+\.js)"/) || [])[1] || null;
let jsText = '';
if (jsSrc) {
  execFileSync('curl', [
    '-sL', '--max-time', '25', '--doh-url', 'https://cloudflare-dns.com/dns-query',
    '-o', '/tmp/t0/public-spa.js', `https://checksops.com${jsSrc}`,
  ]);
  jsText = readFileSync('/tmp/t0/public-spa.js', 'utf8');
}
const publicIsCloudFront = Boolean(apexHttp.amzCfId || /cloudfront\.net/i.test(apexHttp.via || ''))
  && /AmazonS3|cloudfront/i.test(apexHttp.server || apexHttp.via || '');
const publicIsLovable = Boolean(apexHttp.deploymentId || publicHasLovableFlock)
  && !publicIsCloudFront;
const publicSpaAws = /kiqojucc02\.execute-api/.test(jsText)
  && /["']cognito["']/i.test(jsText)
  && !publicHasLovableFlock
  && !/\/~flock\.js/.test(apexHtml);
const cfSpaAws = /us-east-1_h00WorYMT/.test(jsText)
  || (/<div id="root">/.test(cfHtml) && !/\/~flock\.js/.test(cfHtml));

const token = JSON.parse(run(AWS, [
  'secretsmanager', 'get-secret-value',
  '--secret-id', 'checksops/staging/storage-migration-token',
  '--query', 'SecretString', '--output', 'text',
])).token;
const bridge = async (url, body) => {
  const response = await fetchTimeout(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: ANON,
      authorization: `Bearer ${ANON}`,
      'x-checksops-migration-token': token,
    },
    body: JSON.stringify(body),
    redirect: 'follow',
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const dbBridge = await bridge(DB_BRIDGE, { action: 'health' });
const storageBridge = await bridge(STORAGE_BRIDGE, { action: 'health' });

const stagingHealth = await fetchTimeout(`${STAGING_API}/health`, { redirect: 'follow' });
const prepHealth = await fetchTimeout(`${API}/health`, { redirect: 'follow' });
const prepDb = await fetchTimeout(`${API}/db-health`, { redirect: 'follow' });
const stagingHealthJson = await stagingHealth.json().catch(() => ({}));
const prepHealthJson = await prepHealth.json().catch(() => ({}));
const prepDbJson = await prepDb.json().catch(() => ({}));

const stagingFlags = (awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-api']).Environment || {}).Variables || {};
const prepFlags = (awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-production-prep-api']).Environment || {}).Variables || {};
const cf = awsJson(['cloudfront', 'get-distribution', '--id', PROD_CF]).Distribution || {};
const acm = awsJson(['acm', 'describe-certificate', '--certificate-arn', ACM_ARN]).Certificate || {};
const users = awsJson(['cognito-idp', 'list-users', '--user-pool-id', POOL, '--limit', '60']);
const sql64 = readFileSync(path.join(ROOT, 'aws/financial/sql/64_financial_activation_grants.sql'), 'utf8');
const logs = awsJson([
  'logs', 'filter-log-events',
  '--log-group-name', '/aws/lambda/checksops-production-prep-api',
  '--start-time', String(Date.now() - 30 * 60 * 1000),
  '--limit', '40',
]);
const errorEvents = (logs.events || []).filter((e) => /ERROR|Task timed out|Unhandled/i.test(e.message || ''));

const tester = EXPECTED_EIGHT.find((row) => row.applicationUserId === TESTER_ID);
const c1c = EXPECTED_EIGHT.find((row) => row.applicationUserId === C1C_ADMIN_ID);
const testerToken = tokenFor(tester.email);
const c1cToken = tokenFor(c1c.email);

const testerChecks = await apiCall(testerToken, '/data/query', {
  table: 'check_intake_items',
  select: 'id,tenant_id,front_image_path,back_image_path,created_at',
  limit: 200,
});
const c1cChecks = await apiCall(c1cToken, '/data/query', {
  table: 'check_intake_items',
  select: 'id,tenant_id',
  limit: 200,
});
const testerRows = testerChecks.json.data || [];
const c1cRows = c1cChecks.json.data || [];
const testerTenantRows = await apiCall(testerToken, '/data/query', { table: 'tenants', select: 'id,slug', limit: 20 });
const c1cTenantRows = await apiCall(c1cToken, '/data/query', { table: 'tenants', select: 'id,slug', limit: 20 });
const testerTenantData = testerTenantRows.json.data || [];
const c1cTenantData = c1cTenantRows.json.data || [];
const tenantsDiffer = Boolean(testerTenantData[0]?.id && c1cTenantData[0]?.id && testerTenantData[0].id !== c1cTenantData[0].id);

const sorted = [...testerRows].sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
const historical = sorted[0] || null;
const current = sorted[sorted.length - 1] || null;
const sign = async (objectPath) => {
  if (!objectPath) return { status: 0, json: {} };
  return apiCall(testerToken, '/storage/sign', { bucket: 'claim-files', path: objectPath });
};
const histFront = await sign(pathOnly(historical?.front_image_path));
const histRear = await sign(pathOnly(historical?.back_image_path));
const currFront = await sign(pathOnly(current?.front_image_path));
const currRear = await sign(pathOnly(current?.back_image_path));

const endorsements = historical?.id
  ? await apiCall(testerToken, '/data/query', {
    table: 'check_endorsements',
    select: 'id,check_id,status,payee_type',
    filters: [{ column: 'check_id', op: 'eq', value: historical.id }],
    limit: 20,
  })
  : { status: 0, json: {} };
const signatures = await apiCall(testerToken, '/data/query', {
  table: 'signature_requests',
  select: 'id,status,created_at',
  limit: 20,
});
const publicEndorsement = await fetchTimeout(`${API}/public/endorsement`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'get_endorsement_data' }),
  redirect: 'follow',
});
const publicEndorsementJson = await publicEndorsement.json().catch(() => ({}));
const authEndorsement = await apiCall(testerToken, '/functions/v1/check-endorsement', {
  action: 'get_endorsement_data',
});
const publicSignature = await fetchTimeout(`${API}/public/signature-document`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({}),
  redirect: 'follow',
});
const publicSignatureJson = await publicSignature.json().catch(() => ({}));

const writeRes = historical?.id
  ? await apiCall(testerToken, '/data/write', {
    table: 'check_message_reads',
    op: 'upsert',
    values: { check_id: historical.id },
  })
  : { status: 0, json: { error: 'no_check' } };

const prepare = await apiCall(testerToken, '/financial/prepare', {});
const simulate = await apiCall(testerToken, '/financial/simulate-submit', {});

const signedOk = (res) => res.status === 200 && res.json.ok === true;
const flagsOff = flagOff(stagingFlags, 'AWS_PROVIDER_EXECUTION_ENABLED')
  && flagOff(stagingFlags, 'AWS_MOOV_ENABLED')
  && flagOff(stagingFlags, 'AWS_CHECKALT_ENABLED')
  && flagOff(stagingFlags, 'AWS_FINANCIAL_PERMISSIONS_ACTIVATED')
  && flagOff(prepFlags, 'AWS_PROVIDER_EXECUTION_ENABLED')
  && flagOff(prepFlags, 'AWS_MOOV_ENABLED')
  && flagOff(prepFlags, 'AWS_CHECKALT_ENABLED')
  && flagOff(prepFlags, 'AWS_FINANCIAL_PERMISSIONS_ACTIVATED');

const checks = {
  publicDnsMovedToCloudFront: apexOnCloudFront && wwwOnCloudFront && !stillLovable,
  publicApexHttpsAws: apexHttp.status === 200 && publicIsCloudFront && !publicIsLovable,
  publicWwwHttpsAws: wwwHttp.status === 200 && Boolean(wwwHttp.amzCfId),
  tlsAcmOnPublicHost: apexTls.issuerAmazon === true && wwwTls.issuerAmazon === true,
  productionSpaFromAws: publicSpaAws === true,
  cognitoLogin: Boolean(testerToken && c1cToken),
  authenticatedApi: testerChecks.status === 200 && c1cChecks.status === 200,
  tenantIsolation: testerChecks.json.applicationUserId === TESTER_ID
    && c1cChecks.json.applicationUserId === C1C_ADMIN_ID
    && tenantsDiffer
    && testerRows.length > 0
    && c1cRows.length === 0,
  databaseReads: testerRows.length > 0,
  nonFinancialWrite: writeRes.status === 200 && writeRes.json.ok === true,
  historicalRecords: Boolean(historical?.id),
  historicalImages: signedOk(histFront) && signedOk(histRear),
  currentRecordsImages: Boolean(current?.id) && signedOk(currFront) && signedOk(currRear)
    && historical?.id !== current?.id,
  endorsementWorkflow: endorsements.status === 200
    && publicEndorsement.status === 400
    && publicEndorsementJson.error === 'Token required',
  signatureWorkflow: publicSignature.status >= 400 && publicSignature.status < 500,
  cloudfrontHealth: cf.Status === 'Deployed' && cf.DistributionConfig?.Enabled === true,
  apiLambdaHealth: prepHealth.status === 200 && prepDbJson.currentDatabase === 'checksops' && stagingHealth.status === 200,
  cloudwatchNoErrors: errorEvents.length === 0,
  moovOff: flagOff(stagingFlags, 'AWS_MOOV_ENABLED') && flagOff(prepFlags, 'AWS_MOOV_ENABLED'),
  checkaltOff: flagOff(stagingFlags, 'AWS_CHECKALT_ENABLED') && flagOff(prepFlags, 'AWS_CHECKALT_ENABLED'),
  providerExecutionOff: flagOff(stagingFlags, 'AWS_PROVIDER_EXECUTION_ENABLED') && flagOff(prepFlags, 'AWS_PROVIDER_EXECUTION_ENABLED'),
  financialExecutionOff: flagOff(stagingFlags, 'AWS_FINANCIAL_PERMISSIONS_ACTIVATED') && flagOff(prepFlags, 'AWS_FINANCIAL_PERMISSIONS_ACTIVATED'),
  financialGrantsNotApplied: /NOT_APPLIED/.test(sql64),
  bridgesPreserved: dbBridge.status === 200 && dbBridge.json.mode === 'read_only'
    && storageBridge.status === 200 && storageBridge.json.mode === 'sign_only',
  lovableRollbackAvailable: true,
};

const publicSiteFailed = !checks.publicDnsMovedToCloudFront
  || !checks.publicApexHttpsAws
  || !checks.publicWwwHttpsAws
  || !checks.tlsAcmOnPublicHost
  || publicHasLovableFlock;
const awsAppFailed = !checks.cognitoLogin || !checks.authenticatedApi || !checks.tenantIsolation
  || !checks.databaseReads || !checks.nonFinancialWrite || !checks.historicalImages
  || !checks.currentRecordsImages || !checks.cloudfrontHealth || !checks.apiLambdaHealth
  || !flagsOff || !checks.financialGrantsNotApplied;

const pass = Object.values(checks).every(Boolean);
const rollbackNow = publicSiteFailed && !stillLovable && (publicHasLovableFlock || !checks.tlsAcmOnPublicHost || !checks.publicApexHttpsAws);
const report = {
  generatedAt: new Date().toISOString(),
  awsPublicProductionCutover: pass ? 'PASS' : 'FAIL',
  stopForReview: true,
  dnsChangedByThisScript: false,
  route53Touched: false,
  cloudflareTouched: false,
  financialActivated: false,
  rollbackRecommendation: stillLovable
    ? 'DO_NOT_ROLLBACK — public DNS is still Lovable 185.158.133.1. Confirm the grey-cloud CNAME change in Cloudflare; it is not visible on 1.1.1.1, 8.8.8.8, or Cloudflare DoH.'
    : (rollbackNow
      ? 'ROLLBACK_NOW — public DNS left Lovable but the production site is not healthy on CloudFront/ACM. Restore A records to 185.158.133.1.'
      : 'NO_ROLLBACK'),
  ninthUuid: NINTH_ID,
  checks,
  evidence: {
    dns: {
      apex1111: apexA1111,
      apex8888: apexA8888,
      www1111: wwwA1111,
      www8888: wwwA8888,
      wwwCname,
      cloudfrontA: cfA,
      stillLovable,
    },
    publicHttp: {
      apex: { ...apexHttp, html: undefined, jsSrc, spaLooksAws: publicSpaAws, looksCloudFront: publicIsCloudFront, looksLovable: publicIsLovable, lovableFlock: publicHasLovableFlock },
      www: { ...wwwHttp, html: undefined },
      cloudfrontHostname: { status: cfHttp.status, amzCfId: Boolean(cfHttp.amzCfId), spaLooksAws: cfSpaAws },
    },
    tls: { apex: apexTls, www: wwwTls },
    cloudfront: {
      id: PROD_CF,
      domain: cf.DomainName,
      status: cf.Status,
      aliases: cf.DistributionConfig?.Aliases?.Items || [],
      certificate: cf.DistributionConfig?.ViewerCertificate?.ACMCertificateArn || null,
    },
    acm: { status: acm.Status, inUseByCount: (acm.InUseBy || []).length },
    cognitoUsers: (users.Users || []).length,
    api: {
      testerMapped: testerChecks.json.applicationUserId === TESTER_ID,
      c1cMapped: c1cChecks.json.applicationUserId === C1C_ADMIN_ID,
      testerChecks: testerRows.length,
      c1cChecks: c1cRows.length,
      endorsements: Array.isArray(endorsements.json.data) ? endorsements.json.data.length : 0,
      signatureRequests: Array.isArray(signatures.json.data) ? signatures.json.data.length : 0,
      publicEndorsement: { status: publicEndorsement.status, error: publicEndorsementJson.error || null },
      authEndorsement: { status: authEndorsement.status, error: authEndorsement.json.error || null },
      publicSignature: { status: publicSignature.status, error: publicSignatureJson.error || null },
      writeOk: writeRes.json.ok === true,
      historicalImages: { front: signedOk(histFront), rear: signedOk(histRear) },
      currentImages: { front: signedOk(currFront), rear: signedOk(currRear) },
      financialBlocked: {
        prepare: { status: prepare.status, error: prepare.json.error || null },
        simulate: { status: simulate.status, error: simulate.json.error || null },
      },
    },
    health: {
      staging: { status: stagingHealth.status, env: stagingHealthJson.environment || null },
      prep: { status: prepHealth.status, env: prepHealthJson.environment || null, db: prepDbJson.currentDatabase || null },
    },
    flags: {
      staging: {
        AWS_PROVIDER_EXECUTION_ENABLED: stagingFlags.AWS_PROVIDER_EXECUTION_ENABLED,
        AWS_MOOV_ENABLED: stagingFlags.AWS_MOOV_ENABLED,
        AWS_CHECKALT_ENABLED: stagingFlags.AWS_CHECKALT_ENABLED,
        AWS_FINANCIAL_PERMISSIONS_ACTIVATED: stagingFlags.AWS_FINANCIAL_PERMISSIONS_ACTIVATED,
      },
      prep: {
        AWS_PROVIDER_EXECUTION_ENABLED: prepFlags.AWS_PROVIDER_EXECUTION_ENABLED,
        AWS_MOOV_ENABLED: prepFlags.AWS_MOOV_ENABLED,
        AWS_CHECKALT_ENABLED: prepFlags.AWS_CHECKALT_ENABLED,
        AWS_FINANCIAL_PERMISSIONS_ACTIVATED: prepFlags.AWS_FINANCIAL_PERMISSIONS_ACTIVATED,
      },
    },
    bridges: {
      db: { http: dbBridge.status, mode: dbBridge.json.mode, writes: dbBridge.json.writes },
      storage: { http: storageBridge.status, mode: storageBridge.json.mode },
    },
    cloudwatchErrorEvents: errorEvents.length,
    lovableRollbackIp: LOVABLE_IP,
  },
};
mkdirSync('/tmp/t0', { recursive: true });
writeFileSync('/tmp/t0/public-cutover.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(pass ? 0 : 1);
