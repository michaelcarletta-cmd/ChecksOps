/**
 * Webhook-safe handoff to process-funded-payment after funding completes.
 * Failures are logged and never undo the already-committed webhook apply.
 * Duplicate sends are prevented by the disbursement_batches funding_status lock.
 */
import { withMoovContext } from '../parity/moov-client.mjs';
import { processFundedPayment } from '../parity/moov-money.mjs';
import { loadProviderSecrets } from '../../provider-secrets.mjs';
import { membershipsOf } from '../parity/caller.mjs';

export async function invokeProcessFundedPaymentFromWebhook({
  client,
  tenantId,
  fundingRequestId,
  fetchImpl = fetch,
} = {}) {
  if (!tenantId || !fundingRequestId) return { invoked: false, reason: 'missing_ids' };

  const owner = (await client.query(
    `SELECT user_id, role
     FROM public.tenant_users
     WHERE tenant_id = $1::uuid AND role IN ('owner', 'admin')
     ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END
     LIMIT 1`,
    [tenantId],
  )).rows[0];
  if (!owner?.user_id) return { invoked: false, reason: 'no_tenant_owner' };

  const secrets = await loadProviderSecrets();
  if (!secrets.MOOV_PUBLIC_KEY || !secrets.MOOV_SECRET_KEY) {
    return { invoked: false, reason: 'production_credentials_unavailable' };
  }

  const memberships = await membershipsOf(client, owner.user_id);
  const ctx = {
    tenantId,
    isAdmin: true,
    environment: 'production',
    productionAuthorized: true,
    userId: owner.user_id,
    memberships,
    moovContext: {
      environment: 'production',
      productionPublicKey: secrets.MOOV_PUBLIC_KEY,
      productionSecretKey: secrets.MOOV_SECRET_KEY,
      allowedOrigin: secrets.MOOV_ALLOWED_ORIGIN || 'https://checksops.com',
    },
  };
  const mapping = { application_user_id: owner.user_id };
  try {
    const result = await withMoovContext({ ...ctx.moovContext, fetchImpl }, () => processFundedPayment.run({
      client,
      mapping,
      body: { funding_request_id: fundingRequestId },
      ctx,
      fetchImpl,
    }));
    return { invoked: true, result };
  } catch (error) {
    return { invoked: false, reason: String(error?.message || error).slice(0, 200) };
  }
}
