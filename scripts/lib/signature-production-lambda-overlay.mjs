/**
 * Surgical signature-workflow overlay onto the CURRENT production Lambda tree.
 * Never copies staging wholesale. Preserves production billing, endorsement,
 * clean-stem storage auth, tenant-billing routes, and From-header branding.
 */
import fs from 'node:fs';
import path from 'node:path';

const FROM_HEADER = `import {
  PLATFORM_SUPPORT_EMAIL,
  formatFromHeader,
  resolveEmailBranding,
} from './email-branding.mjs';
`;

const FROM_HELPER = `
const stripViaChecksOps = (name) => String(name || '')
  .replace(/\\s+via\\s+ChecksOps\\s*$/i, '')
  .trim();

/**
 * Signature-request From only. Does not change shared resolveEmailBranding.
 * Display name is the request-owning tenant company/display name; address is
 * always support@checksops.com.
 */
export const signatureRequestFromHeader = (resolved = {}) => {
  const name = stripViaChecksOps(
    resolved.companySubtitle
    || resolved.companyName
    || resolved.fromName
    || '',
  );
  return formatFromHeader(name, PLATFORM_SUPPORT_EMAIL);
};

`;

const SIGNATURE_ALLOWLIST = `  signature_requests: {
    tranche: 3,
    ops: new Set(['insert']),
    columns: new Set([
      'claim_id',
      'check_intake_item_id',
      'document_name',
      'document_path',
      'document_type',
      'field_data',
      'status',
    ]),
    identityColumn: null,
    requiredForWrite: { insert: ['document_name', 'document_path'] },
    filterColumns: new Set(['id', 'claim_id', 'check_intake_item_id']),
    clientIgnored: new Set([
      'id',
      'created_at',
      'sent_at',
      'completed_at',
      'final_pdf_path',
      'access_token',
      'token_hash',
    ]),
    frontend: {
      file: 'MortgageOpsRequestDetail / SignatureRequests',
      op: 'insert',
      reason: 'Create a draft row for the existing send-signature-request engine. Status locked to draft. No email, token, deposit, or billing.',
    },
  },
  signature_signers: {
    tranche: 3,
    ops: new Set(['insert']),
    columns: new Set([
      'signature_request_id',
      'signer_name',
      'signer_email',
      'signer_type',
      'signing_order',
    ]),
    identityColumn: null,
    requiredForWrite: { insert: ['signature_request_id', 'signer_name', 'signer_email'] },
    filterColumns: new Set(['id', 'signature_request_id']),
    clientIgnored: new Set([
      'id',
      'created_at',
      'access_token',
      'token_hash',
      'status',
      'signed_at',
      'viewed_at',
    ]),
    frontend: {
      file: 'MortgageOpsRequestDetail / SignatureRequests',
      op: 'insert',
      reason: 'Attach the homeowner signer to an existing request. Token minting stays in send-signature-request.',
    },
  },
`;

const VIEWED_HELPER = `
export const recordPublicSignerViewed = async (deps, { tokenHash, alreadyViewed }) => {
  if (!tokenHash || alreadyViewed) return { recorded: false, reason: 'skipped' };
  let writer = deps.writeClient;
  let owned = false;
  if (!writer) {
    const loadCredentials = deps.loadDatabaseCredentials || loadDatabaseCredentials;
    const createClient = deps.createWriteClient || deps.createClient || ((config) => new Client(config));
    const credentials = await loadCredentials();
    writer = createClient(buildWriteClientConfig(credentials, { queryTimeoutMillis: 8000 }));
    owned = true;
    await writer.connect();
  }
  try {
    const row = (await writer.query(
      'SELECT public.aws_public_signature_mark_viewed($1) AS doc',
      [tokenHash],
    )).rows[0]?.doc;
    if (!row?.ok) {
      return { recorded: false, error: row?.error || 'viewed_denied' };
    }
    return { recorded: row.recorded === true, viewed_at: row.viewed_at || null };
  } catch (error) {
    return { recorded: false, error: sanitizePublicError(error) };
  } finally {
    if (owned) {
      try { await writer.end(); } catch { /* ignore */ }
    }
  }
};

`;

const replaceOnce = (src, find, repl, label) => {
  if (!src.includes(find)) throw new Error(`overlay missing ${label}`);
  const next = src.replace(find, repl);
  if (next === src) throw new Error(`overlay noop ${label}`);
  return next;
};

