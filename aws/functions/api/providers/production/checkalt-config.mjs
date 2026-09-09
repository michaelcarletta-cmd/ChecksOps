import { CHECKALT_UAT_HOST, looksLikeSandboxHost } from '../../sandbox-credentials.mjs';
import { isApprovedCheckAltProductionUrl } from './checkalt-secrets.mjs';

const failConfig = (error, extra = {}) => ({
  ok: false,
  statusCode: extra.statusCode || 409,
  error,
  liveProviderCalled: false,
  productionExecution: false,
  message: extra.message || 'Production CheckAlt configuration is incomplete. Fail closed.',
  ...extra,
});

export const publicProductionCheckAltConfig = (cfg) => {
  if (!cfg) return null;
  return {
    merchantConfigured: Boolean(cfg.merchant),
    fiKeyConfigured: Boolean(cfg.fi_key),
    baseUrlHost: cfg.base_url ? (() => {
      try { return new URL(cfg.base_url).hostname; } catch { return 'invalid'; }
    })() : null,
    defaultEnabled: Boolean(cfg.default_enabled),
    depositorAccountConfigured: Boolean(cfg.depositor_account_id),
  };
};

export async function loadProductionCheckAltConfig(client, { credentials } = {}) {
  if (!credentials?.baseUrl || !credentials?.fiKey || !credentials?.username || !credentials?.password) {
    return failConfig('production_secret_missing', { reason: 'credentials_incomplete' });
  }

  let row;
  try {
    row = (await client.query('SELECT * FROM public.aws_checkalt_production_config()')).rows[0];
  } catch (error) {
    const msg = String(error?.message || '');
    if (error?.code === '42501' || /financial execution/i.test(msg) || /does not exist/i.test(msg)) {
      try {
        row = (await client.query(
          `SELECT merchant, fi_key, base_url, default_enabled, depositor_account_id, business_unit
           FROM public.checkalt_config
           WHERE singleton IS TRUE
           LIMIT 1`,
        )).rows[0];
      } catch {
        return failConfig('checkalt_config_unreadable', {
          statusCode: 503,
          message: 'checkalt_config could not be read. Apply SQL 65 before activation. Fail closed.',
        });
      }
    } else {
      return failConfig('checkalt_config_unreadable', { statusCode: 503 });
    }
  }

  if (!row) {
    return failConfig('checkalt_config_missing', {
      message: 'checkalt_config singleton is missing. Fail closed.',
    });
  }
  if (row.default_enabled === false) {
    return failConfig('checkalt_disabled', {
      message: 'CheckAlt integration is disabled in checkalt_config.',
    });
  }
  const merchant = String(row.merchant || '').trim();
  if (!merchant) {
    return failConfig('checkalt_merchant_missing', {
      message: 'checkalt_config.merchant is required and is not browser-selectable.',
    });
  }
  const configUrl = row.base_url ? String(row.base_url).replace(/\/$/, '') : null;
  if (configUrl && (configUrl === CHECKALT_UAT_HOST || looksLikeSandboxHost(configUrl))) {
    return failConfig('uat_config_refused', {
      message: 'checkalt_config.base_url points at UAT/sandbox. Production path refuses UAT fallback.',
    });
  }
  if (configUrl && !isApprovedCheckAltProductionUrl(configUrl) && configUrl !== credentials.baseUrl) {
    return failConfig('checkalt_config_host_refused', {
      message: 'checkalt_config.base_url is not an approved production FinCapture host.',
    });
  }

  return {
    ok: true,
    cfg: {
      merchant,
      fi_key: credentials.fiKey,
      base_url: credentials.baseUrl,
      default_enabled: true,
      depositor_account_id: row.depositor_account_id || null,
      business_unit: row.business_unit || null,
      cached_jwt: null,
      cached_jwt_expires_at: null,
    },
    credentials: {
      username: credentials.username,
      password: credentials.password,
      allowConfigJwt: false,
    },
    public: publicProductionCheckAltConfig({
      ...row,
      base_url: credentials.baseUrl,
      fi_key: credentials.fiKey,
    }),
  };
}

export async function loadProductionTenantAccount(client, tenantId) {
  if (!tenantId) return null;
  const row = (await client.query(
    `SELECT tenant_id, enabled, sso_user_id, deposit_account_number, last_register_payload,
            auto_approve_enabled, auto_approve_max_cents
     FROM public.checkalt_tenant_accounts
     WHERE tenant_id = $1::uuid
     LIMIT 1`,
    [tenantId],
  )).rows[0];
  if (!row) return null;
  const ssoFromPayload = row.last_register_payload?.sso_key || null;
  return {
    tenant_id: row.tenant_id,
    enabled: row.enabled !== false,
    sso_user_id: row.sso_user_id || null,
    deposit_account_number: row.deposit_account_number || null,
    sso_key: ssoFromPayload || row.sso_user_id || null,
    auto_approve_enabled: Boolean(row.auto_approve_enabled),
    source: 'checkalt_tenant_accounts',
  };
}
