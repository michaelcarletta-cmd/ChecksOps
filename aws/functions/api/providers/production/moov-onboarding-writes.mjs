import { TENANT_MEMBERSHIP_SQL } from '../../identity.mjs';
import { membershipForTenant } from '../../financial-ownership.mjs';
import { authorizeMoovProductionRead } from './moov-authz.mjs';
import { loadProductionTenantAccount } from './moov-config.mjs';
import { rejectBrowserTosForge, rejectUntrustedMoovAccountFields } from './moov-untrusted.mjs';
import {
  denyProductionOnboardingWrites,
  productionMoovOnboardingWritesAllowed,
} from './moov-holds.mjs';
import { mintRecipientInviteToken } from './moov-recipient-token.mjs';

const fail = (error, statusCode, extra = {}) => ({
  ok: false,
  statusCode,
  error,
  provider: 'moov',
  liveProviderCalled: false,
  productionExecution: false,
  productionOnboardingWrite: false,
  ...extra,
});

const membershipsOf = async (client, userId) => {
  const rows = (await client.query(TENANT_MEMBERSHIP_SQL, [userId])).rows;
  return rows.map((row) => ({
    tenant_id: row.tenant_id,
    role: row.role,
    tenant_name: row.tenant_name,
    tenant_slug: row.tenant_slug,
  }));
};

export async function authorizeOnboardingTenant({ client, mapping, body = {}, spoof } = {}) {
  const spoofed = rejectUntrustedMoovAccountFields(body, { spoofFieldsIgnored: spoof });
  if (spoofed) return spoofed;
  const memberships = await membershipsOf(client, mapping.application_user_id);
  const claimed = body.tenant_id || body.tenantId || null;
  if (claimed) {
    const membership = membershipForTenant(memberships, claimed);
    if (!membership) {
      return fail('cross_tenant_denied', 403, {
        message: 'Authenticated user is not a member of the requested tenant. Browser tenant_id is not authority.',
        spoofFieldsIgnored: spoof,
      });
    }
  } else if (memberships.length !== 1) {
    return fail('tenant_required', 400, { spoofFieldsIgnored: spoof });
  }
  const tenantId = claimed || memberships[0].tenant_id;
  const authz = await authorizeMoovProductionRead({
    client,
    mapping,
    memberships,
    tenantId,
  });
  if (!authz.ok) return { ...authz, spoofFieldsIgnored: spoof };
  return { ok: true, tenantId, memberships, spoofFieldsIgnored: spoof };
}

const darkBlock = (name, extra = {}) => (
  denyProductionOnboardingWrites(name, {
    intended: extra.intended || null,
    lovable_function: extra.lovable_function || name,
    user_vs_server: extra.user_vs_server || null,
    ...extra,
  })
);

export function intendedAccountCreate({ tenantId, accountType = 'business' } = {}) {
  return {
    method: 'POST',
    path: '/accounts',
    body: {
      accountType,
      capabilities: ['transfers', 'send-funds', 'wallet', 'send-funds.ach'],
      foreignID: tenantId,
      metadata: { checksops_tenant_id: tenantId },
    },
  };
}

export async function handleProductionOnboardingWrite(name, {
  client,
  mapping,
  body = {},
  spoof,
} = {}) {
  const auth = await authorizeOnboardingTenant({ client, mapping, body, spoof });
  if (!auth.ok) return auth;

  if (name === 'moov-tos-accept') {
    const forged = rejectBrowserTosForge(body);
    if (forged) return { ...forged, spoofFieldsIgnored: spoof };
  }

  const account = await loadProductionTenantAccount(client, auth.tenantId);
  const intended = (() => {
    if (name === 'moov-account-create') {
      return intendedAccountCreate({
        tenantId: auth.tenantId,
        accountType: body.account_type === 'individual' ? 'individual' : 'business',
      });
    }
    if (name === 'moov-account-onboard') {
      return {
        method: 'PATCH',
        path: account?.provider_account_id ? `/accounts/${account.provider_account_id}` : '/accounts/{server-derived}',
        includes: ['business_profile', 'controller', 'beneficial_owners', 'representatives'],
      };
    }
    if (name === 'moov-tos-token') {
      return {
        method: 'OAUTH',
        path: '/oauth2/token',
        drop: 'moov-terms-of-service',
        public_key_returned: false,
        user_vs_server: 'Moov.js Drop records ToS; server only mints a short-lived scoped token. ChecksOps never self-asserts acceptance.',
      };
    }
    if (name === 'moov-tos-accept') {
      return {
        method: 'POST',
        path: account?.provider_account_id ? `/accounts/${account.provider_account_id}/tos-acceptances` : '/accounts/{id}/tos-acceptances',
        requires_moov_js_token: true,
      };
    }
    if (name === 'moov-bank-link-token') {
      return {
        method: 'OAUTH',
        drop: 'bank-link',
        public_key_returned: false,
        user_vs_server: 'Moov.js Drop collects routing/account in the browser. Server never sees full account numbers from the Drop path.',
      };
    }
    if (name === 'moov-bank-account-add') {
      return {
        method: 'POST',
        path: account?.provider_account_id ? `/accounts/${account.provider_account_id}/bank-accounts` : '/accounts/{id}/bank-accounts',
        persists: 'last4 and metadata only',
      };
    }
    if (name === 'moov-micro-deposit-initiate') {
      return { method: 'POST', path: '/accounts/{id}/bank-accounts/{bankId}/micro-deposits' };
    }
    if (name === 'moov-micro-deposit-confirm') {
      return { method: 'PUT', path: '/accounts/{id}/bank-accounts/{bankId}/micro-deposits' };
    }
    if (name === 'moov-account-file-upload') {
      return { method: 'POST', path: '/accounts/{id}/files', stores: 'metadata only' };
    }
    if (name === 'moov-recipient-create') {
      const invite = mintRecipientInviteToken();
      return {
        method: 'POST',
        path: '/accounts',
        invite_token_plaintext_returned: false,
        invite_token_hash: invite.token_hash,
        entropy_bits: invite.entropy_bits,
        expires_at: invite.expires_at,
      };
    }
    if (name === 'moov-underwriting' && body.action === 'save') {
      return { method: 'PUT', path: '/accounts/{id}/underwriting' };
    }
    return { method: 'MUTATION', path: name };
  })();

  if (!productionMoovOnboardingWritesAllowed()) {
    return darkBlock(name, {
      intended,
      tenant_id: auth.tenantId,
      spoofFieldsIgnored: spoof,
      applicationUserId: mapping.application_user_id,
    });
  }

  return darkBlock(name, {
    error: 'production_onboarding_blocked',
    message: 'Onboarding write flag is on but M5 still refuses live Moov mutation in this phase. Flag must stay false until a later GO.',
    intended,
    tenant_id: auth.tenantId,
    spoofFieldsIgnored: spoof,
  });
}