export const overlayEsign = (stagingSrc) => {
  let src = stagingSrc;
  src = replaceOnce(
    src,
    "import { resolveEmailBranding } from './email-branding.mjs';\n",
    FROM_HEADER,
    'esign branding import',
  );
  src = replaceOnce(
    src,
    'export const generateRawToken = () => randomBytes(32).toString(\'hex\');\n',
    `${FROM_HELPER}export const generateRawToken = () => randomBytes(32).toString('hex');\n`,
    'esign from helper',
  );
  src = replaceOnce(
    src,
    '  const mailFrom = resolved.from;\n',
    '  const mailFrom = signatureRequestFromHeader(resolved);\n',
    'esign mailFrom',
  );
  if (!src.includes('signatureRequestAlreadyComplete')) {
    throw new Error('esign overlay missing already-complete guard');
  }
  if (!src.includes("error: 'already_signed'")) {
    throw new Error('esign overlay missing 409 already_signed');
  }
  return src;
};

export const overlayHomeowner = (stagingSrc) => {
  let src = stagingSrc;
  src = src.replaceAll(
    "process.env.VITE_APP_URL || 'https://staging.checksops.com'",
    "process.env.SIGN_BASE_URL || process.env.VITE_APP_URL || 'https://checksops.com'",
  );
  if (!src.includes('assembleHomeownerLedgerView')) throw new Error('homeowner missing H1 assembler');
  if (!src.includes('aws_public_homeowner_ledger_remint_signer')) throw new Error('homeowner missing remint helper');
  if (!src.includes('/sign?token=')) throw new Error('homeowner missing Sign Now URL');
  if (src.includes("'https://staging.checksops.com'")) {
    throw new Error('homeowner still defaults to staging origin');
  }
  return src;
};

export const overlayStorage = (productionSrc) => {
  let src = productionSrc;
  if (src.includes('recordPublicSignerViewed')) {
    throw new Error('production storage already has viewed helper; rebase required');
  }
  src = replaceOnce(
    src,
    "import { buildClientConfig, sanitizePublicError } from './db-health.mjs';\n",
    "import { buildClientConfig, buildWriteClientConfig, sanitizePublicError } from './db-health.mjs';\n",
    'storage write-client import',
  );
  src = replaceOnce(
    src,
    'export const isPublicBrandingPath = async (client, bucket, rel) => {\n',
    `${VIEWED_HELPER}export const isPublicBrandingPath = async (client, bucket, rel) => {\n`,
    'storage viewed helper',
  );
  src = replaceOnce(
    src,
    `    const signedUrl = await presignGet(deps, key, {
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
    };`,
    `    const signedUrl = await presignGet(deps, key, {
      expiresIn: SIGNING_DOCUMENT_EXPIRES,
      maxExpires: SIGNING_DOCUMENT_EXPIRES,
    });
    const view = await recordPublicSignerViewed(deps, {
      tokenHash,
      alreadyViewed: Boolean(row.signer?.viewed_at),
    });
    return {
      ok: true,
      statusCode: 200,
      signer: {
        ...row.signer,
        viewed_at: row.signer?.viewed_at || (view.recorded ? new Date().toISOString() : row.signer?.viewed_at),
      },
      request: {
        ...row.request,
        claims: row.claim,
      },
      fields: row.fields || [],
      presets: row.presets || [],
      signedUrl,
      viewedRecorded: view.recorded === true,
      spoofFieldsIgnored: spoof,
    };`,
    'storage viewed persist',
  );
  if (!src.includes('authorizeSignedObject') || !src.includes('authorizeCleanStemSibling')) {
    throw new Error('storage overlay dropped production clean-stem auth');
  }
  return src;
};

