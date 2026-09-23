/**
 * Class A document / PDF generators for AWS staging.
 * Uses pdf-lib. Writes to tenant-scoped S3 claim-files. No money movement.
 */
import { randomUUID } from 'node:crypto';
import { PutObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { withIdentity } from './data.mjs';
import { normalizePath, s3KeyFor } from './storage-paths.mjs';

const s3 = () => new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const filesBucket = () => process.env.FILES_BUCKET || '';

const buildSimplePdf = async (title, lines = []) => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let y = 740;
  page.drawText(String(title).slice(0, 80), { x: 48, y, size: 16, font: bold, color: rgb(0.1, 0.1, 0.1) });
  y -= 28;
  page.drawText('ChecksOps staging document', { x: 48, y, size: 10, font, color: rgb(0.4, 0.4, 0.4) });
  y -= 24;
  for (const line of lines) {
    if (y < 48) break;
    page.drawText(String(line || '').slice(0, 95), { x: 48, y, size: 11, font, color: rgb(0.15, 0.15, 0.15) });
    y -= 16;
  }
  return Buffer.from(await doc.save());
};

const putPdf = async (relPath, bytes, contentType = 'application/pdf') => {
  const key = s3KeyFor('claim-files', normalizePath(relPath, 'claim-files'));
  if (!filesBucket() || !key) throw new Error('s3_not_configured');
  await s3().send(new PutObjectCommand({
    Bucket: filesBucket(),
    Key: key,
    Body: bytes,
    ContentType: contentType,
  }));
  const url = await getSignedUrl(
    s3(),
    new GetObjectCommand({ Bucket: filesBucket(), Key: key }),
    { expiresIn: 300 },
  );
  return { path: relPath, key, url };
};

export const handleGenerateChecksopsDoc = async (event) => withIdentity(event, async ({
  client, mapping, body, spoof,
}) => {
  const template = body.template || 'tpa';
  const claimId = body.claim_id || body.claimId;
  if (!claimId || !['tpa', 'lien_waiver'].includes(template)) {
    return { ok: false, statusCode: 400, error: 'invalid_payload', spoofFieldsIgnored: spoof };
  }
  const claim = (await client.query(
    `SELECT id, claim_number, policyholder_address
     FROM public.claims WHERE id = $1::uuid LIMIT 1`,
    [claimId],
  )).rows[0];
  if (!claim) return { ok: false, statusCode: 404, error: 'claim_not_found', spoofFieldsIgnored: spoof };

  const title = template === 'tpa' ? 'Third Party Authorization' : 'Lien Waiver & Release';
  const lines = [
    `Homeowner: ${body.homeowner_name || ''}`,
    `Property: ${body.property_address || claim.policyholder_address || ''}`,
    `Claim #: ${body.claim_number || claim.claim_number || ''}`,
    `Carrier: ${body.carrier || ''}`,
    `Policy #: ${body.policy_number || ''}`,
    `Mortgage: ${body.mortgage_company || ''}`,
    `Generated for staging UAT — not a production legal instrument.`,
  ];
  const bytes = await buildSimplePdf(title, lines);
  const tenantScope = body.tenant_id || mapping.application_user_id || 'staging';
  const rel = `docs/${tenantScope}/${claimId}/${template}-${Date.now()}.pdf`;
  const uploaded = await putPdf(rel, bytes);

  await client.query(
    `INSERT INTO public.loss_draft_documents (
       id, loss_draft_id, claim_id, doc_type, file_path, created_by, created_at
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, now())`,
    [
      randomUUID(),
      body.loss_draft_id || null,
      claimId,
      template,
      uploaded.path,
      mapping.application_user_id,
    ],
  ).catch(() => {});

  return {
    ok: true,
    statusCode: 200,
    path: uploaded.path,
    signedUrl: uploaded.url,
    template,
    engine: 'aws_pdf_lib',
    spoofFieldsIgnored: spoof,
  };
}, { write: true, commit: true });

