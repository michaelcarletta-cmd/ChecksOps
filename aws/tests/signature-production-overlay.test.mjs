import test from 'node:test';
import assert from 'node:assert/strict';
import {
  overlayEsign,
  overlayHomeowner,
  overlayStorage,
  overlayWriteAllowlist,
  overlayWriteCheckWorkflow,
} from '../../scripts/lib/signature-production-lambda-overlay.mjs';

const acceptedEsign = `
import { resolveEmailBranding } from './email-branding.mjs';
export const generateRawToken = () => randomBytes(32).toString('hex');
export const signatureRequestAlreadyComplete = () => true;
  const mailFrom = resolved.from;
  return { ok: false, statusCode: 409, error: 'already_signed' };
`;

test('esign overlay keeps production From header and 409 guard', () => {
  const out = overlayEsign(acceptedEsign);
  assert.match(out, /signatureRequestFromHeader/);
  assert.match(out, /PLATFORM_SUPPORT_EMAIL/);
  assert.match(out, /const mailFrom = signatureRequestFromHeader\(resolved\);/);
  assert.equal(out.includes('const mailFrom = resolved.from;'), false);
  assert.match(out, /already_signed/);
});

test('homeowner overlay remints to /sign?token= with production origin', () => {
  const out = overlayHomeowner(`
export const assembleHomeownerLedgerView = () => {};
SELECT public.aws_public_homeowner_ledger_remint_signer($1, $2::uuid, $3)
const origin = String(body.origin || process.env.VITE_APP_URL || 'https://staging.checksops.com').replace(/\\/$/, '');
sign_url: \`\${origin}/sign?token=\${raw}\`,
`);
  assert.match(out, /SIGN_BASE_URL/);
  assert.match(out, /https:\/\/checksops.com/);
  assert.equal(out.includes('https://staging.checksops.com'), false);
});

test('storage overlay records viewed without dropping clean-stem auth', () => {
  const production = `
import { buildClientConfig, sanitizePublicError } from './db-health.mjs';
export const authorizeCleanStemSibling = async () => {};
export const authorizeSignedObject = async () => {};
export const isPublicBrandingPath = async (client, bucket, rel) => {
  return false;
};
    const signedUrl = await presignGet(deps, key, {
      expiresIn: SIGNING_DOCUMENT_EXPIRES,
      maxExpires: SIGNING_DOCUMENT_EXPIRES,
    });
    return {
      ok: true,
      statusCode: 200,
      signer: row.signer,
      request: {
        ...row.request,
        claims: row.claim,
      },
      fields: row.fields || [],
      presets: row.presets || [],
      signedUrl,
      spoofFieldsIgnored: spoof,
    };
`;
  const out = overlayStorage(production);
  assert.match(out, /recordPublicSignerViewed/);
  assert.match(out, /aws_public_signature_mark_viewed/);
  assert.match(out, /authorizeCleanStemSibling/);
  assert.match(out, /authorizeSignedObject/);
});

test('write-allowlist overlay adds signature tables and keeps tenant insert', () => {
  const production = `
  check_files: {
    columns: new Set([
      'source',
      'description',
    ]),
    identityColumn: 'uploaded_by',
    requiredForWrite: { insert: ['check_intake_item_id', 'file_name', 'file_path'] },
    filterColumns: new Set(['id', 'check_intake_item_id']),
    resource: 'check',
    clientIgnored: new Set(['id', 'created_at', 'signature_request_id']),
  },
  tenants: {
    ops: new Set(['update', 'insert']),
  },
  financial_stepup_log: {
    tranche: 7,
  },
`;
  const out = overlayWriteAllowlist(production);
  assert.match(out, /signature_requests:/);
  assert.match(out, /signature_signers:/);
  assert.match(out, /ops: new Set\(\['update', 'insert'\]\)/);
});

test('write-check-workflow overlay dispatches signature writes and keeps payee guards', () => {
  const production = `
    out.category = category;
  }
  if (!Object.keys(out).length) {
    return { error: 'missing_required_field', field: 'values', table: 'check_files', op: 'update' };
  }
  const built = buildSet(out, {});
  if (table === 'user_sessions') return executeUserSessionsTable({ client, mapping, op, values, filters });
  if ([
    'notifications',
  ].includes(table)) {}
  rejectPayeeLineIfDeposited();
  invalidateEndorsementsForMaterialPayeeChange();
`;
  const out = overlayWriteCheckWorkflow(production);
  assert.match(out, /write-signature.mjs/);
  assert.match(out, /signature_request_id/);
  assert.match(out, /rejectPayeeLineIfDeposited/);
});