export const overlayWriteAllowlist = (productionSrc) => {
  let src = productionSrc;
  if (src.includes('  signature_requests:')) {
    throw new Error('production write-allowlist already has signature_requests');
  }
  src = replaceOnce(
    src,
    `      'source',
      'description',
    ]),
    identityColumn: 'uploaded_by',
    requiredForWrite: { insert: ['check_intake_item_id', 'file_name', 'file_path'] },
    filterColumns: new Set(['id', 'check_intake_item_id']),
    resource: 'check',
    clientIgnored: new Set(['id', 'created_at', 'signature_request_id']),`,
    `      'source',
      'description',
      'signature_request_id',
    ]),
    identityColumn: 'uploaded_by',
    requiredForWrite: { insert: ['check_intake_item_id', 'file_name', 'file_path'] },
    filterColumns: new Set(['id', 'check_intake_item_id', 'file_path']),
    resource: 'check',
    clientIgnored: new Set(['id', 'created_at']),`,
    'check_files signature_request_id',
  );
  src = replaceOnce(
    src,
    '  financial_stepup_log: {',
    `${SIGNATURE_ALLOWLIST}  financial_stepup_log: {`,
    'signature allowlist tables',
  );
  if (!src.includes("ops: new Set(['update', 'insert'])")) {
    throw new Error('write-allowlist accidentally dropped production tenant insert');
  }
  return src;
};

export const overlayWriteCheckWorkflow = (productionSrc) => {
  let src = productionSrc;
  if (src.includes("table === 'signature_requests'")) {
    throw new Error('production write-check-workflow already dispatches signature writes');
  }
  src = replaceOnce(
    src,
    `    out.category = category;
  }
  if (!Object.keys(out).length) {
    return { error: 'missing_required_field', field: 'values', table: 'check_files', op: 'update' };
  }
  const built = buildSet(out, {});`,
    `    out.category = category;
  }
  if ('signature_request_id' in values) {
    const sigId = values.signature_request_id;
    if (sigId !== null && sigId !== '' && !isUuid(sigId)) {
      return { error: 'invalid_uuid', field: 'signature_request_id' };
    }
    out.signature_request_id = sigId || null;
  }
  if (!Object.keys(out).length) {
    return { error: 'missing_required_field', field: 'values', table: 'check_files', op: 'update' };
  }
  const built = buildSet(out, { signature_request_id: 'uuid' });`,
    'check_files signature_request_id update',
  );
  src = replaceOnce(
    src,
    `  if (table === 'user_sessions') return executeUserSessionsTable({ client, mapping, op, values, filters });
  if ([`,
    `  if (table === 'user_sessions') return executeUserSessionsTable({ client, mapping, op, values, filters });
  if (table === 'signature_requests' || table === 'signature_signers') {
    const { executeSignatureWrite } = await import('./write-signature.mjs');
    return executeSignatureWrite({ client, mapping, table, op, values, filters });
  }
  if ([`,
    'signature write dispatch',
  );
  if (!src.includes('rejectPayeeLineIfDeposited') || !src.includes('invalidateEndorsementsForMaterialPayeeChange')) {
    throw new Error('write-check-workflow overlay dropped production payee/endorsement guards');
  }
  return src;
};

export const applySignatureLambdaOverlay = ({ destDir, acceptedDir }) => {
  const readAccepted = (name) => fs.readFileSync(path.join(acceptedDir, name), 'utf8');
  const readDest = (name) => fs.readFileSync(path.join(destDir, name), 'utf8');
  const writeDest = (name, text) => fs.writeFileSync(path.join(destDir, name), text);

  writeDest('esign.mjs', overlayEsign(readAccepted('esign.mjs')));
  writeDest('homeowner.mjs', overlayHomeowner(readAccepted('homeowner.mjs')));
  writeDest('signature-submit.mjs', readAccepted('signature-submit.mjs'));
  writeDest('write-signature.mjs', readAccepted('write-signature.mjs'));
  writeDest('storage.mjs', overlayStorage(readDest('storage.mjs')));
  writeDest('write-allowlist.mjs', overlayWriteAllowlist(readDest('write-allowlist.mjs')));
  writeDest('write-check-workflow.mjs', overlayWriteCheckWorkflow(readDest('write-check-workflow.mjs')));

  return {
    files: [
      'esign.mjs',
      'homeowner.mjs',
      'signature-submit.mjs',
      'write-signature.mjs',
      'storage.mjs',
      'write-allowlist.mjs',
      'write-check-workflow.mjs',
    ],
    preserved: [
      'app-services.mjs',
      'tenant-billing-handlers.mjs',
      'check-deposited.mjs',
      'endorsement-material-invalidation.mjs',
      'allowed-tables.json',
      'write.mjs',
      'index.mjs',
      'data.mjs',
      'email-branding.mjs',
    ],
  };
};
