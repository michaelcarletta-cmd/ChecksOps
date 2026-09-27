/**
 * First-party e-sign adapter (replaces Lovable Resend connector).
 * Staff Cognito identity; SES/sink delivery; SHA-256 token hashes.
 * Does not call DocuSign/HelloSign/Lovable. Does not move money.
 */
import { createHash, randomBytes } from 'node:crypto';
import { withIdentityWrite } from './data.mjs';
import { sendViaSesOrSink } from './email.mjs';
import { resolveEmailBranding } from './email-branding.mjs';
import { escapeHtml, renderChecksOpsEmail } from './email-layout.mjs';

const TOKEN_EXPIRY_HOURS = 72;

export const hashToken = (raw) => createHash('sha256').update(String(raw), 'utf8').digest('hex');

export const generateRawToken = () => randomBytes(32).toString('hex');

export const signBaseUrl = () => String(
  process.env.SIGN_BASE_URL
  || process.env.APP_PUBLIC_URL
  || 'https://staging.checksops.com',
).replace(/\/$/, '');

export const replaceMergeFields = (text, signer, request, signUrl, branding = {}, { html = false } = {}) => {
  const claim = request.claims || {};
  const wrap = (value) => (html ? escapeHtml(value) : String(value ?? ''));
  return String(text || '')
    .replace(/\{signer\.name\}/g, wrap(signer.signer_name || ''))
    .replace(/\{signer\.email\}/g, wrap(signer.signer_email || ''))
    .replace(/\{document\.name\}/g, wrap(request.document_name || ''))
    .replace(/\{claim\.number\}/g, wrap(claim.claim_number || 'N/A'))
    .replace(/\{claim\.policyholder\}/g, wrap(claim.policyholder_name || 'N/A'))
    .replace(/\{claim\.policy_number\}/g, wrap(claim.policy_number || 'N/A'))
    .replace(/\{company\.name\}/g, wrap(branding.company_name || branding.companyName || 'ChecksOps'))
    .replace(/\{company\.email\}/g, wrap(branding.company_email || branding.replyTo || ''))
    .replace(/\{company\.phone\}/g, wrap(branding.company_phone || ''))
    .replace(/\{sign\.url\}/g, wrap(signUrl))
    .replace(/\{sign\.expiry_hours\}/g, wrap(String(TOKEN_EXPIRY_HOURS)));
};

export const emailHtml = (signer, request, signUrl, branding = {}) => {
  const rawBody = branding.esign_email_body
    || 'You have been requested to electronically sign a document. Please review the details below and click the button to proceed.';
  const processedBody = replaceMergeFields(rawBody, signer, request, signUrl, branding, { html: true }).replace(/\n/g, '<br>');
  const claim = request.claims || {};
  const layout = renderChecksOpsEmail({
    title: `Sign ${request.document_name || 'document'}`,
    greeting: signer.signer_name ? `Hello ${signer.signer_name},` : 'Hello,',
    bodyHtml: `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#334155;">${processedBody}</p>
      <p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#334155;"><strong>Document:</strong> ${escapeHtml(request.document_name || '')}<br>
      <strong>Claim #:</strong> ${escapeHtml(claim.claim_number || 'N/A')}</p>`,
    ctaLabel: 'Review & Sign Document',
    ctaUrl: signUrl,
    fallbackUrl: signUrl,
    expiresText: `This link expires in ${TOKEN_EXPIRY_HOURS} hours.`,
    companySubtitle: branding.companySubtitle || branding.company_name || branding.companyName,
    primaryColor: branding.esign_email_button_color || branding.primaryColor,
    logoUrl: branding.logoUrl,
  });
  return layout.html;
};

export const emailText = (signer, request, signUrl, branding = {}) => {
  const layout = renderChecksOpsEmail({
    title: `Sign ${request.document_name || 'document'}`,
    greeting: signer.signer_name ? `Hello ${signer.signer_name},` : 'Hello,',
    paragraphs: [`Sign ${request.document_name || 'document'}`],
    ctaLabel: 'Review & Sign Document',
    ctaUrl: signUrl,
    fallbackUrl: signUrl,
    expiresText: `This link expires in ${TOKEN_EXPIRY_HOURS} hours.`,
    companySubtitle: branding.companySubtitle || branding.company_name,
  });
  return layout.text;
};

const logEvent = async (client, row) => {
  await client.query(
    `INSERT INTO public.esign_event_logs (
       request_id, signer_id, claim_id, stage, status, message, payload
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::jsonb)`,
    [
      row.request_id,
      row.signer_id,
      row.claim_id,
      row.stage,
      row.status,
      row.message,
      JSON.stringify(row.payload || {}),
    ],
  ).catch(() => {});
};