export const handleGenerateDocument = async (event) => withIdentity(event, async ({
  client, mapping, body, spoof,
}) => {
  const templateId = body.templateId || body.template_id;
  const claimId = body.claimId || body.claim_id;
  if (!templateId || !claimId) {
    return { ok: false, statusCode: 400, error: 'missing_fields', spoofFieldsIgnored: spoof };
  }
  const claim = (await client.query(
    `SELECT id, claim_number FROM public.claims WHERE id = $1::uuid LIMIT 1`,
    [claimId],
  )).rows[0];
  if (!claim) return { ok: false, statusCode: 404, error: 'claim_not_found', spoofFieldsIgnored: spoof };

  const bytes = await buildSimplePdf('ChecksOps document', [
    `Template: ${templateId}`,
    `Claim: ${claim.claim_number || claimId}`,
    `Generated on AWS staging`,
  ]);
  const rel = `docs/${mapping.application_user_id || 'staging'}/${claimId}/template-${templateId}-${Date.now()}.pdf`;
  const uploaded = await putPdf(rel, bytes);
  return {
    ok: true,
    statusCode: 200,
    path: uploaded.path,
    url: uploaded.url,
    signedUrl: uploaded.url,
    engine: 'aws_pdf_lib',
    spoofFieldsIgnored: spoof,
    applicationUserId: mapping.application_user_id,
  };
}, { write: true, commit: true });

export const handleGeneratePolDocx = async (event) => withIdentity(event, async ({
  client, mapping, body, spoof,
}) => {
  const claimId = body.claimId || body.claim_id;
  if (!claimId) return { ok: false, statusCode: 400, error: 'missing_claim_id', spoofFieldsIgnored: spoof };
  const claim = (await client.query(
    `SELECT id, claim_number FROM public.claims WHERE id = $1::uuid LIMIT 1`,
    [claimId],
  )).rows[0];
  if (!claim) return { ok: false, statusCode: 404, error: 'claim_not_found', spoofFieldsIgnored: spoof };
  // Staging: emit PDF stand-in (DOCX parity deferred); frontend mainly needs a path/URL.
  const bytes = await buildSimplePdf('Proof of Loss (staging PDF stand-in)', [
    `Claim: ${claim.claim_number || claimId}`,
    JSON.stringify(body.polData || {}).slice(0, 400),
  ]);
  const rel = `docs/${mapping.application_user_id || 'staging'}/${claimId}/pol-${Date.now()}.pdf`;
  const uploaded = await putPdf(rel, bytes);
  return {
    ok: true,
    statusCode: 200,
    path: uploaded.path,
    signedUrl: uploaded.url,
    format: 'pdf_standin',
    engine: 'aws_pdf_lib',
    spoofFieldsIgnored: spoof,
  };
}, { write: true, commit: true });

export const handleContractsPdf = async (event) => withIdentity(event, async ({
  client, body, spoof,
}) => {
  const claimId = body.claimId || body.claim_id;
  if (!claimId) return { ok: false, statusCode: 400, error: 'missing_claim_id', spoofFieldsIgnored: spoof };
  let claim;
  try {
    claim = (await client.query(
      `SELECT id, contract_pdf_path FROM public.claims WHERE id = $1::uuid LIMIT 1`,
      [claimId],
    )).rows[0];
  } catch {
    claim = (await client.query(
      `SELECT id FROM public.claims WHERE id = $1::uuid LIMIT 1`,
      [claimId],
    )).rows[0];
  }
  if (!claim) return { ok: false, statusCode: 404, error: 'claim_not_found', spoofFieldsIgnored: spoof };
  if (claim.contract_pdf_path) {
    const rel = normalizePath(claim.contract_pdf_path, 'claim-files');
    const key = s3KeyFor('claim-files', rel);
    const url = await getSignedUrl(
      s3(),
      new GetObjectCommand({ Bucket: filesBucket(), Key: key }),
      { expiresIn: 300 },
    );
    return { ok: true, statusCode: 200, signedUrl: url, path: claim.contract_pdf_path, spoofFieldsIgnored: spoof };
  }
  const bytes = await buildSimplePdf('Contract (staging)', [`Claim ${claimId}`]);
  const rel = `docs/staging/${claimId}/contract-${Date.now()}.pdf`;
  const uploaded = await putPdf(rel, bytes);
  return { ok: true, statusCode: 200, signedUrl: uploaded.url, path: uploaded.path, spoofFieldsIgnored: spoof };
}, { write: true, commit: true });

