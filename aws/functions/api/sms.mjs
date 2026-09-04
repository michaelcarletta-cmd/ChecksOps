/**
 * AWS staging SMS service (Class A). Staging-safe sink by default.
 * Does not call Telnyx unless AWS_SMS_MODE=live AND allowlisted.
 */
import { randomUUID } from 'node:crypto';
import { withIdentity, parseBody, ignoredSpoof } from './data.mjs';
import {
  applySmsRecipientPolicy,
  normalizePhone,
  smsMode,
  smsSinkNumber,
} from './sms-policy.mjs';

export const handleSendSms = async (event) => withIdentity(event, async ({
  client, mapping, body, spoof,
}) => {
  const claimId = body.claimId || body.claim_id;
  const toNumber = body.toNumber || body.to_number || body.to;
  const messageBody = body.messageBody || body.message_body || body.message;
  if (!claimId || !toNumber || !messageBody) {
    return {
      ok: false,
      statusCode: 400,
      error: 'Missing required fields: claimId, toNumber, messageBody',
      spoofFieldsIgnored: spoof,
    };
  }

  // Tenant-scoped claim check under RLS
  const claim = (await client.query(
    `SELECT id FROM public.claims WHERE id = $1::uuid LIMIT 1`,
    [claimId],
  )).rows[0];
  if (!claim) {
    return { ok: false, statusCode: 404, error: 'claim_not_found', spoofFieldsIgnored: spoof };
  }

  const policy = applySmsRecipientPolicy(toNumber);
  const messageId = `sms-sink-${randomUUID()}`;
  const status = policy.delivery === 'live' ? 'sent' : 'sunk';

  // Best-effort audit row (schema variants tolerated)
  await client.query(
    `INSERT INTO public.sms_messages (
       id, claim_id, to_number, body, status, provider, provider_message_id,
       created_by, created_at, metadata
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5, 'aws_staging', $6, $7::uuid, now(), $8::jsonb
     )`,
    [
      randomUUID(),
      claimId,
      policy.originalTo || normalizePhone(toNumber),
      String(messageBody).slice(0, 1600),
      status,
      messageId,
      mapping.application_user_id,
      JSON.stringify({
        policy: policy.policy,
        delivery: policy.delivery,
        sink: smsSinkNumber(),
        rewrittenTo: policy.to,
        mode: smsMode(),
      }),
    ],
  ).catch(async () => {
    await client.query(
      `INSERT INTO public.email_send_log (
         id, template_name, recipient_email, status, provider, provider_message_id,
         metadata, created_at
       ) VALUES ($1::uuid, 'sms-send', $2, $3, 'aws_staging_sms', $4, $5::jsonb, now())`,
      [
        randomUUID(),
        policy.originalTo,
        status,
        messageId,
        JSON.stringify({ channel: 'sms', claimId, policy }),
      ],
    ).catch(() => {});
  });

  return {
    ok: true,
    statusCode: 200,
    success: true,
    messageId,
    stagingMode: smsMode(),
    delivery: policy.delivery,
    to: policy.delivery === 'live' ? policy.to : policy.originalTo,
    sunk: policy.delivery !== 'live',
    spoofFieldsIgnored: spoof,
  };
}, { write: true, commit: true });

export const handleTelnyxSmsStatus = async (event) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  // Staging: acknowledge webhook without mutating production Telnyx state.
  return {
    ok: true,
    statusCode: 200,
    received: true,
    staging: true,
    dryRun: true,
    eventType: body?.data?.event_type || null,
    spoofFieldsIgnored: spoof,
  };
};