const loadClaimsContext = async (client, request) => {
  if (request.claim_id) {
    const claim = (await client.query(
      `SELECT id, claim_number, policyholder_name, policyholder_email, policy_number, org_id AS tenant_id
       FROM public.claims WHERE id = $1::uuid LIMIT 1`,
      [request.claim_id],
    )).rows[0];
    return claim || {};
  }
  if (request.check_intake_item_id) {
    const intake = (await client.query(
      `SELECT id, check_number, detected_claim_number, payee_line, carrier_name, tenant_id
       FROM public.check_intake_items WHERE id = $1::uuid LIMIT 1`,
      [request.check_intake_item_id],
    )).rows[0];
    if (!intake) return {};
    return {
      claim_number: intake.detected_claim_number || `Check #${intake.check_number || ''}`,
      policyholder_name: intake.payee_line || '',
      policy_number: null,
      tenant_id: intake.tenant_id,
    };
  }
  return {};
};

export const runSendSignatureRequest = async ({
  client, mapping, body, spoof, send,
}) => {
  const requestId = body.requestId || body.request_id;
  const skipEmail = body.skipEmail === true;
  const senderOverride = body.senderOverride || body.sender_override || null;
  if (!requestId) {
    return { ok: false, statusCode: 400, error: 'requestId is required', spoofFieldsIgnored: spoof };
  }

  const request = (await client.query(
    `SELECT * FROM public.signature_requests WHERE id = $1::uuid LIMIT 1`,
    [requestId],
  )).rows[0];
  if (!request) {
    return { ok: false, statusCode: 404, error: 'Request not found', spoofFieldsIgnored: spoof };
  }

  const signers = (await client.query(
    `SELECT * FROM public.signature_signers WHERE signature_request_id = $1::uuid ORDER BY created_at`,
    [requestId],
  )).rows;

  request.claims = await loadClaimsContext(client, request);
  const brandingRow = (await client.query(
    `SELECT company_name, company_email, company_phone, esign_email_subject, esign_email_body,
            esign_email_header_color, esign_email_button_color, letterhead_url
     FROM public.company_branding LIMIT 1`,
  )).rows[0] || {};
  const branding = { ...brandingRow };

  let tenantId = request.claims.tenant_id || null;
  if (!tenantId && request.check_intake_item_id) {
    const ck = (await client.query(
      `SELECT tenant_id FROM public.check_intake_items WHERE id = $1::uuid LIMIT 1`,
      [request.check_intake_item_id],
    )).rows[0];
    tenantId = ck?.tenant_id || null;
  }
  const canWriteTenant = tenantId
    ? (await client.query(
      'SELECT public.aws_can_write_tenant($1::uuid) AS ok',
      [tenantId],
    )).rows[0]?.ok === true
    : (await client.query(
      `SELECT (
         public.has_role(auth.uid(), 'admin'::public.app_role)
         OR public.has_role(auth.uid(), 'staff'::public.app_role)
       ) AS ok`,
    )).rows[0]?.ok === true;
  const canAgentManage = (await client.query(
    'SELECT public.aws_mortgage_agent_can_manage_signature($1::uuid) AS ok',
    [requestId],
  )).rows[0]?.ok === true;
  if (!canWriteTenant && !canAgentManage) {
    return { ok: false, statusCode: 403, error: 'forbidden', spoofFieldsIgnored: spoof };
  }

  const resolved = await resolveEmailBranding(client, {
    tenantId,
    senderOverride,
  });
  branding.company_name = resolved.companyName;
  branding.companyName = resolved.companyName;
  branding.companySubtitle = resolved.companySubtitle;
  branding.company_email = resolved.replyTo;
  branding.replyTo = resolved.replyTo;
  branding.primaryColor = resolved.primaryColor;
  branding.logoUrl = resolved.logoUrl;
  branding.esign_email_header_color = resolved.primaryColor;
  branding.esign_email_button_color = resolved.primaryColor;
  const mailFrom = resolved.from;
  const mailReplyTo = resolved.replyTo;

  const claimId = request.claim_id || null;
  await logEvent(client, {
    request_id: requestId, signer_id: null, claim_id: claimId,
    stage: 'function_start', status: 'ok',
    message: skipEmail ? 'Manual bypass mode' : 'Function invoked',
    payload: { requestId, skipEmail, application_user_id: mapping.application_user_id },
  });

  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
  const appUrl = signBaseUrl();
  const signerLinks = [];
  for (const signer of signers) {
    const rawToken = generateRawToken();
    const tokenHash = hashToken(rawToken);
    await client.query(
      `UPDATE public.signature_signers
       SET access_token = $2, token_hash = $3, expires_at = $4::timestamptz
       WHERE id = $1::uuid`,
      [signer.id, rawToken, tokenHash, expiresAt],
    );
    signer._rawToken = rawToken;
    signer._signUrl = `${appUrl}/sign?token=${rawToken}`;
    signerLinks.push({
      signer_id: signer.id,
      signer_name: signer.signer_name,
      signer_email: signer.signer_email,
      sign_url: signer._signUrl,
    });
  }

  const fieldData = request.field_data || [];
  if (Array.isArray(fieldData) && fieldData.length > 0) {
    const existing = (await client.query(
      `SELECT id FROM public.signature_fields WHERE signature_request_id = $1::uuid LIMIT 1`,
      [requestId],
    )).rows[0];
    if (!existing) {
      for (const field of fieldData) {
        await client.query(
          `INSERT INTO public.signature_fields (
             id, signature_request_id, signer_index, field_type, label, page, x, y, width, height, required, placeholder, checkbox_label
           ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            field.id || null,
            requestId,
            field.signerIndex ?? 0,
            field.type,
            field.label || null,
            field.page ?? 1,
            field.x ?? 0,
            field.y ?? 0,
            field.width ?? 33,
            field.height ?? 6,
            field.required !== false,
            field.placeholder || null,
            field.checkboxLabel || null,
          ],
        ).catch(() => {});
      }
    }
  }

  if (skipEmail) {
    for (const signer of signers) {
      await client.query(
        `UPDATE public.signature_signers SET access_token = '' WHERE id = $1::uuid`,
        [signer.id],
      );
    }
    await client.query(
      `UPDATE public.signature_requests
       SET status = 'pending', delivery_mode = 'manual_bypass', provider_status = 'manual_bypass',
           last_attempted_at = now(), last_error = NULL
       WHERE id = $1::uuid`,
      [requestId],
    );
  if (claimId) {
    await client.query(
      `UPDATE public.claims SET latest_signature_request_id = $2::uuid, updated_at = now() WHERE id = $1::uuid`,
      [claimId, requestId],
    ).catch(() => {});
  }
  return {
    ok: true,
    statusCode: 200,
    mode: 'manual_bypass',
      signerLinks,
      provider: 'aws_ses_or_sink',
      spoofFieldsIgnored: spoof,
    };
  }

  const results = [];
  for (const signer of signers) {
    const signUrl = signer._signUrl;
    const html = emailHtml(signer, request, signUrl, branding);
    const rawSubject = branding.esign_email_subject || 'Action Required: Sign {document.name}';
    const subject = replaceMergeFields(rawSubject, signer, request, signUrl, branding);
    try {
      const mailer = send || sendViaSesOrSink;
      const sendResult = await mailer({
        to: signer.signer_email,
        subject,
        html,
        text: emailText(signer, request, signUrl, branding),
        from: mailFrom,
        replyTo: mailReplyTo,
      });
      const messageId = sendResult.results?.[0]?.messageId || null;
      const delivery = sendResult.results?.[0]?.delivery || sendResult.mode;
      await client.query(
        `UPDATE public.signature_signers
         SET access_token = '', delivery_status = 'sent', email_sent_at = now(),
             email_provider_message_id = $2
         WHERE id = $1::uuid`,
        [signer.id, messageId],
      );
      results.push({ signer_id: signer.id, success: true, delivery });
    } catch (emailErr) {
      const errMsg = String(emailErr?.message || emailErr).slice(0, 300);
      await client.query(
        `UPDATE public.signature_signers
         SET access_token = '', delivery_status = 'failed', delivery_error = $2
         WHERE id = $1::uuid`,
        [signer.id, errMsg],
      );
      results.push({ signer_id: signer.id, success: false, error: errMsg });
    }
  }

  const allFailed = results.length > 0 && results.every((row) => !row.success);
  const someFailed = results.some((row) => !row.success);
  const allSucceeded = results.length > 0 && results.every((row) => row.success);
  const providerStatus = allSucceeded ? 'emails_sent' : allFailed ? 'emails_failed' : 'emails_partially_failed';
  await client.query(
    `UPDATE public.signature_requests
     SET status = $2, delivery_mode = 'aws_ses_or_sink', sent_at = CASE WHEN $3 THEN NULL ELSE now() END,
         last_error = $4, last_attempted_at = now(), provider_status = $5
     WHERE id = $1::uuid`,
    [
      requestId,
      allFailed ? 'failed' : 'pending',
      allFailed,
      allFailed ? 'All emails failed' : someFailed ? 'Some emails failed' : null,
      providerStatus,
    ],
  );
  if (claimId) {
    await client.query(
      `UPDATE public.claims SET latest_signature_request_id = $2::uuid, updated_at = now() WHERE id = $1::uuid`,
      [claimId, requestId],
    ).catch(() => {});
  }

  return {
    ok: !allFailed,
    statusCode: allFailed ? 500 : 200,
    mode: 'aws_ses_or_sink',
    results,
    sent: results.filter((row) => row.success).length,
    failed: results.filter((row) => !row.success).length,
    total: results.length,
    provider: 'aws_ses_or_sink',
    lovableConnector: false,
    spoofFieldsIgnored: spoof,
  };
};

export const handleSendSignatureRequest = (event, deps = {}) => withIdentityWrite(event, (ctx) => (
  runSendSignatureRequest({ ...ctx, send: deps.sendViaSesOrSink })
), deps);