export const handleRetryPdfGeneration = async (event) => withIdentity(event, async ({
  client, body, spoof,
}) => {
  const requestId = body.requestId || body.request_id;
  if (!requestId) return { ok: false, statusCode: 400, error: 'missing_request_id', spoofFieldsIgnored: spoof };
  const bytes = await buildSimplePdf('Signature certificate (staging retry)', [`Request ${requestId}`]);
  const rel = `docs/signatures/${requestId}-${Date.now()}.pdf`;
  const uploaded = await putPdf(rel, bytes);
  await client.query(
    `UPDATE public.signature_requests
     SET certificate_pdf_path = $2, updated_at = now()
     WHERE id = $1::uuid`,
    [requestId, uploaded.path],
  ).catch(() => {});
  return {
    ok: true,
    statusCode: 200,
    path: uploaded.path,
    signedUrl: uploaded.url,
    spoofFieldsIgnored: spoof,
  };
}, { write: true, commit: true });

export const handleGenerateInvoice = async (event) => withIdentity(event, async ({
  body, spoof,
}) => {
  const bytes = await buildSimplePdf('Invoice (staging)', [
    `Invoice: ${body.invoiceNumber || body.invoice_number || 'N/A'}`,
    `Amount: ${body.amount || ''}`,
    `Tenant: ${body.tenantName || body.tenant_name || ''}`,
  ]);
  const rel = `docs/invoices/invoice-${Date.now()}.pdf`;
  const uploaded = await putPdf(rel, bytes);
  return {
    ok: true,
    statusCode: 200,
    path: uploaded.path,
    signedUrl: uploaded.url,
    spoofFieldsIgnored: spoof,
  };
}, { write: true, commit: true });

export const handleGenerateEndorsementPacket = async (event) => withIdentity(event, async ({
  client, mapping, body, spoof,
}) => {
  const checkId = body.checkId || body.check_id;
  if (!checkId) return { ok: false, statusCode: 400, error: 'missing_check_id', spoofFieldsIgnored: spoof };
  const row = (await client.query(
    `SELECT id, tenant_id FROM public.check_intake_items WHERE id = $1::uuid LIMIT 1`,
    [checkId],
  )).rows[0];
  if (!row) return { ok: false, statusCode: 404, error: 'check_not_found', spoofFieldsIgnored: spoof };
  const bytes = await buildSimplePdf('Endorsement packet (staging)', [
    `Check ${checkId}`,
    `Generated by ${mapping.application_user_id}`,
  ]);
  const rel = `endorsement-packets/${row.tenant_id}/${checkId}-${Date.now()}.pdf`;
  const uploaded = await putPdf(rel, bytes);
  await client.query(
    `UPDATE public.check_intake_items
     SET endorsement_packet_path = $2, endorsement_render_status = 'completed', updated_at = now()
     WHERE id = $1::uuid`,
    [checkId, uploaded.path],
  ).catch(() => {});
  return {
    ok: true,
    statusCode: 200,
    path: uploaded.path,
    signedUrl: uploaded.url,
    engine: 'aws_pdf_lib',
    spoofFieldsIgnored: spoof,
  };
}, { write: true, commit: true });

export const handleCompositeEndorsementSignatures = async (event) => withIdentity(event, async ({
  client, body, spoof,
}) => {
  const { compositeEndorsementSignatures } = await import('./endorsement-composite.mjs');
  const checkId = body.checkId || body.check_id;
  const result = await compositeEndorsementSignatures({
    client,
    checkId,
    overrideData: body.overrideData || body.override || null,
  });
  if (result?.ok && (result.back_image_deposit_path || result.endorsed_back_image_path)) {
    const { retryAutoAdvanceAfterOfficialRear } = await import('./check-endorsement.mjs');
    const advanced = await retryAutoAdvanceAfterOfficialRear(client, checkId);
    return { ...result, ...advanced, officialRearReady: true, spoofFieldsIgnored: spoof };
  }
  return { ...result, spoofFieldsIgnored: spoof };
}, { write: true, commit: true });
