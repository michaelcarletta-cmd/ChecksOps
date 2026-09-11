/**
 * send-payment-direction-request via AWS SES/sink (Class A).
 * Does not copy the Lovable Resend/Telnyx Edge Function.
 * SMS is omitted. No provider money movement.
 */
import { withIdentityWrite } from './data.mjs';
import { deliverAuditedEmail, stableEmailIdempotencyKey, validatedMailReplyTo } from './email.mjs';
import { defaultFromAddress } from './email-policy.mjs';
import { renderTransactionalTemplate } from './email-templates.mjs';
import { resolveEmailBranding } from './email-branding.mjs';

const safeQuery = async (client, sql, params = []) => {
  try {
    return await client.query(sql, params);
  } catch {
    return { rows: [], rowCount: 0 };
  }
};

const canWriteTenant = async (client, tenantId) => {
  if (!tenantId) return false;
  return (await safeQuery(
    client,
    'SELECT public.aws_can_write_tenant($1::uuid) AS ok',
    [tenantId],
  )).rows[0]?.ok === true;
};

export const buildPaymentDirectionEmail = ({
  policyholderName,
  claimNumber,
  carrier,
  requestUrl,
  companyName = 'ChecksOps',
  subject,
  branding,
}) => {
  const rendered = renderTransactionalTemplate('payment-direction-request', {
    policyholderName: policyholderName || 'Policyholder',
    claimNumber: claimNumber || '',
    carrier: carrier || '',
    requestUrl,
    companyName,
    subject: subject || 'Payment direction needed for your insurance check',
    branding,
  });
  return rendered;
};

export const runSendPaymentDirectionRequest = async ({
  client, body, spoof, send,
}) => {
  const claimId = body.claimId || body.claim_id;
  const checkId = body.checkId || body.check_id;
  const requestUrl = body.requestUrl || body.request_url;
  if (!claimId || !checkId || !requestUrl) {
    return {
      ok: false,
      statusCode: 400,
      error: 'Missing required fields: claimId, checkId, requestUrl',
      spoofFieldsIgnored: spoof,
    };
  }

  const claim = (await safeQuery(
    client,
    `SELECT id, org_id AS tenant_id, policyholder_name, policyholder_email,
            policyholder_phone, claim_number, insurance_company
     FROM public.claims WHERE id = $1::uuid LIMIT 1`,
    [claimId],
  )).rows[0];
  if (!claim) {
    return { ok: false, statusCode: 404, error: 'Claim not found', spoofFieldsIgnored: spoof };
  }
  if (!await canWriteTenant(client, claim.tenant_id)) {
    return { ok: false, statusCode: 403, error: 'forbidden', spoofFieldsIgnored: spoof };
  }

  const branding = (await safeQuery(
    client,
    `SELECT company_name, company_email FROM public.company_branding LIMIT 1`,
  )).rows[0] || {};
  const resolved = await resolveEmailBranding(client, { tenantId: claim.tenant_id });
  const reply = validatedMailReplyTo(resolved.replyTo);
  if (!reply.ok) {
    return { ok: false, statusCode: 400, error: reply.error, spoofFieldsIgnored: spoof };
  }
  const companyName = resolved.companySubtitle || resolved.companyName || branding.company_name || 'ChecksOps';
  const mail = buildPaymentDirectionEmail({
    policyholderName: claim.policyholder_name,
    claimNumber: claim.claim_number,
    carrier: claim.insurance_company,
    requestUrl,
    companyName,
    subject: body.subject,
    branding: resolved,
  });

  if (!claim.policyholder_email) {
    return {
      ok: false,
      statusCode: 400,
      error: 'missing_policyholder_email',
      spoofFieldsIgnored: spoof,
    };
  }

  const suppliedKey = String(body.idempotencyKey || body.idempotency_key || '').trim();
  const delivery = await deliverAuditedEmail(client, {
    templateName: 'payment-direction-request',
    recipientEmail: claim.policyholder_email,
    tenantId: claim.tenant_id,
    idempotencyKey: suppliedKey || stableEmailIdempotencyKey('payment-direction', claimId, checkId),
    metadata: { claim_id: claimId, check_id: checkId },
    spoof,
    send,
    mailerArgs: {
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      from: resolved.from || defaultFromAddress(),
      replyTo: reply.replyTo,
    },
  });
  if (!delivery.ok) return { ...delivery, spoofFieldsIgnored: spoof };

  await safeQuery(
    client,
    `UPDATE public.check_payees
     SET payment_direction_status = 'requested', updated_at = now()
     WHERE check_id = $1::uuid`,
    [checkId],
  );

  return {
    ok: true,
    statusCode: 200,
    success: true,
    duplicate: delivery.duplicate === true,
    providerMessageId: delivery.providerMessageId || delivery.replay?.providerMessageId || null,
    results: {
      email: true,
      sms: false,
      provider: 'aws_ses_or_sink',
    },
    telnyxCalled: false,
    resendCalled: false,
    spoofFieldsIgnored: spoof,
  };
};

export const handleSendPaymentDirectionRequest = (event, deps = {}) => (
  withIdentityWrite(event, (ctx) => runSendPaymentDirectionRequest({
    ...ctx,
    send: deps.sendViaSesOrSink,
  }), deps)
);
