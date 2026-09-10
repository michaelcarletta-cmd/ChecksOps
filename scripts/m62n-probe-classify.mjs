#!/usr/bin/env node
/**
 * M6.2N operator probe: reopen the existing recipient session once.
 * Never prints the pay-setup token, URL, OAuth token, or provider secrets.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const REGION = process.env.AWS_REGION || 'us-east-1';
const SECRET_ID = process.env.STORAGE_MIGRATION_SECRET_ID || 'checksops/staging/storage-migration-token';
const BRIDGE = 'https://nbcqwpysqgyxrrbgtmkw.supabase.co/functions/v1/aws-staging-db-bridge';
const SESSION = 'https://nbcqwpysqgyxrrbgtmkw.supabase.co/functions/v1/moov-recipient-session';
const TARGET_RECIPIENT = '62a858ff-ee6a-49d7-9898-1c8e4a44227b';
const TARGET_EMAIL = 'carlettacrew@gmail.com';
const ARTIFACT = process.env.M62N_CLASSIFY_OUT || '/opt/cursor/artifacts/m62n_classified_failure.json';

const envText = readFileSync(new URL('../.env.production', import.meta.url), 'utf8');
const anon = (envText.match(/^VITE_SUPABASE_PUBLISHABLE_KEY=(.+)$/m) || [])[1]?.trim();
if (!anon) {
  console.log(JSON.stringify({ ok: false, error: 'missing_anon' }));
  process.exit(1);
}

const awsOut = spawnSync('aws', [
  'secretsmanager', 'get-secret-value',
  '--region', REGION,
  '--secret-id', SECRET_ID,
  '--query', 'SecretString',
  '--output', 'text',
], { encoding: 'utf8' });
if (awsOut.status !== 0) {
  console.log(JSON.stringify({ ok: false, error: 'migration_token_unavailable' }));
  process.exit(1);
}
let migrationToken = awsOut.stdout.trim();
try {
  const parsed = JSON.parse(migrationToken);
  migrationToken = parsed.token || parsed.migrationToken || migrationToken;
} catch { /* raw */ }

const redact = (value) => {
  if (value == null) return value;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text
    .replace(/pay-setup\/[A-Za-z0-9._~-]+/gi, 'pay-setup/[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/sbp_[A-Za-z0-9]+/g, 'sbp_[redacted]')
    .replace(/eyJ[A-Za-z0-9._-]{20,}/g, '[jwt-redacted]');
};

const bridge = async (payload) => {
  const response = await fetch(BRIDGE, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-checksops-migration-token': String(migrationToken).trim(),
      apikey: anon,
      authorization: `Bearer ${anon}`,
    },
    body: JSON.stringify(payload),
  });
  return { http: response.status, body: await response.json().catch(() => ({})) };
};

const extractToken = (html) => {
  if (!html || typeof html !== 'string') return null;
  const match = html.match(/pay-setup\/([A-Za-z0-9._~-]+)/i);
  return match?.[1] || null;
};

const loadSessionToken = async () => {
  const tables = ['email_queue', 'email_outbox', 'transactional_emails'];
  for (const table of tables) {
    let after = '2026-09-10T17:36:00.000Z';
    for (let page = 0; page < 8; page += 1) {
      const { http, body } = await bridge({
        action: 'rows',
        table,
        limit: 200,
        cursorColumn: 'created_at',
        after,
      });
      if (http !== 200 || body.ok !== true) break;
      const rows = Array.isArray(body.rows) ? body.rows : [];
      for (const row of rows) {
        const template = String(row.template_name || row.template_key || '');
        const to = String(row.recipient_email || row.to_email || row.email || '');
        if (template !== 'stakeholder-verify-account') continue;
        if (to.toLowerCase() !== TARGET_EMAIL) continue;
        const token = extractToken(row.html_body || row.html || row.body || row.text_body || '');
        if (token) return { source: table, token };
      }
      if (!body.hasMore) break;
      after = body.nextAfter;
    }
  }
  return { source: null, token: null };
};

const { source, token } = await loadSessionToken();
if (!token) {
  const out = { ok: false, error: 'session_token_not_found', email_source_tried: true };
  mkdirSync(dirname(ARTIFACT), { recursive: true });
  writeFileSync(ARTIFACT, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out));
  process.exit(2);
}

const response = await fetch(SESSION, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    apikey: anon,
    authorization: `Bearer ${anon}`,
    origin: 'https://checksops.com',
    'x-checksops-operator-classify': '1',
  },
  body: JSON.stringify({ token }),
});
const rawBody = await response.text();
let body = {};
try { body = JSON.parse(rawBody); } catch { body = { raw: 'non_json' }; }

const classifyHeader = response.headers.get('x-checksops-moov-classify');
let classify = null;
try { classify = classifyHeader ? JSON.parse(classifyHeader) : null; } catch { classify = null; }

const publicKeys = Object.keys(body || {});
const leaked = ['failure_stage', 'provider_http_status', 'edge_public_key_fp12', 'edge_app_id']
  .filter((key) => Object.prototype.hasOwnProperty.call(body, key));

const report = {
  ok: true,
  probe: 'existing_recipient_session_once',
  recipient_id: TARGET_RECIPIENT,
  token_source: source,
  token_present: true,
  token_sha12: createHash('sha256').update(token).digest('hex').slice(0, 12),
  http_status: response.status,
  public_error: body.error || null,
  public_message: body.message || null,
  public_keys: publicKeys,
  public_body_leaked_classify: leaked,
  classify,
};

mkdirSync(dirname(ARTIFACT), { recursive: true });
writeFileSync(ARTIFACT, `${redact(JSON.stringify(report, null, 2))}\n`);
console.log(redact(JSON.stringify({
  ok: true,
  http_status: report.http_status,
  public_error: report.public_error,
  public_body_leaked_classify: leaked,
  classify_present: Boolean(classify),
  failure_stage: classify?.failure_stage ?? null,
  provider_error_class: classify?.provider_error_class ?? null,
  provider_http_status: classify?.provider_http_status ?? null,
  oauth_token_issued: classify?.oauth_token_issued ?? null,
  account_get_sent: classify?.account_get_sent ?? null,
  edge_public_key_fp12: classify?.edge_public_key_fp12 ?? null,
  edge_matches_aws_public_key_fp: classify?.edge_matches_aws_public_key_fp ?? null,
  edge_app_id: classify?.edge_app_id ?? null,
  cloudflare_code: classify?.cloudflare_code ?? null,
}, null, 2)));
