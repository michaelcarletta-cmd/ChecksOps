/**
 * Production-safe signature verification. Creates only prod-sig-probe-ad99
 * rows and deletes only those rows. Does not move money or stages.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { resolveSignatureRequestIds, executeSignatureWrite } from './write-signature.mjs';

const signatureRequestAlreadyComplete = (request, signers = []) => {
  const status = String(request?.status || '').toLowerCase();
  if (status === 'completed' || status === 'signed') return true;
  return Array.isArray(signers)
    && signers.length > 0
    && signers.every((signer) => String(signer?.status || '').toLowerCase() === 'signed');
};

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REQUIRED_HOST = 'checksops-production.cyr0q4kcop3c.us-east-1.rds.amazonaws.com';
const MARKER = 'prod-sig-probe-ad99';

const loadAdmin = async () => {
  const arn = process.env.ADMIN_SECRET_ARN || '';
  if (!arn.includes('checksops-production') || !/checksops_admin/i.test(arn)) {
    throw new Error('refusing non-production admin secret arn');
  }
  const sm = new SecretsManagerClient({});
  const out = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(out.SecretString);
  if (!/checksops_admin/i.test(parsed.username || '')) throw new Error('refusing non-admin secret');
  const host = parsed.host || parsed.hostname || process.env.RDS_HOST;
  if (host !== REQUIRED_HOST) throw new Error(`refusing host ${host}`);
  return {
    username: parsed.username,
    password: parsed.password,
    host,
    port: Number(parsed.port || 5432),
    database: parsed.dbname || parsed.database || process.env.DATABASE_NAME || 'checksops',
  };
};

const caPath = [
  path.join(ROOT, 'rds-global-bundle.pem'),
  path.join(ROOT, '..', 'oneshot', 'rds-global-bundle.pem'),
].find((p) => fs.existsSync(p));

const snapshot = async (client) => ({
  money: (await client.query(`
    SELECT
      (SELECT count(*) FROM public.deposit_items) AS deposit_items,
      (SELECT count(*) FROM public.disbursement_splits) AS disbursement_splits,
      (SELECT count(*) FROM public.payment_transfers) AS payment_transfers,
      (SELECT count(*) FROM public.check_billing_events) AS check_billing_events,
      (SELECT count(*) FROM public.platform_fee_line_items) AS platform_fee_line_items
  `)).rows[0],
  stages: (await client.query(`
    SELECT
      (SELECT count(*) FROM public.check_intake_items) AS checks,
      (SELECT count(*) FROM public.claims) AS claims,
      (SELECT md5(string_agg(id::text || ':' || COALESCE(check_stage::text,''), ',' ORDER BY id)) FROM public.check_intake_items) AS check_stage_fp,
      (SELECT md5(string_agg(id::text || ':' || COALESCE(status::text,''), ',' ORDER BY id)) FROM public.claims) AS claim_status_fp
  `)).rows[0],
});

const cleanup = async (client) => {
  await client.query(
    `DELETE FROM public.signature_fields
     WHERE signature_request_id IN (SELECT id FROM public.signature_requests WHERE document_name LIKE $1)`,
    [`${MARKER}%`],
  );
  await client.query(
    `DELETE FROM public.signature_signers
     WHERE signature_request_id IN (SELECT id FROM public.signature_requests WHERE document_name LIKE $1)`,
    [`${MARKER}%`],
  );
  await client.query(
    `DELETE FROM public.esign_event_logs
     WHERE request_id IN (SELECT id FROM public.signature_requests WHERE document_name LIKE $1)`,
    [`${MARKER}%`],
  );
  await client.query(
    `DELETE FROM public.signature_requests WHERE document_name LIKE $1`,
    [`${MARKER}%`],
  );
  await client.query(
    `DELETE FROM public.homeowner_ledger_tokens WHERE homeowner_email = $1`,
    ['prod-sig-probe-ad99@checksops.invalid'],
  );
};

export const handler = async () => {
  const creds = await loadAdmin();
  const client = new Client({
    host: creds.host,
    port: creds.port,
    user: creds.username,
    password: creds.password,
    database: creds.database,
    ssl: caPath ? { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true } : { rejectUnauthorized: false },
    statement_timeout: 30000,
  });
  await client.connect();
  const proofs = {};
  try {
    await cleanup(client);
    const before = await snapshot(client);
    const pair = (await client.query(`
      SELECT c.id AS check_id, c.claim_id, c.tenant_id, cl.org_id
      FROM public.check_intake_items c
      JOIN public.claims cl ON cl.id = c.claim_id
      WHERE c.claim_id IS NOT NULL
      ORDER BY c.updated_at DESC NULLS LAST
      LIMIT 1
    `)).rows[0];
    const otherClaim = (await client.query(`
      SELECT c.id AS check_id, c.claim_id, c.tenant_id
      FROM public.check_intake_items c
      WHERE c.claim_id IS NOT NULL AND c.claim_id IS DISTINCT FROM $1::uuid
      ORDER BY c.updated_at DESC NULLS LAST
      LIMIT 1
    `, [pair.claim_id])).rows[0];
    const foreign = (await client.query(`
      SELECT cl.id AS claim_id, cl.org_id
      FROM public.claims cl
      WHERE cl.org_id IS DISTINCT FROM $1::uuid
      ORDER BY cl.updated_at DESC NULLS LAST
      LIMIT 1
    `, [pair.org_id])).rows[0];
    const file = (await client.query(`
      SELECT file_path, file_name FROM public.check_files
      WHERE check_intake_item_id = $1::uuid AND file_path IS NOT NULL
      ORDER BY created_at DESC NULLS LAST LIMIT 1
    `, [pair.check_id])).rows[0] || { file_path: `probe/${MARKER}.pdf`, file_name: `${MARKER}.pdf` };

    const resolved = await resolveSignatureRequestIds({
      client,
      values: { claim_id: pair.claim_id, check_intake_item_id: pair.check_id },
    });
    proofs.t1_match = resolved.claimId === pair.claim_id && resolved.checkId === pair.check_id && !resolved.error;
    const mismatch = await resolveSignatureRequestIds({
      client,
      values: { claim_id: otherClaim?.claim_id || '00000000-0000-4000-8000-000000000001', check_intake_item_id: pair.check_id },
    });
    proofs.t1_mismatch = mismatch.error === 'claim_mismatch';
    const foreignOnly = await resolveSignatureRequestIds({
      client,
      values: { claim_id: foreign?.claim_id || '00000000-0000-4000-8000-000000000002', check_intake_item_id: pair.check_id },
    });
    proofs.t1_foreign = foreignOnly.error === 'claim_mismatch';

    const raw = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const pending = (await client.query(
      `INSERT INTO public.signature_requests (
         claim_id, check_intake_item_id, document_name, document_path, document_type, field_data, status
       ) VALUES ($1::uuid, $2::uuid, $3, $4, 'other', $5::jsonb, 'pending')
       RETURNING *`,
      [pair.claim_id, pair.check_id, `${MARKER}-pending`, file.file_path, JSON.stringify([{ type: 'signature', required: true, signerIndex: 0 }])],
    )).rows[0];
    const pendingSigner = (await client.query(
      `INSERT INTO public.signature_signers (
         signature_request_id, signer_name, signer_email, signer_type, signing_order, status, token_hash, expires_at
       ) VALUES ($1::uuid, 'Probe Homeowner', 'prod-sig-probe-ad99@checksops.invalid', 'policyholder', 1, 'pending', $2, now() + interval '2 hours')
       RETURNING *`,
      [pending.id, hash],
    )).rows[0];
    const completed = (await client.query(
      `INSERT INTO public.signature_requests (
         claim_id, check_intake_item_id, document_name, document_path, document_type, field_data, status, completed_at
       ) VALUES ($1::uuid, $2::uuid, $3, $4, 'other', '[]'::jsonb, 'completed', now())
       RETURNING *`,
      [pair.claim_id, pair.check_id, `${MARKER}-completed`, file.file_path],
    )).rows[0];
    const completedSigner = (await client.query(
      `INSERT INTO public.signature_signers (
         signature_request_id, signer_name, signer_email, signer_type, signing_order, status, signed_at
       ) VALUES ($1::uuid, 'Probe Signed', 'prod-sig-probe-ad99@checksops.invalid', 'policyholder', 1, 'signed', now())
       RETURNING *`,
      [completed.id],
    )).rows[0];

    proofs.resend_completed_guard = signatureRequestAlreadyComplete(completed, [completedSigner]) === true;
    proofs.resend_pending_eligible = signatureRequestAlreadyComplete(pending, [pendingSigner]) === false;

    const viewed = (await client.query(
      'SELECT public.aws_public_signature_mark_viewed($1) AS doc',
      [hash],
    )).rows[0]?.doc;
    proofs.viewed = viewed?.ok === true && viewed.recorded === true;
    const viewedAgain = (await client.query(
      'SELECT public.aws_public_signature_mark_viewed($1) AS doc',
      [hash],
    )).rows[0]?.doc;
    proofs.viewed_idempotent = viewedAgain?.ok === true && viewedAgain.recorded === false;

    const token = (await client.query(
      `INSERT INTO public.homeowner_ledger_tokens (
         tenant_id, claim_id, homeowner_email, homeowner_name, token, expires_at
       ) VALUES ($1::uuid, $2::uuid, $3, 'Probe Homeowner', $4, now() + interval '2 hours')
       RETURNING token`,
      [pair.tenant_id, pair.claim_id, 'prod-sig-probe-ad99@checksops.invalid', `probe-${MARKER}-${crypto.randomBytes(8).toString('hex')}`],
    )).rows[0];
    const ledger = (await client.query(
      'SELECT public.aws_public_homeowner_ledger_by_token($1) AS doc',
      [token.token],
    )).rows[0]?.doc;
    proofs.h1_pending = Array.isArray(ledger?.pending_signatures) && ledger.pending_signatures.some((row) => row.request_id === pending.id);
    const remintHash = crypto.createHash('sha256').update('remint-probe').digest('hex');
    const remint = (await client.query(
      'SELECT public.aws_public_homeowner_ledger_remint_signer($1, $2::uuid, $3) AS doc',
      [token.token, pendingSigner.id, remintHash],
    )).rows[0]?.doc;
    proofs.h2_remint = remint?.ok === true && remint.signer_id === pendingSigner.id;
    const remintSigned = (await client.query(
      'SELECT public.aws_public_homeowner_ledger_remint_signer($1, $2::uuid, $3) AS doc',
      [token.token, completedSigner.id, remintHash],
    )).rows[0]?.doc;
    proofs.h2_already_signed = remintSigned?.error === 'already_signed';
    const wrongEmail = (await client.query(
      `INSERT INTO public.homeowner_ledger_tokens (
         tenant_id, claim_id, homeowner_email, homeowner_name, token, expires_at
       ) VALUES ($1::uuid, $2::uuid, $3, 'Wrong', $4, now() + interval '2 hours')
       RETURNING token`,
      [pair.tenant_id, pair.claim_id, 'wrong-probe@checksops.invalid', `wrong-${MARKER}-${crypto.randomBytes(8).toString('hex')}`],
    )).rows[0];
    const isolated = (await client.query(
      'SELECT public.aws_public_homeowner_ledger_remint_signer($1, $2::uuid, $3) AS doc',
      [wrongEmail.token, pendingSigner.id, remintHash],
    )).rows[0]?.doc;
    proofs.h2_wrong_homeowner = isolated?.ok !== true;

    const pendingAfter = (await client.query(
      `SELECT id, status FROM public.signature_requests WHERE id = $1::uuid`,
      [pending.id],
    )).rows[0];
    const completedAfter = (await client.query(
      `SELECT id, status, completed_at FROM public.signature_requests WHERE id = $1::uuid`,
      [completed.id],
    )).rows[0];
    proofs.pending_unmutated = pendingAfter.status === 'pending' || pendingAfter.status === 'in_progress';
    proofs.completed_immutable = completedAfter.status === 'completed';

    const inserted = await executeSignatureWrite({
      client,
      table: 'signature_requests',
      op: 'insert',
      values: {
        claim_id: pair.claim_id,
        check_intake_item_id: pair.check_id,
        document_name: `${MARKER}-write`,
        document_path: file.file_path,
        document_type: 'other',
        status: 'draft',
      },
    });
    proofs.write_insert = Boolean(inserted?.rows?.[0]?.id)
      && inserted.rows[0].claim_id === pair.claim_id
      && inserted.rows[0].check_intake_item_id === pair.check_id;

    await cleanup(client);
    await client.query(`DELETE FROM public.homeowner_ledger_tokens WHERE homeowner_email LIKE '%${MARKER}%' OR homeowner_email IN ('wrong-probe@checksops.invalid')`);
    const leftover = (await client.query(
      `SELECT count(*)::int AS n FROM public.signature_requests WHERE document_name LIKE $1`,
      [`${MARKER}%`],
    )).rows[0].n;
    const after = await snapshot(client);
    proofs.cleanup = leftover === 0;
    proofs.money_unchanged = JSON.stringify(before.money) === JSON.stringify(after.money);
    proofs.stages_unchanged = JSON.stringify(before.stages) === JSON.stringify(after.stages);
    const ok = Object.values(proofs).every(Boolean);
    return {
      ok,
      host: creds.host,
      proofs,
      before,
      after,
      pair: { check_id: pair.check_id, claim_id: pair.claim_id },
      other_claim: otherClaim ? { check_id: otherClaim.check_id, claim_id: otherClaim.claim_id } : null,
      foreign_claim: foreign ? { claim_id: foreign.claim_id, org_id: foreign.org_id } : null,
    };
  } catch (error) {
    try { await cleanup(client); } catch { /* ignore */ }
    return { ok: false, error: String(error.message || error), proofs };
  } finally {
    await client.end();
  }
};
